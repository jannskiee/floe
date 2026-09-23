package main

// The Request link lane (requestlink.go) against a local fake /ws server that
// speaks the spec 04 5.5 shapes. Every test runs on a bare &App{}; no test
// touches desktop.json, the real server or a real notification. The host token
// is read back from the fake server in memory to compare, and never printed.

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
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

// fakeControl is one request-seal, request-reopen or request-close frame, with
// the room id it named.
type fakeControl struct {
	typ, roomID string
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
	frames    []string      // frame types from clients, in order
	controls  []fakeControl // request-* frames from clients, in order
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
		if strings.HasPrefix(typ, "request-") {
			room, _ := m["roomId"].(string)
			f.controls = append(f.controls, fakeControl{typ: typ, roomID: room})
		}
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

// peerDisconnected tells the newest socket its visitor left.
func (f *fakeSignalServer) peerDisconnected() {
	f.mu.Lock()
	var fc *fakeConn
	if n := len(f.conns); n > 0 {
		fc = f.conns[n-1]
	}
	f.mu.Unlock()
	if fc != nil {
		fc.send(map[string]string{"type": "peer-disconnected"})
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
			a := &App{wake: w, notifyFn: func(string, string) {}}
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
	a := &App{wake: w, notifyFn: func(string, string) {}}
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
	a := &App{notifyFn: func(string, string) {}}
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

// attentionRec records what the lane did to get the owner's attention.
type attentionRec struct {
	mu      sync.Mutex
	titles  []string
	flashes []bool
	toasts  [][2]string
}

func (r *attentionRec) toast(title, body string) {
	r.mu.Lock()
	r.toasts = append(r.toasts, [2]string{title, body})
	r.mu.Unlock()
}

func (r *attentionRec) snapshot() (titles []string, flashes []bool, toasts [][2]string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.titles...), append([]bool(nil), r.flashes...), append([][2]string(nil), r.toasts...)
}

func (r *attentionRec) count(title, body string) int {
	_, _, toasts := r.snapshot()
	n := 0
	for _, p := range toasts {
		if p[0] == title && p[1] == body {
			n++
		}
	}
	return n
}

// watchAttention wires a's toast, title and flash seams to a recorder, and
// its E-40 clock to *clock.
func watchAttention(a *App, clock *time.Time) *attentionRec {
	r := &attentionRec{}
	a.notifyFn = r.toast
	l := a.lane()
	l.mu.Lock()
	l.setTitleFn = func(s string) { r.mu.Lock(); r.titles = append(r.titles, s); r.mu.Unlock() }
	l.flashFn = func(on bool) { r.mu.Lock(); r.flashes = append(r.flashes, on); r.mu.Unlock() }
	if clock != nil {
		l.now = func() time.Time { return *clock }
	}
	l.mu.Unlock()
	return r
}

// attentionApp is a bare App for the attention tests, generation 1 live.
func attentionApp(t *testing.T, clock *time.Time) (*App, *attentionRec) {
	t.Helper()
	a := &App{wake: &wakeGuard{onBlock: func() {}, onAllow: func() {}}}
	a.lane().emitFn = func(string, any) {}
	r := watchAttention(a, clock)
	forceGen(a, 1)
	return a, r
}

// The three table entries, spelled out here so the test is independent of
// the table it checks.
var (
	to1 = [2]string{"Floe", "Someone wants to send you files. Open Floe to answer."}
	to2 = [2]string{"Floe", "Files received."}
	to3 = [2]string{"Floe - receive failed", "The transfer did not complete. Open Floe to see what happened."}
)

// TestRequestToastsAreConstant (VR3-G08): whatever the visitor's names and
// the owner's label hold, every notification the lane sends is one of the
// three table pairs, and none of the hostile text reaches one.
func TestRequestToastsAreConstant(t *testing.T) {
	hostile := []string{"$(calc)]]><x", "]]><![CDATA[", "`whoami`.txt", "photo\u202egnp.exe"}
	label := "$(calc) ]]><x `id` \u202e"
	f := newFakeSignalServer(t)
	a, _ := laneApp(t, f)
	r := watchAttention(a, nil)

	drop := func(end func(rg uint64)) {
		a.MakeRequestLink(label, t.TempDir(), "24h")
		s := waitState(t, a, 10*time.Second, "waiting")
		if s.Label == "" {
			t.Fatal("the label did not reach the snapshot")
		}
		a.openPrompt(s.Gen, RequestPrompt{Files: len(hostile), TotalBytes: 42, Folder: `Floe requests\` + sanitizeRequestLabel(label)})
		a.acceptDrop(s.Gen)
		end(s.Gen)
	}
	drop(func(rg uint64) { a.endDrop(rg, "done", "", &RequestResult{Files: 4, Saved: 4, Names: hostile}) })
	drop(func(rg uint64) {
		a.endDrop(rg, "stopped", "write-failed", &RequestResult{Files: 4, Saved: 1, Names: hostile[:1]})
	})
	drop(func(rg uint64) {
		l := a.lane()
		l.mu.Lock()
		l.dropCancel = func() { a.endDrop(rg, "stopped", "stopped", nil) }
		l.mu.Unlock()
		a.CancelRequestDrop()
	})

	_, _, toasts := r.snapshot()
	if len(toasts) != 5 {
		t.Fatalf("%d notifications, want 5 (three TO1, one TO2, one TO3): %q", len(toasts), toasts)
	}
	for _, p := range toasts {
		if p != to1 && p != to2 && p != to3 {
			t.Errorf("notification %q is not in the table", p)
		}
		for _, h := range append(hostile, label, "calc", "CDATA", "whoami", "\u202e") {
			if strings.Contains(p[0]+p[1], h) {
				t.Errorf("notification %q carries %q", p, h)
			}
		}
	}
	if r.count(to1[0], to1[1]) != 3 || r.count(to2[0], to2[1]) != 1 || r.count(to3[0], to3[1]) != 1 {
		t.Fatalf("toast counts wrong: %q", toasts)
	}
}

// TestNoDirectNotifyInRequestLane (S1-DSK-05, made unbypassable by review 1b
// M1). Every non-test Go file of the desktop package is parsed (for every
// platform: build constraints are not applied), and every REFERENCE to
// notify, notifyFn, notifyTransferFailed or SendNotification, called or not
// (a method value, a package-level alias, an interface method, a helper in a
// new file), must sit in a declaration on the allowlist below; an allowlist
// entry nothing uses any more fails too, so the list stays tight. The
// request lane's only way to a notification is notifyRequest: its one notify
// call passes exactly the title and body requestToastText returned, every
// reference to notifyRequest is a call with a table key, and requestToastText
// returns constants. The transfer lane's calls pass string literals. No toast
// package is imported directly. Because the whole package is scanned, the
// S1-DSK-03b drop (runRequestDrop) is covered by name without being listed.
func TestNoDirectNotifyInRequestLane(t *testing.T) {
	type use struct{ name, owner string }
	allowed := map[use]bool{
		{"notify", "app.go:(*App).notify"}:                             false,
		{"notifyFn", "app.go:(*App).notify"}:                           false,
		{"SendNotification", "app.go:(*App).notify"}:                   false,
		{"notifyFn", "app.go:App"}:                                     false,
		{"notify", "app.go:(*App).notifyTransferFailed"}:               false,
		{"notifyTransferFailed", "app.go:(*App).notifyTransferFailed"}: false,
		{"notify", "transfer.go:(*App).runSend"}:                       false,
		{"notifyTransferFailed", "transfer.go:(*App).runSend"}:         false,
		{"notifyTransferFailed", "transfer.go:(*App).ReceiveByCode"}:   false,
		{"notify", "transfer.go:(*App).receiveByCode"}:                 false,
		{"notify", "requestlink.go:(*App).notifyRequest"}:              false,
	}
	watched := map[string]bool{"notify": true, "notifyFn": true, "notifyTransferFailed": true, "SendNotification": true}
	keys := map[string]bool{"toastRequestArrived": true, "toastDropDone": true, "toastDropFailed": true}
	const laneOwner = "requestlink.go:(*App).notifyRequest"

	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	parsed, laneNotify := 0, 0
	var sawRequest, sawTable bool
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, file, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		parsed++
		for _, imp := range f.Imports {
			if strings.Contains(strings.ToLower(imp.Path.Value), "toast") {
				t.Errorf("%s imports %s: a notification goes through notify only", file, imp.Path.Value)
			}
		}
		for _, decl := range f.Decls {
			owner := file + ":" + declOwner(decl)
			fd, _ := decl.(*ast.FuncDecl)
			// The identifiers that are a call's function, with their call.
			callOf := map[*ast.Ident]*ast.CallExpr{}
			ast.Inspect(decl, func(n ast.Node) bool {
				if call, ok := n.(*ast.CallExpr); ok {
					switch fn := call.Fun.(type) {
					case *ast.Ident:
						callOf[fn] = call
					case *ast.SelectorExpr:
						callOf[fn.Sel] = call
					}
				}
				return true
			})
			var toastVars []string // notifyRequest: the idents requestToastText's pair lands in
			var toastDefined token.Pos
			if fd != nil && owner == laneOwner {
				toastVars, toastDefined = toastTextVars(t, fset, fd)
			}
			ast.Inspect(decl, func(n ast.Node) bool {
				id, ok := n.(*ast.Ident)
				if !ok {
					return true
				}
				at := fset.Position(id.Pos())
				if fd != nil && id == fd.Name {
					switch id.Name {
					case "notifyRequest":
						sawRequest = true
					case "requestToastText":
						sawTable = true
					}
					if watched[id.Name] {
						u := use{id.Name, owner}
						if _, ok := allowed[u]; !ok {
							t.Errorf("%v: %s declares %s", at, owner, id.Name)
						} else {
							allowed[u] = true
						}
					}
					return true
				}
				call := callOf[id]
				switch {
				case watched[id.Name]:
					u := use{id.Name, owner}
					if _, ok := allowed[u]; !ok {
						t.Errorf("%v: %s references %s; only the allowlisted declarations may reach a notification", at, owner, id.Name)
						return true
					}
					allowed[u] = true
					switch {
					case id.Name == "notify" && owner == laneOwner:
						laneNotify++
						if call == nil || len(call.Args) != 2 || len(toastVars) != 2 || call.Pos() < toastDefined || !isIdent(call.Args[0], toastVars[0]) || !isIdent(call.Args[1], toastVars[1]) {
							t.Errorf("%v: notifyRequest reaches notify other than with the pair requestToastText returned", at)
						}
					case id.Name == "notify" && owner == "app.go:(*App).notifyTransferFailed":
						if call == nil || len(call.Args) != 2 || !isStringLit(call.Args[1]) {
							t.Errorf("%v: notifyTransferFailed's body is not a string literal", at)
						}
					case id.Name == "notify" && owner != "app.go:(*App).notify":
						if call == nil || len(call.Args) != 2 || !isStringLit(call.Args[0]) || !isStringLit(call.Args[1]) {
							t.Errorf("%v: %s calls notify with something other than two string literals", at, owner)
						}
					case id.Name == "notifyTransferFailed":
						if call == nil || len(call.Args) != 2 || !isStringLit(call.Args[1]) {
							t.Errorf("%v: %s calls notifyTransferFailed without a literal title", at, owner)
						}
					}
				case id.Name == "notifyRequest":
					if call == nil || len(call.Args) != 2 {
						t.Errorf("%v: %s uses notifyRequest other than as a call with a table key", at, owner)
						return true
					}
					if k, ok := call.Args[1].(*ast.Ident); !ok || !keys[k.Name] {
						t.Errorf("%v: notifyRequest with a key that is not a table constant", at)
					}
				}
				return true
			})
			if fd != nil && fd.Name.Name == "requestToastText" {
				ast.Inspect(fd, func(n ast.Node) bool {
					if ret, ok := n.(*ast.ReturnStmt); ok {
						for _, res := range ret.Results {
							switch v := res.(type) {
							case *ast.BasicLit:
							case *ast.Ident:
								if v.Name != "true" && v.Name != "false" {
									t.Errorf("requestToastText returns %s, not a constant", v.Name)
								}
							default:
								t.Errorf("requestToastText returns a non-constant at %v", fset.Position(res.Pos()))
							}
						}
					}
					return true
				})
			}
		}
	}
	if parsed < 10 || !sawRequest || !sawTable {
		t.Fatalf("parsed %d files, notifyRequest found %v, requestToastText found %v", parsed, sawRequest, sawTable)
	}
	if laneNotify != 1 {
		t.Errorf("notifyRequest references notify %d times, want exactly its one call", laneNotify)
	}
	for u, seen := range allowed {
		if !seen {
			t.Errorf("allowlist entry %s in %s is unused: remove it", u.name, u.owner)
		}
	}
}

// declOwner names a top-level declaration: "(*App).notify" for a method,
// "name" for a function, the declared names for a type, var or const.
func declOwner(d ast.Decl) string {
	switch d := d.(type) {
	case *ast.FuncDecl:
		if d.Recv == nil || len(d.Recv.List) == 0 {
			return d.Name.Name
		}
		return "(" + recvTypeName(d.Recv.List[0].Type) + ")." + d.Name.Name
	case *ast.GenDecl:
		var names []string
		for _, s := range d.Specs {
			switch s := s.(type) {
			case *ast.TypeSpec:
				names = append(names, s.Name.Name)
			case *ast.ValueSpec:
				for _, n := range s.Names {
					names = append(names, n.Name)
				}
			case *ast.ImportSpec:
				names = append(names, "import")
			}
		}
		return strings.Join(names, ",")
	}
	return "?"
}

func recvTypeName(e ast.Expr) string {
	switch e := e.(type) {
	case *ast.StarExpr:
		return "*" + recvTypeName(e.X)
	case *ast.Ident:
		return e.Name
	case *ast.ParenExpr:
		return recvTypeName(e.X)
	case *ast.IndexExpr:
		return recvTypeName(e.X)
	case *ast.IndexListExpr:
		return recvTypeName(e.X)
	}
	return "?"
}

// toastTextVars returns the two identifiers notifyRequest defines from
// requestToastText (title, body) and where that define ends. The define must
// be a top-level statement of the body, and nothing else in the body may set,
// declare or shadow either name (another assignment, a var, a range variable,
// a function literal's parameter), so a later use of the names can only mean
// the table's pair.
func toastTextVars(t *testing.T, fset *token.FileSet, fd *ast.FuncDecl) ([]string, token.Pos) {
	t.Helper()
	var vars []string
	var end token.Pos
	for _, st := range fd.Body.List {
		as, ok := st.(*ast.AssignStmt)
		if !ok || as.Tok != token.DEFINE || len(as.Rhs) != 1 || len(as.Lhs) < 2 {
			continue
		}
		if call, ok := as.Rhs[0].(*ast.CallExpr); ok && isIdent(call.Fun, "requestToastText") {
			for _, e := range as.Lhs[:2] {
				if id, ok := e.(*ast.Ident); ok {
					vars = append(vars, id.Name)
				}
			}
			end = as.End()
		}
	}
	if len(vars) != 2 {
		t.Errorf("notifyRequest does not define its title and body from requestToastText at its top level")
		return nil, 0
	}
	named := func(e ast.Expr) bool { return isIdent(e, vars[0]) || isIdent(e, vars[1]) }
	sets := 0
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		switch s := n.(type) {
		case *ast.AssignStmt:
			for _, e := range s.Lhs {
				if named(e) {
					sets++
				}
			}
		case *ast.RangeStmt:
			if named(s.Key) || named(s.Value) {
				sets++
			}
		case *ast.ValueSpec:
			for _, id := range s.Names {
				if named(id) {
					sets++
				}
			}
		case *ast.FuncLit:
			t.Errorf("%v: notifyRequest holds a function literal", fset.Position(s.Pos()))
		}
		return true
	})
	if sets != 2 {
		t.Errorf("notifyRequest sets or shadows its title and body %d times, want only the define from requestToastText", sets)
	}
	return vars, end
}

func isIdent(e ast.Expr, name string) bool {
	id, ok := e.(*ast.Ident)
	return ok && id.Name == name
}

func isStringLit(e ast.Expr) bool {
	lit, ok := e.(*ast.BasicLit)
	return ok && lit.Kind == token.STRING
}

// TestPromptSpamSuppressesToastKeepsFlashAndTitle (E-40): after two prompts
// end without Accept within 10 minutes, the next prompt sends no toast but
// still flashes and sets the title, and suggests closing the link; once those
// ends leave the window, toasts come back.
func TestPromptSpamSuppressesToastKeepsFlashAndTitle(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	a, r := attentionApp(t, &clock)
	for i := 0; i < 2; i++ {
		a.openPrompt(1, RequestPrompt{})
		a.endPrompt(1)
		clock = clock.Add(time.Minute)
	}
	if r.count(to1[0], to1[1]) != 2 {
		t.Fatal("the first two prompts did not each toast")
	}
	a.openPrompt(1, RequestPrompt{})
	titles, flashes, _ := r.snapshot()
	if r.count(to1[0], to1[1]) != 2 {
		t.Fatal("the third prompt toasted after two unanswered ends")
	}
	if titles[len(titles)-1] != "(1) Floe" || !flashes[len(flashes)-1] {
		t.Fatal("the quiet prompt lost its flash or title")
	}
	if !a.GetRequestLink().SuggestClose {
		t.Fatal("suggestClose is not set")
	}
	a.endPrompt(1)
	clock = clock.Add(11 * time.Minute)
	a.openPrompt(1, RequestPrompt{})
	if r.count(to1[0], to1[1]) != 3 || a.GetRequestLink().SuggestClose {
		t.Fatal("the toast did not come back once the ends left the window")
	}
	a.endPrompt(1)
}

// TestPromptSpamResetsAfterAccept (E-40): an Accept clears the count.
func TestPromptSpamResetsAfterAccept(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	a, _ := attentionApp(t, &clock)
	a.openPrompt(1, RequestPrompt{})
	a.endPrompt(1)
	a.openPrompt(1, RequestPrompt{})
	a.endPrompt(1)
	a.openPrompt(1, RequestPrompt{})
	if !a.GetRequestLink().SuggestClose {
		t.Fatal("suggestClose is not set after two unanswered ends")
	}
	a.acceptDrop(1)
	if a.GetRequestLink().SuggestClose {
		t.Fatal("Accept did not clear suggestClose")
	}
	l := a.lane()
	l.mu.Lock()
	n := len(l.promptEnds)
	l.mu.Unlock()
	if n != 0 {
		t.Fatalf("Accept left %d prompt ends", n)
	}
	a.endDrop(1, "done", "", nil)
}

// TestRequestTitleSetAndRestored: "(1) Floe" exactly while a prompt waits,
// "Floe" again after every way a prompt ends.
func TestRequestTitleSetAndRestored(t *testing.T) {
	ends := map[string]func(a *App){
		"accept":       func(a *App) { a.acceptDrop(1) },
		"decline":      func(a *App) { a.endPrompt(1) },
		"timeout":      func(a *App) { a.endPrompt(1) },
		"visitor-left": func(a *App) { a.endPrompt(1) },
		"close-link":   func(a *App) { a.CloseRequestLink() },
		"quit":         func(a *App) { a.lane().closeForQuit() },
	}
	for name, end := range ends {
		t.Run(name, func(t *testing.T) {
			a, r := attentionApp(t, nil)
			a.notifyFn = func(string, string) {}
			a.openPrompt(1, RequestPrompt{})
			end(a)
			titles, _, _ := r.snapshot()
			if strings.Join(titles, "|") != "(1) Floe|Floe" {
				t.Fatalf("titles %q, want (1) Floe then Floe", titles)
			}
			end(a) // a second end changes nothing
			if titles2, _, _ := r.snapshot(); len(titles2) != 2 {
				t.Fatalf("titles after a second end %q", titles2)
			}
		})
	}
}

// TestPromptRacingCloseLinkLeavesTitleIdle (review 1a F3, probe P2): a Close
// link that lands while onPrompt is still applying the flash and the title
// leaves the window titled Floe with the flash off, never "(1) Floe" for a
// link that is closed.
func TestPromptRacingCloseLinkLeavesTitleIdle(t *testing.T) {
	a := &App{notifyFn: func(string, string) {}, wake: &wakeGuard{onBlock: func() {}, onAllow: func() {}}}
	l := a.lane()
	l.emitFn = func(string, any) {}
	var mu sync.Mutex
	var titles []string
	var flashes []bool
	gate, entered := make(chan struct{}), make(chan struct{})
	var once sync.Once
	l.setTitleFn = func(s string) { mu.Lock(); titles = append(titles, s); mu.Unlock() }
	l.flashFn = func(on bool) {
		mu.Lock()
		flashes = append(flashes, on)
		mu.Unlock()
		if on {
			once.Do(func() { close(entered) })
			<-gate
		}
	}
	forceGen(a, 1)
	forceState(a, "waiting", 0)
	done := make(chan struct{})
	go func() { a.openPrompt(1, RequestPrompt{}); close(done) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("onPrompt never flashed")
	}
	a.CloseRequestLink()
	close(gate)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("onPrompt did not return")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(titles) == 0 || titles[len(titles)-1] != "Floe" || flashes[len(flashes)-1] {
		t.Fatalf("titles %q, flashes %v: the closed link left the prompt's attention on", titles, flashes)
	}
}

// TestRequestFlashStartsOnPromptStopsOnAnswer: the flash is on exactly while
// a prompt waits.
func TestRequestFlashStartsOnPromptStopsOnAnswer(t *testing.T) {
	a, r := attentionApp(t, nil)
	a.notifyFn = func(string, string) {}
	a.openPrompt(1, RequestPrompt{})
	if _, flashes, _ := r.snapshot(); len(flashes) != 1 || !flashes[0] {
		t.Fatalf("flashes after the prompt %v", flashes)
	}
	a.acceptDrop(1)
	if _, flashes, _ := r.snapshot(); len(flashes) != 2 || flashes[1] {
		t.Fatalf("flashes after Accept %v", flashes)
	}
	a.endDrop(1, "done", "", nil)
	if _, flashes, _ := r.snapshot(); len(flashes) != 2 {
		t.Fatalf("the drop's end flashed again: %v", flashes)
	}
}

// TestOwnerCancelSendsNoFailureToast: the owner's own Cancel drop is not a
// failure; a stop the owner did not cause sends TO3 once.
func TestOwnerCancelSendsNoFailureToast(t *testing.T) {
	a, r := attentionApp(t, nil)
	a.openPrompt(1, RequestPrompt{})
	a.acceptDrop(1)
	l := a.lane()
	l.mu.Lock()
	l.dropCancel = func() { a.endDrop(1, "stopped", "stopped", nil) }
	l.mu.Unlock()
	a.CancelRequestDrop()
	if r.count(to3[0], to3[1]) != 0 {
		t.Fatal("the owner's Cancel drop sent the failure toast")
	}
	forceGen(a, 2)
	a.openPrompt(2, RequestPrompt{})
	a.acceptDrop(2)
	a.endDrop(2, "stopped", "peer-abort", nil)
	if r.count(to3[0], to3[1]) != 1 {
		t.Fatal("a stop the owner did not cause sent no failure toast")
	}
}

// TestEndedLinkLetsGoOfItsSocket: when a link ends from outside the lane
// goroutine (a drop's end), the goroutine wakes, sends request-close for the
// used-up link and closes its socket, instead of holding both until the
// link's old end time; a new link then starts clean.
func TestEndedLinkLetsGoOfItsSocket(t *testing.T) {
	f := newFakeSignalServer(t)
	a, _ := laneApp(t, f)
	s := makeWaiting(t, a)
	a.openPrompt(s.Gen, RequestPrompt{})
	a.acceptDrop(s.Gen)
	a.endDrop(s.Gen, "done", "", nil)
	done := make(chan struct{})
	go func() { a.lane().wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the lane goroutine kept waiting after its link ended")
	}
	waitFor(t, 5*time.Second, "request-close", func() bool { return f.count("request-close") == 1 })
	waitFor(t, 5*time.Second, "the socket to close", func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.closedCnt == 1
	})
	if _, _, sc := laneHandles(a); sc != nil {
		t.Fatal("the lane kept the ended link's socket")
	}
	makeWaiting(t, a)
}

// TestRequestSnapshotSeqUniqueUnderConcurrency (D-115, WP-D-UI review-2): with
// AnswerRequest replies, GetRequestLink replies and request:state events all
// racing, every snapshot carries a seq, the emitted ones strictly increase in
// emit order, and no two snapshots, emitted or returned, share a seq (so no
// two different snapshots share a (gen, seq) pair).
func TestRequestSnapshotSeqUniqueUnderConcurrency(t *testing.T) {
	a := &App{notifyFn: func(string, string) {}}
	rec := &snapRecorder{}
	l := a.lane()
	l.emitFn = rec.emit
	l.flashFn = func(bool) {}
	l.setTitleFn = func(string) {}
	forceGen(a, 1)
	pg := a.openPrompt(1, RequestPrompt{Files: 1})

	var mu sync.Mutex
	var returned []RequestLinkSnapshot
	keep := func(s RequestLinkSnapshot) {
		mu.Lock()
		returned = append(returned, s)
		mu.Unlock()
	}
	var wg sync.WaitGroup
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				switch (w + i) % 4 {
				case 0:
					keep(a.AnswerRequest(pg, "accept"))
					select {
					case <-l.decision:
					default:
					}
				case 1:
					keep(a.GetRequestLink())
				case 2:
					a.emitState(1)
				case 3:
					a.reqUpdate(1, func(l *requestLane) { l.route = "direct" })
				}
			}
		}(w)
	}
	wg.Wait()

	seen := map[uint64]bool{}
	var prev uint64
	for i, s := range rec.all() {
		if s.Seq == 0 || s.Seq <= prev {
			t.Fatalf("emitted snapshot %d has seq %d after %d", i, s.Seq, prev)
		}
		prev = s.Seq
		seen[s.Seq] = true
	}
	for _, s := range returned {
		if s.Seq == 0 {
			t.Fatal("a returned snapshot has no seq")
		}
		if seen[s.Seq] {
			t.Fatalf("seq %d was given to two snapshots", s.Seq)
		}
		seen[s.Seq] = true
	}
	if rec.len() < 100 || len(returned) < 100 {
		t.Fatalf("only %d emitted and %d returned snapshots", rec.len(), len(returned))
	}
	forceState(a, "off", 0)
}

// TestPeerLeftBeforeChannelReopens (D-116, B1 review 2a L1): a
// peer-disconnected that reaches a waiting link before any data channel
// exists reopens the room, so a visitor coming back on a new socket is not
// answered room-full, and the link stays waiting on the same socket.
func TestPeerLeftBeforeChannelReopens(t *testing.T) {
	f := newFakeSignalServer(t)
	a, _ := laneApp(t, f)
	s := makeWaiting(t, a)
	_, _, sc := laneHandles(a)
	f.peerDisconnected()
	waitFor(t, 5*time.Second, "request-reopen", func() bool { return f.count("request-reopen") == 1 })
	time.Sleep(50 * time.Millisecond)
	now := stateOf(a)
	if now.State != "waiting" || now.Link != s.Link || now.Gen != s.Gen {
		t.Fatalf("after the visitor left: %+v", now)
	}
	if _, _, sc2 := laneHandles(a); sc2 != sc {
		t.Fatal("the lane swapped its socket")
	}
	if n := len(f.tokenJoins()); n != 1 {
		t.Fatalf("%d token joins, want 1 (no reconnect)", n)
	}
}

// TestCloseDuringHostJoinSendsNoRoomlessClose (review 1a F4): a Close link
// that lands while the host join is still being written leaves the socket to
// the goroutine joining with it. No request-close is written before the join
// (none names room ""), nothing reads the engine's room id while the join
// writes it, and once the join answers the goroutine frees the reservation
// itself with one request-close for the joined room and closes the socket.
func TestCloseDuringHostJoinSendsNoRoomlessClose(t *testing.T) {
	f := newFakeSignalServer(t)
	entered, release := make(chan struct{}), make(chan struct{})
	var once, releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	setJoin(t, func(sc *signaling.Client, room, tok string) (signaling.HostJoinResult, error) {
		once.Do(func() { close(entered) })
		<-release
		return sc.JoinRoomWithToken(room, tok)
	})
	a, _ := laneApp(t, f)
	a.MakeRequestLink("x", t.TempDir(), "24h")
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the host join never started")
	}
	a.CloseRequestLink()
	if s := stateOf(a); s.State != "ended" || s.Code != "closed" {
		t.Fatalf("after Close link during the join: %q %q", s.State, s.Code)
	}
	time.Sleep(300 * time.Millisecond) // longer than the lane's closeWait here
	unblock()
	waitFor(t, 5*time.Second, "the socket to close", func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.closedCnt == 1
	})
	f.mu.Lock()
	controls := append([]fakeControl(nil), f.controls...)
	f.mu.Unlock()
	for _, c := range controls {
		if c.roomID == "" {
			t.Fatalf("%s written with no room id: the teardown raced the join", c.typ)
		}
	}
	joins := f.tokenJoins()
	if len(joins) != 1 {
		t.Fatalf("%d token joins, want 1", len(joins))
	}
	closes := 0
	for _, c := range controls {
		if c.typ == "request-close" {
			closes++
			if c.roomID != joins[0].roomID {
				t.Fatal("the request-close names another room than the join")
			}
		}
	}
	if closes != 1 {
		t.Fatalf("%d request-close frames, want 1 for the joined room", closes)
	}
	if _, _, sc := laneHandles(a); sc != nil {
		t.Fatal("the closed link's lane holds a socket")
	}
}

// TestPeerLeftWhileDeclinedDoesNotReopen (review 1a F1, probe P1): the
// declined visitor leaving is expected, and only the owner's Keep waiting
// reopens that room (T17), so the lane sends no request-reopen of its own and
// stays declined; Keep waiting then reopens once.
func TestPeerLeftWhileDeclinedDoesNotReopen(t *testing.T) {
	f := newFakeSignalServer(t)
	a, _ := laneApp(t, f)
	s := makeWaiting(t, a)
	forceState(a, "declined", 5)
	f.peerDisconnected()
	time.Sleep(200 * time.Millisecond)
	if n := f.count("request-reopen"); n != 0 {
		t.Fatalf("%d request-reopen sent while declined (the owner never chose Keep waiting)", n)
	}
	if now := stateOf(a); now.State != "declined" || now.Link != s.Link {
		t.Fatalf("after the declined visitor left: %q, same link %v", now.State, now.Link == s.Link)
	}
	a.AnswerRequest(5, "keep-waiting")
	waitFor(t, 5*time.Second, "request-reopen", func() bool { return f.count("request-reopen") == 1 })
}

// TestSocketLossWhileDeclinedKeepsDeclined (review 1a F1, probe P4): a socket
// loss while declined reconnects to the link's end time as in waiting, but the
// re-join brings declined back rather than waiting: the server kept the room
// sealed (spec 04 5.7, Grace-sealed reclaims to Vacant-sealed or Active), so a
// link shown as waiting would turn every visitor away room-full. The owner's
// Keep waiting then reopens it on the new socket.
func TestSocketLossWhileDeclinedKeepsDeclined(t *testing.T) {
	f := newFakeSignalServer(t)
	a, _ := laneApp(t, f)
	l := a.lane()
	l.backoffBase, l.backoffCap = 20*time.Millisecond, 80*time.Millisecond
	s := makeWaiting(t, a)
	forceState(a, "declined", 5)
	f.dropAll()
	waitFor(t, 5*time.Second, "the re-join to settle", func() bool {
		return len(f.tokenJoins()) == 2 && stateOf(a).State != "reconnecting"
	})
	now := stateOf(a)
	if now.State != "declined" || now.PromptGen != 5 || now.Link != s.Link || now.Gen != s.Gen {
		t.Fatalf("a reconnect from declined ended in %q (promptGen %d, same link %v, same gen %v)", now.State, now.PromptGen, now.Link == s.Link, now.Gen == s.Gen)
	}
	if n := f.count("request-reopen"); n != 0 {
		t.Fatalf("%d request-reopen sent by the reconnect from declined", n)
	}
	if out := a.AnswerRequest(5, "keep-waiting"); out.State != "waiting" {
		t.Fatalf("keep-waiting after the reconnect: %q", out.State)
	}
	waitFor(t, 5*time.Second, "request-reopen on the new socket", func() bool { return f.count("request-reopen") == 1 })
}

// TestReconnectFromWaitingSendsReopen (review 1a F2): a re-join from waiting
// sends request-reopen once, on the new socket after its join, so a reopen
// written on the socket that died (a setup-failed or visitor-left return in
// S1-DSK-03b) cannot leave the reclaimed room sealed (spec 04 5.7:
// Grace-sealed reclaims to Vacant-sealed) while the lane shows waiting. On a
// room that is open already it changes nothing (Waiting plus request-reopen
// is Waiting).
func TestReconnectFromWaitingSendsReopen(t *testing.T) {
	f := newFakeSignalServer(t)
	a, _ := laneApp(t, f)
	l := a.lane()
	l.backoffBase, l.backoffCap = 20*time.Millisecond, 80*time.Millisecond
	s := makeWaiting(t, a)
	f.dropAll()
	waitFor(t, 5*time.Second, "the re-join to settle", func() bool {
		return len(f.tokenJoins()) == 2 && stateOf(a).State == "waiting"
	})
	waitFor(t, 5*time.Second, "request-reopen after the re-join", func() bool { return f.count("request-reopen") == 1 })
	time.Sleep(100 * time.Millisecond)
	if n := f.count("request-reopen"); n != 1 {
		t.Fatalf("%d request-reopen frames after one re-join, want 1", n)
	}
	f.mu.Lock()
	joins, reopenAt := 0, -1
	for i, typ := range f.frames {
		if typ == "join-room" {
			joins++
		}
		if typ == "request-reopen" && reopenAt < 0 && joins == 2 {
			reopenAt = i
		}
	}
	f.mu.Unlock()
	if reopenAt < 0 {
		t.Fatal("the reopen did not follow the re-join")
	}
	if now := stateOf(a); now.State != "waiting" || now.Link != s.Link || now.Gen != s.Gen {
		t.Fatalf("after the re-join: %q, same link %v, same gen %v", now.State, now.Link == s.Link, now.Gen == s.Gen)
	}
}
