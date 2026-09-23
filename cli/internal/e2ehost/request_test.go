package main

// Request mode's proof, in process and against fakes only: the Decide script
// parser and its answers, the event lines, the fast-timer flag, the flags a
// spec can get wrong, the end-frame rewrite of -corrupt-hash, and whole runs
// of runRequest against a fake reserved-room /ws server with a Go visitor on
// the other end (delivered, declined then delivered after keep-waiting, a
// corrupted digest refused, a host socket blip). Host tokens are compared,
// never printed.

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/jannskiee/floe/cli/engine/transfer"
)

func TestScriptedDecideParses(t *testing.T) {
	good := map[string]decideStep{
		"accept":         {kind: transfer.DecisionAccept},
		"decline":        {kind: transfer.DecisionDecline},
		"never":          {never: true},
		"delay:0":        {kind: transfer.DecisionAccept},
		"delay:20000":    {kind: transfer.DecisionAccept, delay: 20 * time.Second},
		"refuse:expired": {kind: transfer.DecisionRefuse, code: transfer.CodeExpired},
	}
	for _, code := range transfer.RefusalCodes {
		good["refuse:"+string(code)] = decideStep{kind: transfer.DecisionRefuse, code: code}
	}
	for spec, want := range good {
		got, err := parseDecideStep(spec)
		if err != nil || got != want {
			t.Errorf("parseDecideStep(%q) = %+v, %v; want %+v", spec, got, err, want)
		}
	}
	for _, bad := range []string{
		"", "ACCEPT", "accept ", "yes", "delay:", "delay:x", "delay:-1", "delay:1.5",
		"refuse:", "refuse:no-such-code", "refuse:Declined", "refuse:declined ", "never:1",
	} {
		if _, err := parseDecideStep(bad); err == nil {
			t.Errorf("parseDecideStep(%q) accepted a step it must refuse", bad)
		}
	}
	steps, err := parseDecideScript("decline, delay:5,accept")
	if err != nil || len(steps) != 3 || steps[0].kind != transfer.DecisionDecline || steps[1].delay != 5*time.Millisecond || steps[2].kind != transfer.DecisionAccept {
		t.Fatalf("parseDecideScript = %+v, %v", steps, err)
	}
	if _, err := parseDecideScript("accept,refuse:bogus"); err == nil {
		t.Fatal("an unknown code later in the list was accepted")
	}
}

// Each step's answer, and the two ways a wait ends early: the decide window
// answers expired, a closed channel answers decline.
func TestScriptedDecideAnswers(t *testing.T) {
	open := make(chan struct{})
	if d := (decideStep{kind: transfer.DecisionAccept}).answer(time.Minute, open); d.Kind != transfer.DecisionAccept {
		t.Fatalf("accept answered %+v", d)
	}
	if d := (decideStep{kind: transfer.DecisionRefuse, code: transfer.CodeDiskFull}).answer(time.Minute, open); d.Kind != transfer.DecisionRefuse || d.Code != transfer.CodeDiskFull {
		t.Fatalf("refuse answered %+v", d)
	}
	start := time.Now()
	if d := (decideStep{kind: transfer.DecisionAccept, delay: 80 * time.Millisecond}).answer(time.Minute, open); d.Kind != transfer.DecisionAccept || time.Since(start) < 70*time.Millisecond {
		t.Fatalf("delay answered %+v after %v", d, time.Since(start))
	}
	start = time.Now()
	if d := (decideStep{never: true}).answer(100*time.Millisecond, open); d.Kind != transfer.DecisionRefuse || d.Code != transfer.CodeExpired || time.Since(start) < 90*time.Millisecond {
		t.Fatalf("never answered %+v after %v, want expired at the window", d, time.Since(start))
	}
	closed := make(chan struct{})
	close(closed)
	if d := (decideStep{never: true}).answer(time.Minute, closed); d.Kind != transfer.DecisionDecline {
		t.Fatalf("never with the channel closed answered %+v, want decline", d)
	}
}

// Every event request mode emits is one JSON object on its own line with a
// string "event", and fields hold only fixed words, ids and counts.
func TestEventLinesAreJSON(t *testing.T) {
	var buf bytes.Buffer
	ev := &events{enc: json.NewEncoder(&buf), exit: func(code int) { panic(exitPanic(code)) }}
	h := &requestHost{ev: ev}
	h.emit("joined", map[string]interface{}{"role": "host", "roomId": "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"})
	h.emit("link", map[string]interface{}{"link": "http://localhost:3000/r/Xk3p9Q0aB1c#6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"})
	h.emit("deciding", map[string]interface{}{"files": 3})
	h.emit("refused", map[string]interface{}{"code": string(transfer.CodeDeclined)})
	h.emit("file-committed", map[string]interface{}{"verified": true})
	h.emit("sealed", nil)
	ev.emit(map[string]interface{}{"event": "done", "files": 1, "verified": 1})
	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if len(lines) != 7 {
		t.Fatalf("%d lines, want 7:\n%s", len(lines), buf.String())
	}
	for i, line := range lines {
		var m map[string]interface{}
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("line %d is not JSON: %s", i, line)
		}
		if name, ok := m["event"].(string); !ok || name == "" {
			t.Fatalf("line %d has no event name: %s", i, line)
		}
	}
}

// The decide window is transfer.HostDecisionWindow unless -fast-timers is
// given, and the flag touches nothing but the harness's own config: the
// engine constant keeps its value.
func TestFastTimersShrinkOnlyUnderTheFlag(t *testing.T) {
	plain, err := parseRequestFlags([]string{"-out", t.TempDir()})
	if err != nil || plain.decideWindow != transfer.HostDecisionWindow {
		t.Fatalf("without the flag: window %v, err %v; want %v", plain.decideWindow, err, transfer.HostDecisionWindow)
	}
	fast, err := parseRequestFlags([]string{"-out", t.TempDir(), "-fast-timers"})
	if err != nil || fast.decideWindow != fastDecideWindow {
		t.Fatalf("with the flag: window %v, err %v; want %v", fast.decideWindow, err, fastDecideWindow)
	}
	if transfer.HostDecisionWindow != 9*time.Minute+45*time.Second || fastDecideWindow >= transfer.HostDecisionWindow {
		t.Fatalf("HostDecisionWindow %v, fastDecideWindow %v", transfer.HostDecisionWindow, fastDecideWindow)
	}
}

// -max-files and -block-shell-types reach ReceiveOptions.Limits, and nothing
// else in it moves: no free-space reserve (a test must not depend on this
// disk), no host relay check, the engine's default commit retry. With neither
// flag Limits stays nil, the plain receive. -block-shell-types alone keeps the
// Beta file cap, because a zero MaxFiles would refuse every drop.
func TestLimitFlagsPlumb(t *testing.T) {
	dir := t.TempDir()
	plain, err := parseRequestFlags([]string{"-out", dir})
	if err != nil || plain.limits != nil {
		t.Fatalf("without limit flags: limits %+v, err %v; want nil", plain.limits, err)
	}
	for _, tc := range []struct {
		args  []string
		files int
		shell bool
	}{
		{[]string{"-block-shell-types"}, requestMaxFiles, true},
		{[]string{"-max-files", "2"}, 2, false},
		{[]string{"-max-files", "3", "-block-shell-types"}, 3, true},
	} {
		cfg, err := parseRequestFlags(append([]string{"-out", dir}, tc.args...))
		if err != nil || cfg.limits == nil {
			t.Fatalf("%v: limits %+v, err %v", tc.args, cfg.limits, err)
		}
		l := cfg.limits
		if l.MaxFiles != tc.files || l.BlockShellTypes != tc.shell || l.FreeReserve != 0 || l.HostRelayCheck || l.CommitRetry != 0 {
			t.Fatalf("%v: limits %+v, want MaxFiles %d BlockShellTypes %v and nothing else", tc.args, *l, tc.files, tc.shell)
		}
	}
}

// Flags a spec can get wrong fail at start with the usage stage, and the
// server never comes from FLOE_SERVER.
func TestRequestFlagsRefuseBadInput(t *testing.T) {
	t.Setenv("FLOE_SERVER", "https://api.floe.one")
	cfg, err := parseRequestFlags([]string{"-out", t.TempDir()})
	if err != nil || cfg.server != "http://127.0.0.1:3001" {
		t.Fatalf("server = %q, err %v; want the local default whatever FLOE_SERVER says", cfg.server, err)
	}
	dir := t.TempDir()
	for name, args := range map[string][]string{
		"no out":            {},
		"positional":        {"-out", dir, "extra"},
		"unknown flag":      {"-out", dir, "-no-such-flag", "10"},
		"commit-retry gone": {"-out", dir, "-commit-retry", "5m"},
		"zero max-files":    {"-out", dir, "-max-files", "0"},
		"negative files":    {"-out", dir, "-max-files", "-1"},
		"bad decide":        {"-out", dir, "-decide", "sometimes"},
		"unknown blip":      {"-out", dir, "-blip-after", "done"},
		"zero timeout":      {"-out", dir, "-timeout", "0s"},
	} {
		if _, err := parseRequestFlags(args); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// Only an end frame's digest changes, to one that is well formed and wrong;
// every other frame passes byte for byte.
func TestCorruptEndFrameChangesOnlyTheDigest(t *testing.T) {
	digest := strings.Repeat("ab", 32)
	got, ok := corruptEndFrame([]byte(`{"type":"end","sha256":"` + digest + `"}`))
	if !ok {
		t.Fatal("an end frame with a digest was not rewritten")
	}
	var f struct{ Type, SHA256 string }
	if err := json.Unmarshal(got, &f); err != nil || f.Type != "end" || f.SHA256 == digest || len(f.SHA256) != 64 || f.SHA256[1:] != digest[1:] {
		t.Fatalf("rewritten frame %s", got)
	}
	for _, same := range []string{
		`{"type":"end"}`,
		`{"type":"end","sha256":null}`,
		`{"type":"metadata","sha256":"` + digest + `"}`,
		`not json`,
		"\x00\x01binary chunk",
	} {
		if out, ok := corruptEndFrame([]byte(same)); ok || !bytes.Equal(out, []byte(same)) {
			t.Errorf("%q was changed to %q", same, out)
		}
	}
}

// ---- whole runs against a fake reserved-room server ----

// fakeConn is one /ws socket on the fake server.
type fakeConn struct {
	id string
	ws *websocket.Conn
	mu sync.Mutex
}

func (c *fakeConn) send(v interface{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.ws.WriteJSON(v)
}

// fakeRequestServer is spec 04 5.5 cut down to what one host and its visitors
// need: a token join seats the host (checking the room is the token's
// derivation), request-join seats a visitor and tells the host, signals go to
// the other seat, and the three control frames are recorded (reopen evicts
// the visitor with room-full, as 5.6.6 does). It also serves a STUN-only ICE
// list pointing at a closed local port, so nothing leaves the machine.
type fakeRequestServer struct {
	url      string
	mu       sync.Mutex
	host     *fakeConn
	visitor  *fakeConn
	tokens   []string // every host token seen, for the no-token-printed check only
	badRoom  bool     // a host join whose room was not its token's derivation
	controls []string
	stats    int // requests to /api/stats/report: the harness must make none
}

func newFakeRequestServer(t *testing.T) *fakeRequestServer {
	t.Helper()
	s := &fakeRequestServer{}
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/stats/report", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.stats++
		s.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/api/turn-credentials", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`[{"urls":"stun:127.0.0.1:9"}]`))
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		c := &fakeConn{id: uuid.New().String(), ws: ws}
		for {
			_, raw, err := ws.ReadMessage()
			if err != nil {
				return
			}
			var m struct {
				Type      string          `json:"type"`
				RoomID    string          `json:"roomId"`
				HostToken string          `json:"hostToken"`
				Signal    json.RawMessage `json:"signal"`
			}
			if json.Unmarshal(raw, &m) != nil {
				continue
			}
			s.handle(c, m.Type, m.RoomID, m.HostToken, m.Signal)
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	s.url = srv.URL
	return s
}

func (s *fakeRequestServer) handle(c *fakeConn, typ, room, token string, signal json.RawMessage) {
	switch typ {
	case "join-room":
		s.mu.Lock()
		s.tokens = append(s.tokens, token)
		if room != signaling.RoomIDFromToken(token) {
			s.badRoom = true
		}
		s.host = c
		s.mu.Unlock()
		c.send(map[string]string{"type": "room-joined", "role": "host"})
	case "request-join":
		s.mu.Lock()
		host := s.host
		if host == nil {
			s.mu.Unlock()
			c.send(map[string]string{"type": "host-absent"})
			return
		}
		s.visitor = c
		s.mu.Unlock()
		c.send(map[string]string{"type": "request-joined", "role": "visitor"})
		host.send(map[string]string{"type": "user-connected", "id": c.id})
	case "signal":
		s.mu.Lock()
		other := s.host
		if c == s.host {
			other = s.visitor
		}
		s.mu.Unlock()
		if other != nil && len(signal) > 0 {
			other.send(map[string]interface{}{"type": "signal", "signal": signal, "sender": c.id})
		}
	case "request-seal", "request-reopen", "request-close":
		s.mu.Lock()
		s.controls = append(s.controls, typ)
		var evicted *fakeConn
		if typ == "request-reopen" {
			evicted, s.visitor = s.visitor, nil
		}
		s.mu.Unlock()
		if evicted != nil {
			evicted.send(map[string]string{"type": "room-full"})
		}
	case "ping":
		c.send(map[string]string{"type": "pong"})
	}
}

func (s *fakeRequestServer) snapshot() (tokens []string, badRoom bool, controls []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.tokens...), s.badRoom, append([]string(nil), s.controls...)
}

// controlsAfter reads the fake server's record once it holds n control frames,
// or after 5 s. The harness writes request-close and exits at once, and the
// server's read goroutine can still be a frame behind when the test reads: a
// slow runner showed it (macOS, CI run 35812550043). A frame that never
// arrives still fails the caller's comparison.
func (s *fakeRequestServer) controlsAfter(n int) (tokens []string, badRoom bool, controls []string) {
	deadline := time.Now().Add(5 * time.Second)
	for {
		tokens, badRoom, controls = s.snapshot()
		if len(controls) >= n || time.Now().After(deadline) {
			return tokens, badRoom, controls
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// statsRequests is how many times anything asked to report stats.
func (s *fakeRequestServer) statsRequests() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stats
}

// lineSink hands each line the harness writes to the test, raw and parsed.
type lineSink struct {
	raw   chan string
	lines chan map[string]interface{}
}

func (w *lineSink) Write(p []byte) (int, error) {
	line := strings.TrimSpace(string(p))
	w.raw <- line
	var m map[string]interface{}
	if json.Unmarshal([]byte(line), &m) == nil {
		w.lines <- m
	} else {
		w.lines <- map[string]interface{}{"event": "NOT-JSON"}
	}
	return len(p), nil
}

// harnessRun is runRequest on its own goroutine with its events captured.
type harnessRun struct {
	sink *lineSink
	code chan int
	seen []map[string]interface{}
	raws []string
}

func startRequest(t *testing.T, args ...string) *harnessRun {
	t.Helper()
	h := &harnessRun{
		sink: &lineSink{raw: make(chan string, 256), lines: make(chan map[string]interface{}, 256)},
		code: make(chan int, 1),
	}
	ev := &events{enc: json.NewEncoder(h.sink), exit: func(code int) { panic(exitPanic(code)) }}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				if code, ok := r.(exitPanic); ok {
					h.code <- int(code)
					return
				}
				panic(r)
			}
		}()
		runRequest(ev, args)
	}()
	return h
}

// until reads events until one named name arrives, keeping all it read.
func (h *harnessRun) until(t *testing.T, name string) map[string]interface{} {
	t.Helper()
	deadline := time.After(45 * time.Second)
	for {
		select {
		case m := <-h.sink.lines:
			h.raws = append(h.raws, <-h.sink.raw)
			h.seen = append(h.seen, m)
			if m["event"] == name {
				return m
			}
			if m["event"] == "error" {
				t.Fatalf("harness error event %v (events so far %v)", m, h.names())
			}
		case <-deadline:
			t.Fatalf("no %q event within 45s (events so far %v)", name, h.names())
			return nil
		}
	}
}

func (h *harnessRun) names() []string {
	var out []string
	for _, m := range h.seen {
		name, _ := m["event"].(string)
		if name != "route" {
			out = append(out, name)
		}
	}
	return out
}

func (h *harnessRun) exitCode(t *testing.T) int {
	t.Helper()
	select {
	case c := <-h.code:
		return c
	case <-time.After(10 * time.Second):
		t.Fatal("the harness never exited")
		return -1
	}
}

// linkIDShape is signaling.NewLinkID's output: 11 base64url characters.
var linkIDShape = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

// roomFromLink checks the link's shape and returns its room id.
func roomFromLink(t *testing.T, link string) string {
	t.Helper()
	const base = "http://localhost:3000/r/"
	if !strings.HasPrefix(link, base) {
		t.Fatalf("link %q does not start with %s", link, base)
	}
	id, room, ok := strings.Cut(strings.TrimPrefix(link, base), "#")
	if !ok || !linkIDShape.MatchString(id) {
		t.Fatalf("link %q: link id is not 11 base64url characters", link)
	}
	if _, err := uuid.Parse(room); err != nil {
		t.Fatalf("link %q: fragment is not a room id", link)
	}
	return room
}

// visit is a Go visitor: request-join, answer the host's offer, send path.
func visit(url, room, path string) error {
	sc, err := signaling.Connect(url)
	if err != nil {
		return err
	}
	defer sc.Close()
	res, err := sc.RequestJoin(room)
	if err != nil || res != signaling.VisitorJoined {
		return errors.New("visitor not seated: " + res.String())
	}
	conn, err := peer.New(nil, sc)
	if err != nil {
		return err
	}
	defer conn.Close()
	dc, err := conn.SetupAsReceiver()
	if err != nil {
		return err
	}
	early := conn.Early()
	return transfer.SendFilesWithOptions(dc, []string{path}, "visitor", transfer.SendOptions{
		OnProgress: func(transfer.Progress) {},
		Messages:   early.Msgs,
		Closed:     early.Closed,
	})
}

// payload writes a random file and returns its path and digest.
func payload(t *testing.T, size int) (string, [32]byte) {
	t.Helper()
	b := make([]byte, size)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "drop.bin")
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return p, sha256.Sum256(b)
}

// checkNoToken fails if any line the harness printed carries a host token.
func checkNoToken(t *testing.T, h *harnessRun, tokens []string) {
	t.Helper()
	if len(tokens) == 0 {
		t.Fatal("the fake server saw no host token")
	}
	all := strings.Join(h.raws, "\n")
	for i, tok := range tokens {
		if tok == "" || strings.Contains(all, tok) {
			t.Fatalf("host token %d is empty or appears in the harness output", i)
		}
	}
}

func equalNames(got, want []string) bool {
	return strings.Join(got, ",") == strings.Join(want, ",")
}

// -block-shell-types reaches the receive: a .lnk from the visitor is saved as
// .lnk.floe-blocked with it and under its own name without it.
func TestRequestModeBlockShellTypesRenames(t *testing.T) {
	src := filepath.Join(t.TempDir(), "note.lnk")
	if err := os.WriteFile(src, []byte("not a shortcut"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		flags []string
		want  string
	}{
		{nil, "note.lnk"},
		{[]string{"-block-shell-types"}, "note.lnk.floe-blocked"},
	} {
		srv := newFakeRequestServer(t)
		out := t.TempDir()
		args := append([]string{"-server", srv.url, "-out", out, "-decide", "accept", "-timeout", "60s"}, tc.flags...)
		h := startRequest(t, args...)
		room := roomFromLink(t, h.until(t, "link")["link"].(string))
		visitErr := make(chan error, 1)
		go func() { visitErr <- visit(srv.url, room, src) }()
		h.until(t, "done")
		if code := h.exitCode(t); code != 0 {
			t.Fatalf("%v: exit %d, want 0", tc.flags, code)
		}
		if err := <-visitErr; err != nil {
			t.Fatalf("%v: visitor: %v", tc.flags, err)
		}
		entries, err := os.ReadDir(out)
		if err != nil || len(entries) != 1 || entries[0].Name() != tc.want {
			names := []string{}
			for _, e := range entries {
				names = append(names, e.Name())
			}
			t.Fatalf("%v: output %v (err %v), want [%s]", tc.flags, names, err, tc.want)
		}
	}
}

// The smoke path: link printed, a visitor joins, Decide accepts, one file is
// committed with its SHA-256 verified, the room is sealed and closed, and the
// run ends with done and exit 0. Every line is a JSON object and none holds
// the token.
func TestRequestModeDeliversThroughAFakeServer(t *testing.T) {
	srv := newFakeRequestServer(t)
	out := t.TempDir()
	path, sum := payload(t, 256*1024+13)
	h := startRequest(t, "-server", srv.url, "-out", out, "-decide", "accept", "-timeout", "60s")

	room := roomFromLink(t, h.until(t, "link")["link"].(string))
	visitErr := make(chan error, 1)
	go func() { visitErr <- visit(srv.url, room, path) }()

	done := h.until(t, "done")
	if code := h.exitCode(t); code != 0 {
		t.Fatalf("exit %d, want 0", code)
	}
	if err := <-visitErr; err != nil {
		t.Fatalf("visitor: %v", err)
	}
	if done["files"] != float64(1) || done["verified"] != float64(1) {
		t.Fatalf("done = %v, want files 1 verified 1", done)
	}
	want := []string{"joined", "link", "user-connected", "offer-sent", "sealed", "deciding", "accepted", "file-committed", "closed", "done"}
	if got := h.names(); !equalNames(got, want) {
		t.Fatalf("events %v, want %v", got, want)
	}
	for i, m := range h.seen {
		if _, ok := m["event"].(string); !ok {
			t.Fatalf("line %d is not an event object: %s", i, h.raws[i])
		}
	}
	tokens, badRoom, controls := srv.controlsAfter(2)
	checkNoToken(t, h, tokens)
	if badRoom || len(tokens) != 1 {
		t.Fatalf("host joins %d, badRoom %v: want one join with the derived room", len(tokens), badRoom)
	}
	if !equalNames(controls, []string{"request-seal", "request-close"}) {
		t.Fatalf("control frames %v", controls)
	}
	// A completed receive reports its bytes unless the stats URL is empty;
	// the harness's always is.
	if n := srv.statsRequests(); n != 0 {
		t.Fatalf("%d stats reports reached the server, want 0", n)
	}
	entries, err := os.ReadDir(out)
	if err != nil || len(entries) != 1 {
		t.Fatalf("output dir holds %d entries (err %v), want the one file", len(entries), err)
	}
	got, err := os.ReadFile(filepath.Join(out, entries[0].Name()))
	if err != nil || sha256.Sum256(got) != sum {
		t.Fatal("the committed file differs from what the visitor sent")
	}
}

// decline,accept with -keep-waiting: the first visitor is declined, the room
// is reopened, and the second visitor delivers.
func TestRequestModeKeepWaitingReopensAfterADecline(t *testing.T) {
	srv := newFakeRequestServer(t)
	out := t.TempDir()
	path, _ := payload(t, 64*1024)
	h := startRequest(t, "-server", srv.url, "-out", out, "-decide", "decline,accept", "-keep-waiting", "-timeout", "60s")

	room := roomFromLink(t, h.until(t, "link")["link"].(string))
	if err := visit(srv.url, room, path); err == nil {
		t.Fatal("the first visitor was not declined")
	}
	if r := h.until(t, "refused"); r["code"] != "declined" {
		t.Fatalf("refused = %v, want declined", r)
	}
	h.until(t, "reopened")
	if err := visit(srv.url, room, path); err != nil {
		t.Fatalf("second visitor: %v", err)
	}
	if d := h.until(t, "done"); d["files"] != float64(1) {
		t.Fatalf("done = %v", d)
	}
	if code := h.exitCode(t); code != 0 {
		t.Fatalf("exit %d", code)
	}
	_, _, controls := srv.controlsAfter(4)
	if !equalNames(controls, []string{"request-seal", "request-reopen", "request-seal", "request-close"}) {
		t.Fatalf("control frames %v", controls)
	}
}

// -corrupt-hash: the engine's own compare refuses the file, nothing stays in
// the output folder, and the run still closes the room and ends with done.
func TestRequestModeCorruptHashRefusesTheFile(t *testing.T) {
	srv := newFakeRequestServer(t)
	out := t.TempDir()
	path, _ := payload(t, 128*1024)
	h := startRequest(t, "-server", srv.url, "-out", out, "-corrupt-hash", "-timeout", "60s")

	room := roomFromLink(t, h.until(t, "link")["link"].(string))
	visitErr := make(chan error, 1)
	go func() { visitErr <- visit(srv.url, room, path) }()
	if r := h.until(t, "refused"); r["code"] != string(transfer.CodeHashMismatch) {
		t.Fatalf("refused = %v, want %s", r, transfer.CodeHashMismatch)
	}
	if d := h.until(t, "done"); d["files"] != float64(0) {
		t.Fatalf("done = %v, want no file", d)
	}
	if code := h.exitCode(t); code != 0 {
		t.Fatalf("exit %d", code)
	}
	var stopped *transfer.PeerStoppedError
	if err := <-visitErr; !errors.As(err, &stopped) || stopped.Code != transfer.CodeHashMismatch {
		t.Fatalf("visitor got %v, want a hash-mismatch stop", err)
	}
	if entries, _ := os.ReadDir(out); len(entries) != 0 {
		t.Fatalf("output dir holds %d entries after a refused file", len(entries))
	}
}

// -blip-after: the host socket drops right after the named event and the
// harness claims the room again with the same token; the drop continues on
// its data channel and request-close goes out on the new socket.
func TestRequestModeBlipReclaimsTheRoom(t *testing.T) {
	srv := newFakeRequestServer(t)
	out := t.TempDir()
	path, _ := payload(t, 64*1024)
	h := startRequest(t, "-server", srv.url, "-out", out, "-blip-after", "accepted", "-timeout", "60s")

	room := roomFromLink(t, h.until(t, "link")["link"].(string))
	visitErr := make(chan error, 1)
	go func() { visitErr <- visit(srv.url, room, path) }()
	h.until(t, "rejoined")
	if d := h.until(t, "done"); d["files"] != float64(1) {
		t.Fatalf("done = %v", d)
	}
	if code := h.exitCode(t); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if err := <-visitErr; err != nil {
		t.Fatalf("visitor: %v", err)
	}
	want := []string{"joined", "link", "user-connected", "offer-sent", "sealed", "deciding", "accepted", "blip", "rejoined", "file-committed", "closed", "done"}
	if got := h.names(); !equalNames(got, want) {
		t.Fatalf("events %v, want %v", got, want)
	}
	tokens, badRoom, controls := srv.controlsAfter(2)
	checkNoToken(t, h, tokens)
	if len(tokens) != 2 || tokens[0] != tokens[1] || badRoom {
		t.Fatalf("host joins %d (same token %v), badRoom %v", len(tokens), len(tokens) == 2 && tokens[0] == tokens[1], badRoom)
	}
	if !equalNames(controls, []string{"request-seal", "request-close"}) {
		t.Fatalf("control frames %v", controls)
	}
}
