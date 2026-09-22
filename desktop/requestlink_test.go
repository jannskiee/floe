package main

// The Request link lane (requestlink.go) against a local fake /ws server that
// speaks the spec 04 5.5 shapes. Every test runs on a bare &App{}; no test
// touches desktop.json, the real server or a real notification. The host token
// is read back from the fake server in memory to compare, and never printed.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/jannskiee/floe/cli/engine/signaling"
)

// fakeConn is one socket the fake server accepted, with its own write lock.
type fakeConn struct {
	mu     sync.Mutex
	c      *websocket.Conn
	closed bool
}

func (fc *fakeConn) send(v any) {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	_ = fc.c.WriteJSON(v)
}

// fakeJoin is one token join the fake server saw. token stays in memory for
// comparisons only.
type fakeJoin struct {
	roomID, token string
}

// fakeSignalServer is the local /ws server of newFakeSignalServer.
type fakeSignalServer struct {
	t   *testing.T
	srv *httptest.Server

	mu        sync.Mutex
	role      string // role for a token join: "host", or "sender" like an old server
	refuse    string // when set, a token join is answered refused {code}
	silent    bool   // when set, a token join gets no answer
	rejectWS  bool   // when set, /ws upgrades fail (the server is down)
	features  bool   // /health lists request-1
	turnBody  string // /api/turn-credentials body; "" answers 500
	block     chan struct{}
	upgrades  int
	joins     []fakeJoin
	frames    []string // frame types from clients, in order
	conns     []*fakeConn
	closedCnt int
}

// newFakeSignalServer starts the fake: a healthy server with request-1 that
// seats every token join as host.
func newFakeSignalServer(t *testing.T) *fakeSignalServer {
	t.Helper()
	f := &fakeSignalServer{t: t, role: "host", features: true}
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		feat := f.features
		f.mu.Unlock()
		if feat {
			_, _ = w.Write([]byte(`{"status":"healthy","features":["request-1"]}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":"healthy"}`))
	})
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		block := f.block
		body := f.turnBody
		f.mu.Unlock()
		if block != nil {
			<-block
		}
		if r.URL.Path == "/api/turn-credentials" && body != "" {
			_, _ = w.Write([]byte(body))
			return
		}
		http.Error(w, "no", http.StatusInternalServerError)
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.upgrades++
		reject := f.rejectWS
		f.mu.Unlock()
		if reject {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		fc := &fakeConn{c: c}
		f.mu.Lock()
		f.conns = append(f.conns, fc)
		f.mu.Unlock()
		go f.read(fc)
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeSignalServer) url() string { return f.srv.URL }

func (f *fakeSignalServer) read(fc *fakeConn) {
	defer func() {
		f.mu.Lock()
		if !fc.closed {
			fc.closed = true
			f.closedCnt++
		}
		f.mu.Unlock()
	}()
	for {
		_, raw, err := fc.c.ReadMessage()
		if err != nil {
			return
		}
		var m map[string]any
		if json.Unmarshal(raw, &m) != nil {
			continue
		}
		typ, _ := m["type"].(string)
		f.mu.Lock()
		f.frames = append(f.frames, typ)
		role, refuse, silent := f.role, f.refuse, f.silent
		f.mu.Unlock()
		switch typ {
		case "ping":
			fc.send(map[string]string{"type": "pong"})
		case "join-room":
			tok, hasTok := m["hostToken"].(string)
			room, _ := m["roomId"].(string)
			if !hasTok {
				fc.send(map[string]string{"type": "room-joined", "role": "sender"})
				continue
			}
			f.mu.Lock()
			f.joins = append(f.joins, fakeJoin{roomID: room, token: tok})
			f.mu.Unlock()
			switch {
			case silent:
			case refuse != "":
				fc.send(map[string]string{"type": "refused", "code": refuse})
			default:
				fc.send(map[string]string{"type": "room-joined", "role": role})
			}
		}
	}
}

// set changes the fake's behavior under its lock.
func (f *fakeSignalServer) set(fn func(f *fakeSignalServer)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

// dropAll closes every open socket from the server side (a network loss or a
// restart; this fake keeps no reservations, so a re-join always re-creates).
func (f *fakeSignalServer) dropAll() {
	f.mu.Lock()
	conns := append([]*fakeConn(nil), f.conns...)
	f.conns = nil
	f.mu.Unlock()
	for _, fc := range conns {
		_ = fc.c.Close()
	}
}

// userConnected tells the newest socket a visitor arrived.
func (f *fakeSignalServer) userConnected() {
	f.mu.Lock()
	var fc *fakeConn
	if n := len(f.conns); n > 0 {
		fc = f.conns[n-1]
	}
	f.mu.Unlock()
	if fc != nil {
		fc.send(map[string]string{"type": "user-connected", "id": "visitor"})
	}
}

// pushRefused sends a seated host a refused frame (policy turned off).
func (f *fakeSignalServer) pushRefused(code string) {
	f.mu.Lock()
	var fc *fakeConn
	if n := len(f.conns); n > 0 {
		fc = f.conns[n-1]
	}
	f.mu.Unlock()
	if fc != nil {
		fc.send(map[string]string{"type": "refused", "code": code})
	}
}

func (f *fakeSignalServer) count(typ string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, x := range f.frames {
		if x == typ {
			n++
		}
	}
	return n
}

func (f *fakeSignalServer) tokenJoins() []fakeJoin {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakeJoin(nil), f.joins...)
}

// snapRecorder keeps every snapshot the lane emitted.
type snapRecorder struct {
	mu    sync.Mutex
	snaps []RequestLinkSnapshot
	raw   []string
}

func (r *snapRecorder) emit(event string, data any) {
	if event != "request:state" {
		return
	}
	s := data.(RequestLinkSnapshot)
	b, _ := json.Marshal(s)
	r.mu.Lock()
	r.snaps = append(r.snaps, s)
	r.raw = append(r.raw, string(b))
	r.mu.Unlock()
}

func (r *snapRecorder) all() []RequestLinkSnapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]RequestLinkSnapshot(nil), r.snaps...)
}

func (r *snapRecorder) len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.snaps)
}

// waitFor polls cond for up to d.
func waitFor(t *testing.T, d time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out after %v waiting for %s", d, what)
}

// laneApp is a bare App wired to the fake server with the switch on, and a
// recorder for every emitted snapshot. Cleanup closes the link and waits for
// the lane goroutine, so no test leaks one into the next.
func laneApp(t *testing.T, f *fakeSignalServer) (*App, *snapRecorder) {
	t.Helper()
	a := &App{notifyFn: func(string, string) {}, wake: &wakeGuard{onBlock: func() {}, onAllow: func() {}}}
	if f != nil {
		a.cfg = appConfig{Server: f.url(), RequestLinks: true}
	} else {
		a.cfg = appConfig{Server: "http://127.0.0.1:9", RequestLinks: true}
	}
	rec := &snapRecorder{}
	l := a.lane()
	l.emitFn = rec.emit
	l.closeWait = 200 * time.Millisecond
	t.Cleanup(func() {
		a.CloseRequestLink()
		done := make(chan struct{})
		go func() { l.wg.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			t.Error("the lane goroutine did not end")
		}
	})
	return a, rec
}

// stateOf reads the lane's state.
func stateOf(a *App) RequestLinkSnapshot { return a.GetRequestLink() }

func waitState(t *testing.T, a *App, d time.Duration, state string) RequestLinkSnapshot {
	t.Helper()
	waitFor(t, d, "state "+state, func() bool { return stateOf(a).State == state })
	return stateOf(a)
}

// makeWaiting makes a link against f and waits until it is waiting.
func makeWaiting(t *testing.T, a *App) RequestLinkSnapshot {
	t.Helper()
	a.MakeRequestLink("Acme footage", t.TempDir(), "24h")
	return waitState(t, a, 10*time.Second, "waiting")
}

// setJoin swaps joinWithTokenFn for the test.
func setJoin(t *testing.T, fn func(*signaling.Client, string, string) (signaling.HostJoinResult, error)) {
	t.Helper()
	old := joinWithTokenFn
	joinWithTokenFn = fn
	t.Cleanup(func() { joinWithTokenFn = old })
}

// laneHandles reads what the lane owns.
func laneHandles(a *App) (gen uint64, link string, sc *signaling.Client) {
	l := a.lane()
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.gen, l.link, l.sc
}

// slotState reads the transfer slot.
type slotState struct {
	gen             uint64
	busy, cancelled bool
	sc, conn        closer
}

func slotOf(a *App) slotState {
	a.mu.Lock()
	defer a.mu.Unlock()
	return slotState{a.gen, a.busy, a.cancelled, a.curSC, a.curConn}
}

func TestRequestLaneSurvivesStartSend(t *testing.T) {
	f := newFakeSignalServer(t)
	block := make(chan struct{})
	a, _ := laneApp(t, f)
	makeWaiting(t, a)
	gen, link, sc := laneHandles(a)

	f.set(func(f *fakeSignalServer) { f.block = block })
	file := filepath.Join(t.TempDir(), "a.txt")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := a.StartSend([]string{file}, false); err != nil {
		t.Fatal(err)
	}
	if slotOf(a).gen != 1 || !slotOf(a).busy {
		t.Fatalf("StartSend did not claim the transfer slot: %+v", slotOf(a))
	}
	g2, l2, sc2 := laneHandles(a)
	if g2 != gen || l2 != link || sc2 != sc || stateOf(a).State != "waiting" {
		t.Fatalf("StartSend moved the lane: gen %d->%d, link same %v, sc same %v, state %s", gen, g2, l2 == link, sc2 == sc, stateOf(a).State)
	}
	a.CancelTransfer()
	f.set(func(f *fakeSignalServer) { f.block = nil })
	close(block)
	waitFor(t, 10*time.Second, "the send to end", func() bool { return !slotOf(a).busy })
	if stateOf(a).State != "waiting" || f.count("request-close") != 0 {
		t.Fatalf("the cancelled send touched the link: %+v", stateOf(a))
	}
}

func TestRequestLaneSurvivesCancelTransfer(t *testing.T) {
	f := newFakeSignalServer(t)
	a, _ := laneApp(t, f)
	makeWaiting(t, a)
	gen, link, sc := laneHandles(a)
	g := a.beginTransfer()
	a.CancelTransfer()
	a.clearTransfer(g)
	g2, l2, sc2 := laneHandles(a)
	if g2 != gen || l2 != link || sc2 != sc {
		t.Fatal("CancelTransfer reached the request lane")
	}
	time.Sleep(50 * time.Millisecond)
	if st := stateOf(a).State; st != "waiting" {
		t.Fatalf("state after CancelTransfer = %s, want waiting", st)
	}
	f.mu.Lock()
	closed := f.closedCnt
	f.mu.Unlock()
	if closed != 0 {
		t.Fatalf("CancelTransfer closed %d request sockets", closed)
	}
}

func TestRequestLaneSurvivesCodeReceive(t *testing.T) {
	f := newFakeSignalServer(t)
	block := make(chan struct{})
	a, _ := laneApp(t, f)
	makeWaiting(t, a)
	gen, link, sc := laneHandles(a)

	f.set(func(f *fakeSignalServer) { f.block = block })
	done := make(chan struct{})
	go func() {
		_, _ = a.ReceiveByCode("olive-tiger-castle", t.TempDir(), false, false)
		close(done)
	}()
	waitFor(t, 5*time.Second, "the receive to claim the slot", func() bool { return slotOf(a).gen == 1 })
	g2, l2, sc2 := laneHandles(a)
	if g2 != gen || l2 != link || sc2 != sc || stateOf(a).State != "waiting" {
		t.Fatal("a code Receive moved the request lane")
	}
	a.CancelTransfer()
	f.set(func(f *fakeSignalServer) { f.block = nil })
	close(block)
	<-done
	if stateOf(a).State != "waiting" {
		t.Fatalf("state after the receive = %s", stateOf(a).State)
	}
}

func TestRequestLaneLeavesTransferSlotAlone(t *testing.T) {
	f := newFakeSignalServer(t)
	a, _ := laneApp(t, f)
	g := a.beginTransfer()
	sc, conn := &fakeCloser{}, &fakeCloser{}
	a.setSignaling(g, sc)
	a.setConn(g, conn)
	before := slotOf(a)

	snap := makeWaiting(t, a)
	a.GetRequestLink()
	a.AnswerRequest(snap.PromptGen, "accept")
	a.AnswerRequest(99, "keep-waiting")
	a.RetryRequestLink()
	a.CancelRequestDrop()
	a.CloseRequestLink()
	a.MakeRequestLink("again", t.TempDir(), "7d")
	waitState(t, a, 10*time.Second, "waiting")
	a.CloseRequestLink()

	if after := slotOf(a); after != before {
		t.Fatalf("lane methods changed the transfer slot: %+v -> %+v", before, after)
	}
	if sc.closed != 0 || conn.closed != 0 {
		t.Fatal("lane methods closed the transfer's handles")
	}
}

func TestMakeRequestLinkRefusesWhenSwitchOff(t *testing.T) {
	f := newFakeSignalServer(t)
	a, _ := laneApp(t, f)
	a.cfg.RequestLinks = false
	s := a.MakeRequestLink("x", "", "24h")
	if s.State != "error" || s.Code != "off" || s.Link != "" {
		t.Fatalf("switch off: %+v, want error off", s)
	}
	time.Sleep(50 * time.Millisecond)
	if f.count("join-room") != 0 {
		t.Fatal("a join was sent with the switch off")
	}
}

func TestMakeRequestLinkRefusesWithoutRequest1(t *testing.T) {
	f := newFakeSignalServer(t)
	f.set(func(f *fakeSignalServer) { f.features = false })
	a, _ := laneApp(t, f)
	a.MakeRequestLink("x", "", "24h")
	s := waitState(t, a, 10*time.Second, "error")
	if s.Code != "disabled" {
		t.Fatalf("no request-1: code %q, want disabled", s.Code)
	}
	if f.count("join-room") != 0 {
		t.Fatal("a join was sent to a server without request-1")
	}
}

func TestMakeRequestLinkAbortsOnNonHostRole(t *testing.T) {
	f := newFakeSignalServer(t)
	f.set(func(f *fakeSignalServer) { f.role = "sender" }) // today's server seats by join order
	a, _ := laneApp(t, f)
	a.MakeRequestLink("x", "", "24h")
	s := waitState(t, a, 10*time.Second, "error")
	if s.Code != "unknown" || s.Link != "" {
		t.Fatalf("non-host role: %+v, want error unknown with no link", s)
	}
	waitFor(t, 5*time.Second, "the socket to close", func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.closedCnt == 1
	})
	if _, _, sc := laneHandles(a); sc != nil {
		t.Fatal("the lane kept the old server's socket")
	}
}

func TestMakeRequestLinkJoinTimeoutMapsToUnknown(t *testing.T) {
	f := newFakeSignalServer(t)
	setJoin(t, func(*signaling.Client, string, string) (signaling.HostJoinResult, error) {
		return signaling.HostTimeout, nil
	})
	a, _ := laneApp(t, f)
	start := time.Now()
	a.MakeRequestLink("x", "", "24h")
	s := waitState(t, a, 5*time.Second, "error")
	if s.Code != "unknown" {
		t.Fatalf("timeout: code %q, want unknown", s.Code)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("the lane waited on a timer of its own")
	}
}

func TestMakeRequestLinkRefusesSecondLink(t *testing.T) {
	f := newFakeSignalServer(t)
	a, _ := laneApp(t, f)
	first := makeWaiting(t, a)
	s := a.MakeRequestLink("second", "", "24h")
	if s.State != "error" || s.Code != "already-open" || s.Link != "" || s.Gen != 0 {
		t.Fatalf("second link: %+v, want error already-open at gen 0", s)
	}
	now := stateOf(a)
	if now.State != "waiting" || now.Link != first.Link || now.Gen != first.Gen {
		t.Fatalf("the refusal disturbed the open link: %+v", now)
	}
	if n := len(f.tokenJoins()); n != 1 {
		t.Fatalf("%d token joins, want 1", n)
	}
}

func TestMakeRequestLinkRefusesUnusableWebBase(t *testing.T) {
	cases := []struct {
		server, web string
		ok          bool
	}{
		{"https://api.floe.one", "https://floe.one", true},
		{"http://localhost:3001", "http://localhost:3000", true},
		{"http://localhost:8080", "http://localhost:8080", true},
		{"http://127.0.0.1:3001", "http://127.0.0.1:3001", true},
		{"https://api.example.com", "https://files.example.com", true},
		{"https://example.com", "https://example.com/floe", true},
		{"https://files.example.com", "https://files.example.com", false},
		{"https://192.168.1.50:3001", "https://192.168.1.50:3001", false},
	}
	for _, c := range cases {
		if got := webBaseUsable(c.server, c.web); got != c.ok {
			t.Errorf("webBaseUsable(%q, %q) = %v, want %v", c.server, c.web, got, c.ok)
		}
	}

	// Through Make link: a one-origin self-host without a Share link address.
	a, _ := laneApp(t, nil)
	a.cfg.Server = "https://files.example.com"
	a.lane().supportFn = func(string) FeatureResult { return FeatureResult{Reachable: true, RequestLinks: true} }
	a.MakeRequestLink("x", "", "24h")
	if s := waitState(t, a, 5*time.Second, "error"); s.Code != "web-address" {
		t.Fatalf("code %q, want web-address", s.Code)
	}
}

func TestMakeRequestLinkHideIPWithoutRelay(t *testing.T) {
	for _, c := range []struct{ name, body, want string }{
		{"stun only", `[{"urls":"stun:stun.example.com:3478"}]`, "no-relay"},
		{"unreadable", "", "relay-unknown"},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeSignalServer(t)
			f.set(func(f *fakeSignalServer) { f.turnBody = c.body })
			a, _ := laneApp(t, f)
			a.cfg.HideIP = true
			a.MakeRequestLink("x", "", "24h")
			if s := waitState(t, a, 10*time.Second, "error"); s.Code != c.want {
				t.Fatalf("code %q, want %q", s.Code, c.want)
			}
			if f.count("join-room") != 0 {
				t.Fatal("a join was sent without a relay")
			}
		})
	}
}

func TestRequestJoinRefusalCodesMapToSnapshot(t *testing.T) {
	// Through the fake server.
	for _, c := range []struct{ refuse, want string }{
		{"disabled", "disabled"},
		{"limited", "limited"},
		{"denied", "unknown"}, // no such key in Stage 1 (E-25)
		{"something-new", "unknown"},
	} {
		t.Run("server "+c.refuse, func(t *testing.T) {
			f := newFakeSignalServer(t)
			f.set(func(f *fakeSignalServer) { f.refuse = c.refuse })
			a, _ := laneApp(t, f)
			a.MakeRequestLink("x", "", "24h")
			if s := waitState(t, a, 10*time.Second, "error"); s.Code != c.want {
				t.Fatalf("refused %q: code %q, want %q", c.refuse, s.Code, c.want)
			}
		})
	}
	// Through joinWithTokenFn, for the results the fake does not produce.
	for _, res := range []signaling.HostJoinResult{
		signaling.HostRoomFull, signaling.HostInvalidToken, signaling.HostInvalidRoom,
		signaling.HostDown, signaling.HostRefusedUnknown, signaling.HostOldServer,
	} {
		t.Run("result "+res.String(), func(t *testing.T) {
			f := newFakeSignalServer(t)
			setJoin(t, func(*signaling.Client, string, string) (signaling.HostJoinResult, error) { return res, nil })
			a, _ := laneApp(t, f)
			a.MakeRequestLink("x", "", "24h")
			if s := waitState(t, a, 10*time.Second, "error"); s.Code != "unknown" {
				t.Fatalf("%s: code %q, want unknown", res, s.Code)
			}
		})
	}
}

func TestMakeRequestLinkUsesEngineHelpers(t *testing.T) {
	f := newFakeSignalServer(t)
	a, _ := laneApp(t, f)
	s := makeWaiting(t, a)
	joins := f.tokenJoins()
	if len(joins) != 1 {
		t.Fatalf("%d token joins, want 1", len(joins))
	}
	j := joins[0]
	if !signaling.HostTokenRegexp.MatchString(j.token) {
		t.Error("the join's token does not have the engine's token shape")
	}
	if j.roomID != signaling.RoomIDFromToken(j.token) {
		t.Error("the join's roomId is not RoomIDFromToken of its token")
	}
	m := regexp.MustCompile(`/r/([A-Za-z0-9_-]+)#(.+)$`).FindStringSubmatch(s.Link)
	if m == nil || len(m[1]) != 11 {
		t.Fatal("the link does not carry an 11-character link id")
	}
	if m[2] != j.roomID {
		t.Error("the link's fragment is not the joined room")
	}
}

func TestReconnectRetriesUntilLinkEnd(t *testing.T) {
	f := newFakeSignalServer(t)
	a, _ := laneApp(t, f)
	l := a.lane()
	l.lifetimeFn = func(string) (time.Duration, bool) { return 1500 * time.Millisecond, true }
	l.backoffBase, l.backoffCap = 20*time.Millisecond, 80*time.Millisecond
	s := makeWaiting(t, a)

	f.set(func(f *fakeSignalServer) { f.rejectWS = true })
	f.dropAll()
	r := waitState(t, a, 5*time.Second, "reconnecting")
	if r.ReconnectUntil != s.ExpiresAt || r.Link != s.Link {
		t.Fatalf("reconnecting: until %d want %d (the link's end), link kept %v", r.ReconnectUntil, s.ExpiresAt, r.Link == s.Link)
	}
	e := waitState(t, a, 5*time.Second, "ended")
	if e.Code != "expired" {
		t.Fatalf("end code %q, want expired", e.Code)
	}
	if now := time.Now().UnixMilli(); now < s.ExpiresAt {
		t.Fatalf("ended %d ms before the link's end time", s.ExpiresAt-now)
	}
	f.mu.Lock()
	attempts := f.upgrades
	f.mu.Unlock()
	if attempts < 4 {
		t.Fatalf("%d connection attempts, want retries until the end time", attempts)
	}
}

func TestReconnectBackoffNeverBelowFloor(t *testing.T) {
	lo := func(int64) int64 { return 0 }
	hi := func(n int64) int64 { return n - 1 }
	for n := 0; n < 12; n++ {
		if d := reconnectDelay(n, requestBackoffBase, requestBackoffCap, lo); d < time.Second {
			t.Errorf("attempt %d: %v below the 1 s floor", n, d)
		}
		if d := reconnectDelay(n, requestBackoffBase, requestBackoffCap, hi); d > 30*time.Second {
			t.Errorf("attempt %d: %v above the 30 s cap", n, d)
		}
	}
	if d := reconnectDelay(10, requestBackoffBase, requestBackoffCap, hi); d != 30*time.Second {
		t.Errorf("late attempt top = %v, want the 30 s cap", d)
	}
}

func TestReconnectAfterServerRestartRecreates(t *testing.T) {
	f := newFakeSignalServer(t)
	a, _ := laneApp(t, f)
	l := a.lane()
	l.backoffBase, l.backoffCap = 20*time.Millisecond, 80*time.Millisecond
	s := makeWaiting(t, a)
	f.dropAll() // a restart: the fake keeps no reservation, so the re-join re-creates
	waitFor(t, 5*time.Second, "a second token join", func() bool { return len(f.tokenJoins()) == 2 })
	w := waitState(t, a, 5*time.Second, "waiting")
	if w.Link != s.Link || w.Gen != s.Gen {
		t.Fatal("the re-created link is not the same link")
	}
	j := f.tokenJoins()
	if j[0].roomID != j[1].roomID || j[0].token != j[1].token {
		t.Fatal("the re-join did not use the same room and token")
	}
}

func TestDisabledRefusalStopsReconnect(t *testing.T) {
	f := newFakeSignalServer(t)
	a, _ := laneApp(t, f)
	l := a.lane()
	l.backoffBase, l.backoffCap = 20*time.Millisecond, 80*time.Millisecond
	makeWaiting(t, a)
	f.set(func(f *fakeSignalServer) { f.refuse = "disabled" })
	f.dropAll()
	if s := waitState(t, a, 5*time.Second, "error"); s.Code != "disabled" {
		t.Fatalf("code %q, want disabled", s.Code)
	}
	n := len(f.tokenJoins())
	time.Sleep(300 * time.Millisecond)
	if len(f.tokenJoins()) != n {
		t.Fatal("the lane kept retrying after disabled")
	}

	// A seated host told disabled (the policy flipped off) stops too (T24).
	f2 := newFakeSignalServer(t)
	b, _ := laneApp(t, f2)
	makeWaiting(t, b)
	f2.pushRefused("disabled")
	if s := waitState(t, b, 5*time.Second, "error"); s.Code != "disabled" {
		t.Fatalf("pushed refusal: code %q, want disabled", s.Code)
	}
}

func TestRetryRequestLinkRunsAttemptNow(t *testing.T) {
	f := newFakeSignalServer(t)
	a, _ := laneApp(t, f)
	l := a.lane()
	l.backoffBase, l.backoffCap = 20*time.Second, 30*time.Second
	makeWaiting(t, a)
	f.dropAll()
	waitState(t, a, 5*time.Second, "reconnecting")
	time.Sleep(50 * time.Millisecond)
	if len(f.tokenJoins()) != 1 {
		t.Fatal("an attempt ran before the backoff")
	}
	a.RetryRequestLink()
	waitState(t, a, 3*time.Second, "waiting")
	if len(f.tokenJoins()) != 2 {
		t.Fatal("Retry now did not run the next attempt")
	}
}

// forceState puts the lane into a state S1-DSK-03b's pairing would reach.
func forceState(a *App, state string, promptGen uint64) {
	l := a.lane()
	l.mu.Lock()
	l.setStateLocked(state, "")
	l.promptGen = promptGen
	l.mu.Unlock()
}

func TestAnswerRequestIgnoresStalePromptGen(t *testing.T) {
	a, _ := laneApp(t, nil)
	forceState(a, "deciding", 2)
	a.AnswerRequest(1, "accept")
	a.AnswerRequest(0, "accept")
	select {
	case ans := <-a.lane().decision:
		t.Fatalf("a stale prompt answered: %+v", ans)
	default:
	}
	a.AnswerRequest(2, "decline")
	select {
	case ans := <-a.lane().decision:
		if ans.promptGen != 2 || ans.answer != "decline" {
			t.Fatalf("decision = %+v", ans)
		}
	default:
		t.Fatal("the current prompt's answer did not reach Decide")
	}
	a.AnswerRequest(2, "keep-waiting") // not valid while deciding
	if stateOf(a).State != "deciding" {
		t.Fatal("keep-waiting changed a deciding lane")
	}
	forceState(a, "off", 0)
}

func TestKeepWaitingSendsReopen(t *testing.T) {
	f := newFakeSignalServer(t)
	a, _ := laneApp(t, f)
	s := makeWaiting(t, a)
	forceState(a, "declined", 5)
	out := a.AnswerRequest(5, "keep-waiting")
	if out.State != "waiting" || out.Link != s.Link {
		t.Fatalf("keep-waiting: %+v", out)
	}
	waitFor(t, 5*time.Second, "request-reopen", func() bool { return f.count("request-reopen") == 1 })

	forceState(a, "declined", 6)
	a.AnswerRequest(6, "close")
	if st := stateOf(a); st.State != "ended" || st.Code != "closed" {
		t.Fatalf("close from declined: %+v", st)
	}
}

func TestCloseRequestLinkSendsCloseAndEnds(t *testing.T) {
	f := newFakeSignalServer(t)
	a, rec := laneApp(t, f)
	s := makeWaiting(t, a)
	a.CloseRequestLink()
	e := stateOf(a)
	if e.State != "ended" || e.Code != "closed" || e.Link != "" || e.Gen <= s.Gen {
		t.Fatalf("after Close: %+v", e)
	}
	waitFor(t, 5*time.Second, "request-close", func() bool { return f.count("request-close") == 1 })
	waitFor(t, 5*time.Second, "the socket to close", func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.closedCnt == 1
	})
	last := rec.all()[rec.len()-1]
	if last.State != "ended" || last.Code != "closed" {
		t.Fatalf("last emitted snapshot %+v", last)
	}
	if _, _, sc := laneHandles(a); sc != nil {
		t.Fatal("the lane kept the socket after Close")
	}
}

func TestStaleLaneGenerationEmitsNothing(t *testing.T) {
	f := newFakeSignalServer(t)
	a, rec := laneApp(t, f)
	s := makeWaiting(t, a)
	a.CloseRequestLink()
	n := rec.len()
	a.emitState(s.Gen)
	if a.reqUpdate(s.Gen, func(l *requestLane) { l.setStateLocked("waiting", "") }) {
		t.Fatal("a stale generation changed the lane")
	}
	if a.requestActive(s.Gen) {
		t.Fatal("the closed generation is still active")
	}
	if rec.len() != n {
		t.Fatalf("a stale generation emitted %d snapshots", rec.len()-n)
	}
	if st := stateOf(a).State; st != "ended" {
		t.Fatalf("state %s, want ended", st)
	}
}

func TestRequestSnapshotNeverCarriesToken(t *testing.T) {
	f := newFakeSignalServer(t)
	a, rec := laneApp(t, f)
	l := a.lane()
	l.backoffBase, l.backoffCap = 20*time.Millisecond, 80*time.Millisecond
	s := makeWaiting(t, a)
	f.dropAll()
	waitFor(t, 5*time.Second, "the re-join", func() bool { return len(f.tokenJoins()) == 2 })
	waitState(t, a, 5*time.Second, "waiting")
	a.CloseRequestLink()

	token := f.tokenJoins()[0].token
	returned, _ := json.Marshal(s)
	got, _ := json.Marshal(a.GetRequestLink())
	all := append([]string{string(returned), string(got)}, rec.raw...)
	if len(all) < 5 {
		t.Fatalf("only %d snapshots recorded", len(all))
	}
	for _, js := range all {
		for i := 0; i+8 <= len(token); i++ {
			if strings.Contains(js, token[i:i+8]) {
				t.Fatal("a snapshot carries part of the host token")
			}
		}
		if strings.Contains(js, `"token"`) || strings.Contains(js, `"hostToken"`) {
			t.Fatal("a snapshot has a token-named field")
		}
	}
}

func TestLinkShapeAndDerivedRoomID(t *testing.T) {
	tok, err := signaling.NewHostToken()
	if err != nil {
		t.Fatal(err)
	}
	room := signaling.RoomIDFromToken(tok)
	id, err := signaling.NewLinkID()
	if err != nil {
		t.Fatal(err)
	}
	uuidRe := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	if !uuidRe.MatchString(room) {
		t.Fatal("the derived room id is not a lowercase v4-shaped UUID")
	}
	for _, web := range []string{"https://floe.one", "http://localhost:3000", "https://files.example.com/floe"} {
		got := requestLinkFor(web, id, room)
		want := web + "/r/" + id + "#" + room
		if got != want {
			t.Errorf("requestLinkFor(%q) = %q, want %q", web, got, want)
		}
		if strings.Contains(got, tok[:8]) {
			t.Error("the link carries the token")
		}
	}
}

func TestSanitizeRequestLabel(t *testing.T) {
	long := strings.Repeat("a", 200)
	cases := []string{
		`a<b>c:d"e/f\g|h?i*j`, "tab\there", "bell\x07x", "photo‮gnp", "a⁦b",
		"CON", "com1", "LPT9", "nul", "name...  ", "  ", "", ".", "..", long, "Acme footage",
	}
	for _, in := range cases {
		got := sanitizeRequestLabel(in)
		if got == "" {
			t.Errorf("%q: empty folder name", in)
		}
		if strings.ContainsAny(got, "<>:\"/\\|?*") {
			t.Errorf("%q -> %q keeps a reserved character", in, got)
		}
		for _, r := range got {
			if r < 0x20 || r == 0x7f || (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069) {
				t.Errorf("%q -> %q keeps a control or bidi character", in, got)
			}
		}
		if strings.HasSuffix(got, ".") || strings.HasSuffix(got, " ") {
			t.Errorf("%q -> %q ends in a dot or space", in, got)
		}
		if isDeviceName(got) {
			t.Errorf("%q -> %q is a device name", in, got)
		}
		if n := len([]rune(got)); n > requestLabelMax {
			t.Errorf("%q -> %d runes, want at most %d", in, n, requestLabelMax)
		}
	}
	for in, want := range map[string]string{"": "Request", "  ": "Request", "..": "Request", "Acme footage": "Acme footage", long: strings.Repeat("a", 64)} {
		if got := sanitizeRequestLabel(in); got != want {
			t.Errorf("sanitizeRequestLabel(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestGetRequestLinkDoesNotWaitOnAppMutex(t *testing.T) {
	a := &App{}
	a.mu.Lock()
	defer a.mu.Unlock()
	done := make(chan RequestLinkSnapshot, 1)
	go func() { done <- a.GetRequestLink() }()
	select {
	case s := <-done:
		if s.State != "off" {
			t.Fatalf("fresh lane state %q, want off", s.State)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("GetRequestLink waited on a.mu")
	}
}

// TestRequestSnapshotSeqOrdersEverySnapshot (D-115): every snapshot the lane
// emits or returns carries a seq from one counter, so (gen, seq) orders them
// all, emitted ones in emit order, and a reply can never tie an event.
func TestRequestSnapshotSeqOrdersEverySnapshot(t *testing.T) {
	f := newFakeSignalServer(t)
	a, rec := laneApp(t, f)
	made := a.MakeRequestLink("x", t.TempDir(), "24h")
	waitState(t, a, 10*time.Second, "waiting")
	refused := a.MakeRequestLink("y", "", "24h")
	got := a.GetRequestLink()
	a.CloseRequestLink()
	after := a.GetRequestLink()

	seen := map[uint64]bool{}
	var prevGen, prevSeq uint64
	for i, s := range rec.all() {
		if s.Seq == 0 {
			t.Fatalf("emitted snapshot %d has no seq", i)
		}
		if s.Gen < prevGen || (s.Gen == prevGen && s.Seq <= prevSeq) {
			t.Fatalf("emitted snapshot %d (gen %d, seq %d) is not after (gen %d, seq %d)", i, s.Gen, s.Seq, prevGen, prevSeq)
		}
		prevGen, prevSeq = s.Gen, s.Seq
		seen[s.Seq] = true
	}
	for name, s := range map[string]RequestLinkSnapshot{"make": made, "refusal": refused, "get": got, "after": after} {
		if s.Seq == 0 {
			t.Errorf("%s returned no seq", name)
		}
		if seen[s.Seq] {
			t.Errorf("%s reused seq %d of an emitted snapshot", name, s.Seq)
		}
		seen[s.Seq] = true
	}
	if after.Seq <= got.Seq || got.Seq <= refused.Seq || refused.Seq <= made.Seq {
		t.Errorf("returned seqs out of order: make %d, refusal %d, get %d, after %d", made.Seq, refused.Seq, got.Seq, after.Seq)
	}
}

// TestSetRequestLinksOffRefusedWhileLinkLive (D-115): the switch cannot be
// turned off under a live link, and nothing changes; it turns off otherwise.
func TestSetRequestLinksOffRefusedWhileLinkLive(t *testing.T) {
	a := &App{cfg: appConfig{RequestLinks: true}}
	for _, st := range []string{"making", "waiting", "reconnecting", "deciding", "declined", "receiving"} {
		forceState(a, st, 0)
		if err := a.SetRequestLinks(false); err != errRequestLinksLive {
			t.Errorf("%s: SetRequestLinks(false) = %v, want the live refusal", st, err)
		}
		if !a.GetSettings().RequestLinks {
			t.Fatalf("%s: the refused change turned the switch off", st)
		}
	}
	forceState(a, "off", 0)
	for _, live := range []bool{false} {
		if err := requestLinksChange(false, live, func() FeatureResult {
			t.Fatal("turning off probed the server")
			return FeatureResult{}
		}); err != nil {
			t.Fatalf("turning off with nothing live = %v", err)
		}
	}
}

// TestSetRequestLinksOnNeedsRequest1 (D-115): turning the switch on needs
// request-1 right now; an unreachable server or one without it refuses.
func TestSetRequestLinksOnNeedsRequest1(t *testing.T) {
	f := newFakeSignalServer(t)
	f.set(func(f *fakeSignalServer) { f.features = false })
	a := &App{cfg: appConfig{Server: f.url()}}
	if err := a.SetRequestLinks(true); err != errRequestLinksUnsupported {
		t.Fatalf("SetRequestLinks(true) without request-1 = %v", err)
	}
	if a.GetSettings().RequestLinks {
		t.Fatal("the refused change turned the switch on")
	}
	for _, c := range []struct {
		fr   FeatureResult
		want error
	}{
		{FeatureResult{}, errRequestLinksUnsupported},
		{FeatureResult{Reachable: true}, errRequestLinksUnsupported},
		{FeatureResult{Reachable: true, RequestLinks: true}, nil},
	} {
		if err := requestLinksChange(true, false, func() FeatureResult { return c.fr }); err != c.want {
			t.Errorf("turn on with %+v = %v, want %v", c.fr, err, c.want)
		}
	}
}

// forceGen gives a fresh lane generation g, as Make link would, so the drop
// helpers S1-DSK-03b calls can run without a pairing.
func forceGen(a *App, g uint64) {
	l := a.lane()
	l.mu.Lock()
	l.gen = g
	l.cancelled = false
	l.mu.Unlock()
}

// countingWake is a wake guard whose platform hooks count.
func countingWake() (*wakeGuard, *int, *int) {
	var blocks, allows int
	return &wakeGuard{onBlock: func() { blocks++ }, onAllow: func() { allows++ }}, &blocks, &allows
}

func requestHeld(w *wakeGuard) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	_, ok := w.owners[laneRequest]
	return ok
}

// TestRequestWakeAcquiredOnAcceptReleasedOnEnd: the PC is held awake only
// from Accept to the end of the drop, whichever way it ends.
func TestRequestWakeAcquiredOnAcceptReleasedOnEnd(t *testing.T) {
	ends := map[string]func(a *App, rg uint64){
		"done": func(a *App, rg uint64) {
			a.endDrop(rg, "done", "", &RequestResult{Files: 1, Saved: 1, Verified: 1})
		},
		"stopped": func(a *App, rg uint64) { a.endDrop(rg, "stopped", "write-failed", nil) },
		"cancel": func(a *App, rg uint64) {
			l := a.lane()
			l.mu.Lock()
			l.dropCancel = func() { a.endDrop(rg, "stopped", "stopped", nil) }
			l.mu.Unlock()
			a.CancelRequestDrop()
		},
		"visitor-left": func(a *App, rg uint64) { a.endDrop(rg, "stopped", "visitor-left", nil) },
		"time-limit":   func(a *App, rg uint64) { a.endDrop(rg, "stopped", "time-limit", nil) },
		"quit":         func(a *App, rg uint64) { a.lane().closeForQuit() },
	}
	for name, end := range ends {
		t.Run(name, func(t *testing.T) {
			w, blocks, allows := countingWake()
			a := &App{wake: w}
			a.lane().emitFn = func(string, any) {}
			forceGen(a, 7)
			if pg := a.openPrompt(7, RequestPrompt{Files: 1, TotalBytes: 1}); pg == 0 {
				t.Fatal("the prompt did not open")
			}
			if requestHeld(w) || *blocks != 0 {
				t.Fatal("a prompt holds the PC awake before Accept")
			}
			if !a.acceptDrop(7) {
				t.Fatal("Accept refused the live generation")
			}
			if !requestHeld(w) || *blocks != 1 {
				t.Fatal("Accept did not take the request hold")
			}
			end(a, 7)
			if requestHeld(w) || *allows != 1 {
				t.Fatalf("%s left the request hold (allows %d)", name, *allows)
			}
			if a.lane().liveNow() {
				t.Fatalf("%s left the lane live", name)
			}
		})
	}
}

// TestOpenIdleLinkHoldsNoWakeLock: an open link that nobody uses never keeps
// a laptop from sleeping.
func TestOpenIdleLinkHoldsNoWakeLock(t *testing.T) {
	f := newFakeSignalServer(t)
	a, _ := laneApp(t, f)
	w, blocks, _ := countingWake()
	a.wake = w
	makeWaiting(t, a)
	if requestHeld(w) || *blocks != 0 {
		t.Fatal("an idle open link holds the PC awake")
	}
}

// TestTransferReleaseDoesNotReleaseRequestHold: the lanes own their shares, so
// a transfer's release, even with the same generation number, leaves a
// running drop's hold alone.
func TestTransferReleaseDoesNotReleaseRequestHold(t *testing.T) {
	w, _, allows := countingWake()
	a := &App{wake: w}
	a.lane().emitFn = func(string, any) {}
	forceGen(a, 3)
	a.openPrompt(3, RequestPrompt{})
	a.acceptDrop(3)
	a.wake.release(laneTransfer, 3)
	a.wake.acquire(laneTransfer, 1)
	a.wake.release(laneTransfer, 1)
	if !requestHeld(w) || *allows != 0 {
		t.Fatal("a transfer release dropped the request hold")
	}
	a.endDrop(3, "done", "", nil)
	if requestHeld(w) || *allows != 1 {
		t.Fatal("the drop's end did not release its hold")
	}
}

// TestPromptCarriesLaptopPowerWarning (E-27): every prompt carries the
// generic laptop line exactly once, as a code.
func TestPromptCarriesLaptopPowerWarning(t *testing.T) {
	a := &App{}
	a.lane().emitFn = func(string, any) {}
	forceGen(a, 1)
	pg := a.openPrompt(1, RequestPrompt{Files: 2, Warnings: []string{"low-space"}})
	s := a.GetRequestLink()
	if s.State != "deciding" || s.PromptGen != pg || s.Prompt == nil {
		t.Fatalf("prompt snapshot %+v", s)
	}
	if got := strings.Join(s.Prompt.Warnings, ","); got != "low-space,laptop-power" {
		t.Fatalf("warnings %q", got)
	}
	a.openPrompt(1, RequestPrompt{Warnings: []string{"laptop-power", "relay-over-cap"}})
	if got := strings.Join(a.GetRequestLink().Prompt.Warnings, ","); got != "relay-over-cap,laptop-power" {
		t.Fatalf("warnings %q, want laptop-power once and last", got)
	}
	a.openPrompt(1, RequestPrompt{})
	if got := strings.Join(a.GetRequestLink().Prompt.Warnings, ","); got != "laptop-power" {
		t.Fatalf("warnings %q on a prompt with none of its own", got)
	}
	forceState(a, "off", 0)
}
