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

// cliRun is one `floe send ...` through rootCmd.Execute, as main runs it.
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
	resetSharedFlags(t)
	to := sendCmd.Flags().Lookup("to")
	if err := to.Value.Set(""); err != nil {
		t.Fatal(err)
	}
	to.Changed = false
	sendCmd.SilenceErrors = false
	t.Cleanup(func() { sendCmd.SilenceErrors = false })
	t.Setenv("FLOE_NO_STATS", "1")
	rootCmd.SetOut(nil)
	rootCmd.SetErr(nil)
	rootCmd.SetArgs(append([]string{"send"}, args...))

	r := &cliRun{done: make(chan struct{})}
	go func() {
		defer close(r.done)
		r.err = rootCmd.Execute()
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

// linkFor is a request link on floe.one for a fresh room; the fake server
// never checks the id, and --server is always typed beside it.
func linkFor() string {
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
	wantInOrder(t, r.stdout, tlWaiting, tlNothingSave)
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

// TestSendToOtherServerLinkEndsWithoutANetworkCall is D-144.8's replacement
// for the card's TestSendToOtherServerLinkNeedsServerFlag: a link made on
// another server, with no --server and no FLOE_SERVER, ends on TL-10 before
// any network call, so neither api.floe.one nor any other server learns its
// room id. A server named either way lets the same link through.
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

	for _, c := range []struct {
		link   string
		chosen bool
		want   bool
	}{
		{other, false, true},
		{other, true, false},
		{"https://floe.one/r/Xk3p9Q0aB1c#" + room, false, false},
		{"https://WWW.floe.one/r/Xk3p9Q0aB1c#" + room, false, false},
		{"floe.one/r/Xk3p9Q0aB1c#" + room, false, false},
		{"https://floe.one.example.com/r/Xk3p9Q0aB1c#" + room, false, true},
		{"http://localhost:3000/r/Xk3p9Q0aB1c#" + room, false, true},
	} {
		if got := linkServerMismatch(c.link, c.chosen); got != c.want {
			t.Errorf("linkServerMismatch(%q, %v) = %v, want %v", c.link, c.chosen, got, c.want)
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
	wantOutcome(t, r, tlSetupFailed)
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

// TestWatchSetupReportsASeatTakenAsSetupSucceeds: a seat taken away at the
// moment the setup succeeds ends the setup on its reason, because the watcher
// has already closed the connection; with no event the channel comes back
// untouched, and an event after the answer closes nothing (review lens A,
// nit 10). No network: the setup is a func the test controls.
func TestWatchSetupReportsASeatTakenAsSetupSucceeds(t *testing.T) {
	type watch struct {
		roomFull, hostAbsent, disabled chan struct{}
		closed                         chan struct{}
		closeOnce                      sync.Once
	}
	newWatch := func() *watch {
		return &watch{
			roomFull: make(chan struct{}, 1), hostAbsent: make(chan struct{}, 1), disabled: make(chan struct{}, 1),
			closed: make(chan struct{}),
		}
	}
	run := func(w *watch, setup func() (*webrtc.DataChannel, error)) (*webrtc.DataChannel, string, error) {
		return watchSetup(w.roomFull, w.hostAbsent, w.disabled, func() { w.closeOnce.Do(func() { close(w.closed) }) }, setup)
	}
	open := &webrtc.DataChannel{}

	for _, event := range []string{"room-full", "host-absent", "disabled"} {
		w := newWatch()
		fire := map[string]chan struct{}{"room-full": w.roomFull, "host-absent": w.hostAbsent, "disabled": w.disabled}[event]
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
		fire = map[string]chan struct{}{"room-full": w.roomFull, "host-absent": w.hostAbsent, "disabled": w.disabled}[event]
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
			wantInOrder(t, r.stdout, tlWaiting, tlNothingSave)
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
		opts.Messages != early.Msgs || opts.Closed != early.Closed || opts.Stop != (<-chan struct{})(stop) || !opts.EndBarLine {
		t.Fatalf("sendToOptions = %+v; want the visitor's clock, RequireReceived, NoSummary, Ctrl+C's stop, EndBarLine and the connection's pump", opts)
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
