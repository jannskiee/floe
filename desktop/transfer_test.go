package main

// The pieces of a send or a receive that need no peer (transfer.go): the
// text-send staging file and the relay gate behind Hide my IP. Below them, the
// request drop (runRequestDrop) against an in-process visitor.

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/jannskiee/floe/cli/engine/transfer"
)

// TestWriteTextTemp verifies the text-send staging: exact content round-trip,
// the fixed message.txt name the receiver will see, and cleanup removing the
// temp directory.
func TestWriteTextTemp(t *testing.T) {
	const text = "hello floe\nline two · unicode ✓"

	path, cleanup, err := writeTextTemp(text)
	if err != nil {
		t.Fatalf("writeTextTemp: %v", err)
	}

	if got := filepath.Base(path); got != "message.txt" {
		t.Errorf("file name = %q, want message.txt", got)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != text {
		t.Errorf("content = %q, want %q", got, text)
	}

	cleanup()
	if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
		t.Errorf("cleanup did not remove the temp dir")
	}
}

// TestRequireRelay pins the transfer-time half of issue #281. Hide my IP forces
// the relay path, so without a TURN URL in the list the attempt gathers no
// usable candidate and dies about thirty seconds later as a generic timeout,
// which errors.ts turns into advice about both devices being online.
//
// The first case is the one a careless implementation breaks: a STUN-only
// server is a perfectly good server when the switch is off, and must not be
// refused.
func TestRequireRelay(t *testing.T) {
	cases := []struct {
		name      string
		hideIP    bool
		hasRelay  bool
		degraded  bool
		wantError error
	}{
		{"a relay-less server is fine with the switch off", false, false, false, nil},
		{"a relay-less server is refused with the switch on", true, false, false, errNoRelay},
		{"a relay-capable server is fine with the switch on", true, true, false, nil},
		{"a relay-capable server is fine with the switch off", false, true, false, nil},
		// The list this side is holding is the STUN-only fallback, so "no relay"
		// is this side's guess rather than the server's answer. Blaming the
		// server's configuration would be a confident guess at a wrong cause,
		// and the usual causes (a wrong address, an un-proxied /api/, the TURN
		// endpoint's rate limiter) are all things the reader can act on.
		{"a list that could not be read does not blame the server", true, false, true, errRelayUnknown},
		// Degraded but a relay somehow present cannot happen through
		// ice.FetchDetail today, since the fallback is STUN only. Pinned so a
		// future fallback with a relay in it does not silently start refusing.
		{"degraded is irrelevant once a relay is in the list", true, true, true, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := requireRelay(tc.hideIP, tc.hasRelay, tc.degraded)
			if !errors.Is(err, tc.wantError) {
				t.Fatalf("requireRelay(%v, %v, %v) = %v, want %v",
					tc.hideIP, tc.hasRelay, tc.degraded, err, tc.wantError)
			}
			if err == nil {
				return
			}
			// The message has to name the switch, or it is the same
			// unactionable failure in different words.
			if !strings.Contains(err.Error(), "Hide my IP") {
				t.Errorf("error %q does not name the setting to turn off", err)
			}
			// errors.ts matches on this clause to pass the sentence through
			// verbatim; see its PASSTHROUGH list.
			if !strings.Contains(err.Error(), "needs a TURN relay") {
				t.Errorf("error %q lost the clause errors.ts anchors on", err)
			}
		})
	}
}

// requestLinkPasteLinks are the browser-only link shapes a person may paste
// into Receive > CODE by mistake: request links on floe.one, on the local dev
// pair and on a self-hosted base path, and the Stage 2 drop shapes. Resolving
// them is local (a URL path match), so these tests make no network call.
var requestLinkPasteLinks = []string{
	"https://floe.one/r/Xk3p9Q0aB1c#6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f",
	"http://localhost:3000/r/Xk3p9Q0aB1c#6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f",
	"https://files.example.com/floe/r/Xk3p9Q0aB1c/#6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f",
	"https://floe.one/d/aBcD1234#k=s3cr3t",
	"https://floe.one/drop/aBcD1234",
}

// TestReceiveByCodeMapsRequestLink: a pasted request or drop link comes back as
// the one approved sentence (CP2), not as "could not resolve" wrapped around
// the pasted text, which quoted the link, room id included, into the status
// line.
func TestReceiveByCodeMapsRequestLink(t *testing.T) {
	const cp2 = "That is a request link for sending files to someone. Open it in a web browser."
	for _, link := range requestLinkPasteLinks {
		a := &App{wake: &wakeGuard{}, notifyFn: func(string, string) {}}
		_, err := a.ReceiveByCode(link, t.TempDir(), false, false)
		if err == nil {
			t.Fatalf("%s: ReceiveByCode succeeded", link)
		}
		if err.Error() != cp2 {
			t.Errorf("%s: error = %q, want the CP2 sentence", link, err.Error())
		}
		if strings.Contains(err.Error(), "aBcD1234") || strings.Contains(err.Error(), "Xk3p9Q0aB1c") || strings.Contains(err.Error(), "6f1c2b9e") {
			t.Errorf("%s: the error quotes the pasted link: %q", link, err.Error())
		}
	}
}

// TestReceiveByCodeRequestLinkSendsNoToast: a pasted request link is a mix-up
// the status line explains, not a failed transfer, so the "receive failed"
// toast must not fire for it.
func TestReceiveByCodeRequestLinkSendsNoToast(t *testing.T) {
	var got []string
	a := &App{wake: &wakeGuard{}, notifyFn: func(title, body string) { got = append(got, title+"|"+body) }}
	for _, link := range requestLinkPasteLinks {
		if _, err := a.ReceiveByCode(link, t.TempDir(), false, false); err == nil {
			t.Fatalf("%s: ReceiveByCode succeeded", link)
		}
	}
	if len(got) != 0 {
		t.Errorf("pasted request links toasted %d times: %v", len(got), got)
	}
}

// ---- The request drop (S1-DSK-03b): runRequestDrop over real pion ---------
//
// Every test below pairs the lane with an in-process visitor through the fake
// signaling server of requestlink_test.go, over real pion on this machine:
// the fake's ICE list is one STUN URL on the loopback discard port, so no test
// reaches a public server, and its stats endpoint only counts. The visitor is
// either the real engine sender or a raw one that writes wire frames itself.

// pairingFake is a fake server whose ICE list keeps every pairing on this
// machine.
func pairingFake(t *testing.T) *fakeSignalServer {
	t.Helper()
	f := newFakeSignalServer(t)
	f.set(func(f *fakeSignalServer) { f.turnBody = `[{"urls":"stun:127.0.0.1:9"}]` })
	return f
}

// dropApp is a lane on a pairing fake with a link waiting. before runs on the
// App before Make link, while no lane goroutine exists yet, so a test can set
// a switch or a seam there without racing the lane.
func dropApp(t *testing.T, before func(a *App)) (a *App, rec *snapRecorder, f *fakeSignalServer, room, base string) {
	t.Helper()
	f = pairingFake(t)
	a, rec = laneApp(t, f)
	if before != nil {
		before(a)
	}
	base = filepath.Join(t.TempDir(), "Floe requests")
	a.MakeRequestLink("Acme footage", base, "24h")
	s := waitState(t, a, 10*time.Second, "waiting")
	i := strings.Index(s.Link, "#")
	if i < 0 {
		t.Fatal("the link carries no room")
	}
	return a, rec, f, s.Link[i+1:], base
}

// testVisitor is the other end of a drop: a request-join socket, then a peer
// connection that answers the host's offer. The data channel is reached only
// through closures, so no pion type is named here (see requireRelay).
type testVisitor struct {
	sc        *signaling.Client
	conn      *peer.Connection
	early     *peer.Early
	sendText  func(string) error
	sendBin   func([]byte) error
	sendFiles func(paths []string, o transfer.SendOptions) error
}

// joinVisitor takes the visitor seat of room.
func joinVisitor(t *testing.T, f *fakeSignalServer, room string) *testVisitor {
	t.Helper()
	sc, err := signaling.Connect(f.url())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sc.Close)
	if res, _ := sc.RequestJoin(room); res != signaling.VisitorJoined {
		t.Fatalf("request-join: %s", res)
	}
	return &testVisitor{sc: sc}
}

// connectAsync answers the host's offer on its own goroutine; the channel
// carries the setup's error, nil once the data channel is open.
func (v *testVisitor) connectAsync(t *testing.T) <-chan error {
	out := make(chan error, 1)
	conn, err := peer.New(nil, v.sc)
	if err != nil {
		out <- err
		return out
	}
	t.Cleanup(conn.Close)
	v.conn = conn
	go func() {
		dc, err := conn.SetupAsReceiver()
		if err != nil {
			out <- err
			return
		}
		v.early = conn.Early()
		v.sendText = dc.SendText
		v.sendBin = dc.Send
		v.sendFiles = func(paths []string, o transfer.SendOptions) error {
			o.Messages, o.Closed = v.early.Msgs, v.early.Closed
			return transfer.SendFilesWithOptions(dc, paths, "visitor", o)
		}
		out <- nil
	}()
	return out
}

// connect answers the offer and waits for the data channel.
func (v *testVisitor) connect(t *testing.T) {
	t.Helper()
	select {
	case err := <-v.connectAsync(t):
		if err != nil {
			t.Fatalf("the visitor could not connect: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("the host never offered")
	}
}

// leave closes the visitor's peer connection, then its socket.
func (v *testVisitor) leave() {
	if v.conn != nil {
		v.conn.Close()
	}
	v.sc.Close()
}

// frame waits for the host's next data channel frame.
func (v *testVisitor) frame(t *testing.T, d time.Duration) (data []byte, isString bool) {
	t.Helper()
	select {
	case m := <-v.early.Msgs:
		return m.Data, m.IsString
	case <-time.After(d):
		t.Fatal("no frame from the host")
	}
	return nil, false
}

// frameOfType waits for the host's next frame whose JSON type is typ and
// returns its fields.
func (v *testVisitor) frameOfType(t *testing.T, typ string, d time.Duration) map[string]any {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		data, _ := v.frame(t, time.Until(deadline))
		var m map[string]any
		if json.Unmarshal(data, &m) == nil && m["type"] == typ {
			return m
		}
	}
	t.Fatalf("no %s frame from the host", typ)
	return nil
}

// metaFrame is one metadata frame as a sender writes it.
func metaFrame(index, total int, name string, size, totalBytes int64) string {
	b, _ := json.Marshal(map[string]any{
		"type": "metadata", "id": fmt.Sprintf("f-%d", index), "fileName": name, "fileSize": size,
		"index": index, "total": total, "totalBytes": totalBytes,
		"pv": transfer.ProtocolVersion, "pvMin": transfer.MinProtocolVersion, "ver": "visitor",
	})
	return string(b)
}

// endFrame is the end of a file whose bytes are data, with their SHA-256.
func endFrame(data []byte) string {
	sum := sha256.Sum256(data)
	return `{"type":"end","sha256":"` + hex.EncodeToString(sum[:]) + `"}`
}

// deciding waits for the prompt.
func deciding(t *testing.T, a *App) RequestLinkSnapshot {
	t.Helper()
	return waitState(t, a, 15*time.Second, "deciding")
}

// acceptNext waits for the prompt and accepts it.
func acceptNext(t *testing.T, a *App) RequestLinkSnapshot {
	t.Helper()
	s := deciding(t, a)
	a.AnswerRequest(s.PromptGen, "accept")
	return s
}

// waitSnap waits until the lane is in state with code.
func waitSnap(t *testing.T, a *App, d time.Duration, state, code string) RequestLinkSnapshot {
	t.Helper()
	waitFor(t, d, state+" "+code, func() bool {
		s := stateOf(a)
		return s.State == state && s.Code == code
	})
	return stateOf(a)
}

// writeFiles writes name to content under dir and returns the paths.
func writeFiles(t *testing.T, dir string, files map[string][]byte) []string {
	t.Helper()
	var paths []string
	for name, data := range files {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, data, 0o600); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, p)
	}
	sort.Strings(paths)
	return paths
}

// treeUnder lists every path under dir, relative, or nothing when dir is
// missing.
func treeUnder(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || p == dir {
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	return out
}

func randomBytes(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}

func TestRunRequestDropEndToEndVerified(t *testing.T) {
	a, _, f, room, _ := dropApp(t, nil)
	src := t.TempDir()
	files := map[string][]byte{"a.txt": randomBytes(t, 10<<10), "b.bin": randomBytes(t, 300<<10), "c.txt": randomBytes(t, 1<<10)}
	paths := writeFiles(t, src, files)
	v := joinVisitor(t, f, room)
	v.connect(t)
	sent := make(chan error, 1)
	go func() { sent <- v.sendFiles(paths, transfer.SendOptions{AckTimeout: time.Minute}) }()
	acceptNext(t, a)
	select {
	case err := <-sent:
		if err != nil {
			t.Fatalf("the visitor's send: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the send did not finish")
	}
	v.leave()
	s := waitState(t, a, 15*time.Second, "done")
	var total int64
	for _, b := range files {
		total += int64(len(b))
	}
	r := s.Result
	if r == nil || r.Files != 3 || r.Saved != 3 || r.Verified != 3 || r.Bytes != total || r.Renamed != 0 || len(r.Names) != 3 {
		t.Fatalf("result %+v, want 3 files, 3 saved, 3 verified, %d bytes", r, total)
	}
	for name, want := range files {
		got, err := os.ReadFile(filepath.Join(r.Folder, name))
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("%s did not arrive intact: %v", name, err)
		}
	}
}

func TestRunRequestDropFetchesICEAtUserConnected(t *testing.T) {
	a, _, f, room, _ := dropApp(t, nil)
	turn := func() int {
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.turnHits
	}
	if n := turn(); n != 0 {
		t.Fatalf("Make link fetched ICE %d times", n)
	}
	for i := 1; i <= 2; i++ {
		v := joinVisitor(t, f, room)
		v.connect(t)
		if n := turn(); n != i {
			t.Fatalf("pairing %d: %d ICE fetches, want %d", i, n, i)
		}
		v.leave()
		waitSnap(t, a, 5*time.Second, "waiting", "visitor-left")
		waitFor(t, 5*time.Second, "the room to reopen", f.roomOpen)
	}
}

func TestRunRequestDropStalePeerLeftDoesNotAbortNextSetup(t *testing.T) {
	a, _, f, room, _ := dropApp(t, func(a *App) {
		l := a.lane()
		pair := l.pairFn
		l.pairFn = func(rg uint64, sc *signaling.Client) {
			// A previous visitor's leave, still buffered when the next one
			// arrives.
			select {
			case sc.PeerLeft <- struct{}{}:
			default:
			}
			pair(rg, sc)
		}
	})
	v := joinVisitor(t, f, room)
	v.connect(t)
	v.sendText(metaFrame(1, 1, "a.txt", 4, 4))
	if s := deciding(t, a); s.Prompt == nil || s.Prompt.Files != 1 {
		t.Fatalf("prompt %+v", s.Prompt)
	}
}

// TestRunRequestDropVisitorLeftDuringSetupReopensAtOnce (S1-ENG-11, and D-116
// inside the pairing window): the visitor leaves after the host's offer was
// relayed and before any data channel exists. The server had both seats
// signal, so the room it sealed must be reopened, and the link waits again
// within 2 s rather than after the 30 s connect timeout, with no W11 line.
func TestRunRequestDropVisitorLeftDuringSetupReopensAtOnce(t *testing.T) {
	a, _, f, room, _ := dropApp(t, nil)
	v := joinVisitor(t, f, room)
	waitFor(t, 10*time.Second, "the host's offer", func() bool { return len(v.sc.Signal) > 0 })
	start := time.Now()
	v.sc.Close()
	waitSnap(t, a, 5*time.Second, "waiting", "visitor-left")
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("the link waited again after %v, want under 2 s", d)
	}
	waitFor(t, 5*time.Second, "request-reopen", func() bool { return f.count("request-reopen") >= 1 })
	if n := f.count("request-seal"); n != 0 {
		t.Fatalf("%d request-seal frames for a setup that never opened a channel", n)
	}
}

// TestRunRequestDropReloadDuringSetupKeepsNewVisitor (review 2a F1, probe
// R1): the visitor reloads the /r page while the host fetches ICE, so the old
// socket's leave and the reloaded page's user-connected are both queued when
// the fetch returns. The new visitor keeps its seat: no reopen evicts it with
// room-full, it gets the host's offer, and its request reaches the prompt.
func TestRunRequestDropReloadDuringSetupKeepsNewVisitor(t *testing.T) {
	a, _, f, room, _ := dropApp(t, nil)
	block := make(chan struct{})
	var once sync.Once
	unblock := func() {
		once.Do(func() {
			f.set(func(f *fakeSignalServer) { f.block = nil })
			close(block)
		})
	}
	t.Cleanup(unblock)
	f.set(func(f *fakeSignalServer) { f.block = block })
	v1 := joinVisitor(t, f, room)
	waitFor(t, 5*time.Second, "the host's ICE fetch", func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.turnHits == 1
	})
	v1.sc.Close() // the reload: the old page's socket goes
	waitFor(t, 5*time.Second, "the seat to free", func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.visitor == nil
	})
	v2 := joinVisitor(t, f, room) // the reloaded page takes the seat
	_, _, sc := laneHandles(a)
	waitFor(t, 5*time.Second, "the leave and the new seat, both queued", func() bool {
		return len(sc.PeerLeft) == 1 && len(sc.PeerConnected) == 1
	})
	unblock()
	v2.connect(t)
	v2.sendText(metaFrame(1, 1, "a.txt", 4, 4))
	s := deciding(t, a)
	select {
	case <-v2.sc.RoomFull:
		t.Fatal("the reloaded visitor was evicted with room-full")
	default:
	}
	if n := f.count("request-reopen"); n != 0 {
		t.Fatalf("%d request-reopen frames while the new visitor held the seat", n)
	}
	a.AnswerRequest(s.PromptGen, "decline")
	waitState(t, a, 5*time.Second, "declined")
}

// TestRunRequestDropLeaveDuringFetchReopensBeforeOffer (review 2a F1): a
// visitor who leaves while the host fetches ICE, with nobody taking the seat,
// reopens the room at once, before any offer goes to nobody.
func TestRunRequestDropLeaveDuringFetchReopensBeforeOffer(t *testing.T) {
	a, _, f, room, _ := dropApp(t, nil)
	block := make(chan struct{})
	var once sync.Once
	unblock := func() {
		once.Do(func() {
			f.set(func(f *fakeSignalServer) { f.block = nil })
			close(block)
		})
	}
	t.Cleanup(unblock)
	f.set(func(f *fakeSignalServer) { f.block = block })
	v := joinVisitor(t, f, room)
	waitFor(t, 5*time.Second, "the host's ICE fetch", func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return f.turnHits == 1
	})
	v.sc.Close()
	_, _, sc := laneHandles(a)
	waitFor(t, 5*time.Second, "the leave to queue", func() bool { return len(sc.PeerLeft) == 1 })
	unblock()
	waitSnap(t, a, 5*time.Second, "waiting", "visitor-left")
	waitFor(t, 5*time.Second, "request-reopen", func() bool { return f.count("request-reopen") >= 1 })
	f.mu.Lock()
	offers := f.hostSignals
	f.mu.Unlock()
	if offers != 0 {
		t.Fatalf("%d signals left the host for a visitor who was gone", offers)
	}
}

func TestRunRequestDropVisitorLeavesWhileDecidingReopens(t *testing.T) {
	a, _, f, room, base := dropApp(t, nil)
	v := joinVisitor(t, f, room)
	v.connect(t)
	v.sendText(metaFrame(1, 1, "a.txt", 4, 4))
	deciding(t, a)
	start := time.Now()
	v.leave()
	waitSnap(t, a, 5*time.Second, "waiting", "visitor-left")
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("the link waited again after %v, want under 2 s", d)
	}
	if got := treeUnder(t, base); len(got) != 0 {
		t.Fatalf("the save base holds %q after a request nobody accepted", got)
	}
	waitFor(t, 5*time.Second, "request-reopen", func() bool { return f.count("request-reopen") >= 1 })
}

func TestRunRequestDropVisitorLeavesBeforeMetadataReopens(t *testing.T) {
	// The E-35 timer is shortened only to prove it is cancelled, and kept well
	// above the time the host takes to see the channel close: at 400 ms it beat
	// that close in 1 of 40 runs under -count=40 (the lane then said
	// setup-failed), where production gives it 30 s.
	const openTimer = 3 * time.Second
	var fired *atomic.Int32
	a, _, f, room, base := dropApp(t, func(a *App) {
		setVar(t, &requestOpenChannelTimeout, openTimer)
		fired = countOpenChannelExpiries(t)
	})
	v := joinVisitor(t, f, room)
	v.connect(t)
	v.leave()
	waitFor(t, 5*time.Second, "the link to wait again", func() bool { return stateOf(a).State == "waiting" })
	if s := stateOf(a); s.Code != "visitor-left" {
		t.Fatalf("the link waits again with code %q, want visitor-left (open-channel timer fired %d times)", s.Code, fired.Load())
	}
	waitFor(t, 5*time.Second, "request-reopen", func() bool { return f.count("request-reopen") >= 1 })
	if got := treeUnder(t, base); len(got) != 0 {
		t.Fatalf("the save base holds %q", got)
	}
	time.Sleep(openTimer + 500*time.Millisecond)
	if n := fired.Load(); n != 0 {
		t.Fatalf("the open-channel timer fired %d times after the visitor left", n)
	}
}

func TestRunRequestDropSealsAtChannelOpen(t *testing.T) {
	a, _, f, room, _ := dropApp(t, nil)
	v := joinVisitor(t, f, room)
	waitFor(t, 10*time.Second, "the host's offer", func() bool { return len(v.sc.Signal) > 0 })
	if n := f.count("request-seal"); n != 0 {
		t.Fatalf("request-seal before any data channel (%d)", n)
	}
	v.connect(t)
	waitFor(t, 5*time.Second, "request-seal", func() bool { return f.count("request-seal") == 1 })
	v.sendText(metaFrame(1, 1, "a.txt", 4, 4))
	s := deciding(t, a)
	if n := f.count("request-seal"); n != 1 {
		t.Fatalf("%d request-seal frames by the prompt, want exactly 1 before any ack", n)
	}
	a.AnswerRequest(s.PromptGen, "decline")
	waitState(t, a, 5*time.Second, "declined")
}

func TestRunRequestDropSetupFailureReopens(t *testing.T) {
	a, rec, f, room, _ := dropApp(t, nil)
	v := joinVisitor(t, f, room)
	waitFor(t, 10*time.Second, "the host's offer", func() bool { return len(v.sc.Signal) > 0 })
	hostile := "v=0 $(calc) ]]><x \u202egnp.exe " + strings.Repeat("A", 5000)
	_ = v.sc.SendSignal(map[string]string{"type": "answer", "sdp": hostile})
	waitSnap(t, a, 5*time.Second, "waiting", "setup-failed")
	waitFor(t, 5*time.Second, "request-reopen", func() bool { return f.count("request-reopen") >= 1 })
	if n := f.count("request-seal"); n != 0 {
		t.Fatalf("%d request-seal frames for a failed setup", n)
	}
	for _, js := range rec.allRaw() {
		for _, h := range []string{"calc", "]]>", "\u202e", "AAAAAAAA", "remote description"} {
			if strings.Contains(js, h) {
				t.Fatalf("an event carries %q from the hostile SDP or its error", h)
			}
		}
	}
}

func TestRunRequestDropDeclineCreatesNothing(t *testing.T) {
	a, _, f, room, base := dropApp(t, nil)
	paths := writeFiles(t, t.TempDir(), map[string][]byte{"a.txt": []byte("abcd")})
	v := joinVisitor(t, f, room)
	v.connect(t)
	sent := make(chan error, 1)
	go func() { sent <- v.sendFiles(paths, transfer.SendOptions{AckTimeout: time.Minute}) }()
	s := deciding(t, a)
	a.AnswerRequest(s.PromptGen, "decline")
	var err error
	select {
	case err = <-sent:
	case <-time.After(15 * time.Second):
		t.Fatal("the send did not end")
	}
	var ps *transfer.PeerStoppedError
	if !errors.As(err, &ps) || ps.Code != transfer.CodeDeclined {
		t.Fatalf("the visitor got %v, want the declined code", err)
	}
	waitState(t, a, 5*time.Second, "declined")
	if got := treeUnder(t, base); len(got) != 0 {
		t.Fatalf("a declined drop left %q", got)
	}
}

func TestRunRequestDropAcceptCreatesExclusiveSubfolder(t *testing.T) {
	clock := time.Date(2026, 9, 14, 14, 5, 30, 0, time.Local)
	a, _, f, room, base := dropApp(t, func(a *App) {
		l := a.lane()
		l.mu.Lock()
		l.now = func() time.Time { return clock }
		l.mu.Unlock()
	})
	taken := filepath.Join(base, "Acme footage 2026-09-14 1405")
	if err := os.MkdirAll(taken, 0o755); err != nil {
		t.Fatal(err)
	}
	paths := writeFiles(t, t.TempDir(), map[string][]byte{"a.txt": []byte("abcd")})
	v := joinVisitor(t, f, room)
	v.connect(t)
	sent := make(chan error, 1)
	go func() { sent <- v.sendFiles(paths, transfer.SendOptions{AckTimeout: time.Minute}) }()
	s := deciding(t, a)
	if got := treeUnder(t, base); len(got) != 1 || got[0] != "Acme footage 2026-09-14 1405" {
		t.Fatalf("before Accept the base holds %q", got)
	}
	if want := filepath.Join("Floe requests", "Acme footage 2026-09-14 1405"); s.Prompt.Folder != want {
		t.Fatalf("prompt folder %q, want %q", s.Prompt.Folder, want)
	}
	a.AnswerRequest(s.PromptGen, "accept")
	if err := <-sent; err != nil {
		t.Fatalf("the visitor's send: %v", err)
	}
	v.leave()
	d := waitState(t, a, 15*time.Second, "done")
	if want := taken + " (2)"; d.Result == nil || d.Result.Folder != want {
		t.Fatalf("drop folder %+v, want %q", d.Result, want)
	}
	if got, err := os.ReadFile(filepath.Join(taken+" (2)", "a.txt")); err != nil || string(got) != "abcd" {
		t.Fatalf("the file is not in the exclusive folder: %v", err)
	}
	if got := treeUnder(t, taken); len(got) != 0 {
		t.Fatalf("the existing folder was written to: %q", got)
	}
}

func TestRunRequestDropIgnoresPeerLeftAfterChannelOpen(t *testing.T) {
	a, _, f, room, _ := dropApp(t, nil)
	v := joinVisitor(t, f, room)
	v.connect(t)
	data := []byte("abcd")
	v.sendText(metaFrame(1, 1, "a.txt", 4, 4))
	acceptNext(t, a)
	v.frameOfType(t, "ack", 10*time.Second)
	f.peerDisconnected() // the visitor's socket blinked; its channel did not
	time.Sleep(200 * time.Millisecond)
	if st := stateOf(a).State; st != "receiving" {
		t.Fatalf("a peer-disconnected after the channel opened moved the drop to %q", st)
	}
	v.sendBin(data)
	v.sendText(endFrame(data))
	v.frameOfType(t, "received", 10*time.Second)
	v.leave()
	if s := waitState(t, a, 15*time.Second, "done"); s.Result == nil || s.Result.Saved != 1 {
		t.Fatalf("result %+v", s.Result)
	}
}

func TestRunRequestDropCancelSendsStopped(t *testing.T) {
	a, _, f, room, base := dropApp(t, nil)
	v := joinVisitor(t, f, room)
	v.connect(t)
	one, two := []byte("first file"), randomBytes(t, 64<<10)
	total := int64(len(one) + len(two))
	v.sendText(metaFrame(1, 2, "one.txt", int64(len(one)), total))
	acceptNext(t, a)
	v.frameOfType(t, "ack", 10*time.Second)
	v.sendBin(one)
	v.sendText(endFrame(one))
	v.sendText(metaFrame(2, 2, "two.bin", int64(len(two)), total))
	v.frameOfType(t, "ack", 10*time.Second) // file 1 is committed before this ack
	v.sendBin(two[:1<<10])
	time.Sleep(100 * time.Millisecond)
	a.CancelRequestDrop()
	stop := v.frameOfType(t, "incompatible", 10*time.Second)
	if stop["code"] != "stopped" {
		t.Fatalf("the visitor got code %v, want stopped", stop["code"])
	}
	s := waitSnap(t, a, 15*time.Second, "stopped", "stopped")
	if s.Result == nil || s.Result.Saved != 1 {
		t.Fatalf("result %+v, want the committed file counted", s.Result)
	}
	if got, err := os.ReadFile(filepath.Join(s.Result.Folder, "one.txt")); err != nil || !bytes.Equal(got, one) {
		t.Fatalf("the committed file is gone: %v", err)
	}
	for _, p := range treeUnder(t, base) {
		if strings.HasSuffix(p, ".part") || strings.Contains(p, "two.bin") {
			t.Fatalf("the cancelled file left %q", p)
		}
	}
}

func TestRunRequestDropStatsFollowReportStats(t *testing.T) {
	for _, on := range []bool{false, true} {
		t.Run(fmt.Sprintf("reportStats=%v", on), func(t *testing.T) {
			a, _, f, room, _ := dropApp(t, func(a *App) { a.cfg.ReportStats = on })
			data := randomBytes(t, 20<<10)
			paths := writeFiles(t, t.TempDir(), map[string][]byte{"a.bin": data})
			v := joinVisitor(t, f, room)
			v.connect(t)
			sent := make(chan error, 1)
			go func() { sent <- v.sendFiles(paths, transfer.SendOptions{AckTimeout: time.Minute}) }()
			acceptNext(t, a)
			if err := <-sent; err != nil {
				t.Fatalf("the visitor's send: %v", err)
			}
			v.leave()
			waitState(t, a, 15*time.Second, "done")
			f.mu.Lock()
			posts := append([]string(nil), f.statsPosts...)
			f.mu.Unlock()
			want := 0
			if on {
				want = 1
			}
			if len(posts) != want {
				t.Fatalf("%d stats reports, want %d", len(posts), want)
			}
			if on && posts[0] != fmt.Sprintf(`{"bytes":%d}`, len(data)) {
				t.Fatalf("stats report %q, want the drop's %d bytes", posts[0], len(data))
			}
		})
	}
}

// TestRunRequestDropPromptNeverCarriesFirstName (OD-04): the first file's name
// is the visitor's words, and no lane event before Accept carries it.
func TestRunRequestDropPromptNeverCarriesFirstName(t *testing.T) {
	a, rec, f, room, _ := dropApp(t, nil)
	v := joinVisitor(t, f, room)
	v.connect(t)
	v.sendText(metaFrame(1, 2, "Call +1 555 0100 to confirm.txt", 4, 8))
	s := deciding(t, a)
	if s.Prompt == nil || s.Prompt.Files != 2 || s.Prompt.TotalBytes != 8 {
		t.Fatalf("prompt %+v", s.Prompt)
	}
	for _, js := range rec.allRaw() {
		if strings.Contains(js, "555 0100") || strings.Contains(js, "Call +1") {
			t.Fatal("a lane event carries the visitor's first file name")
		}
	}
	a.AnswerRequest(s.PromptGen, "decline")
	waitState(t, a, 5*time.Second, "declined")
}

func TestRunRequestDropRemovesEmptySubfolderOnEarlyStop(t *testing.T) {
	a, _, f, room, base := dropApp(t, nil)
	v := joinVisitor(t, f, room)
	v.connect(t)
	v.sendText(metaFrame(1, 1, "a.txt", 4, 4))
	acceptNext(t, a)
	v.frameOfType(t, "ack", 10*time.Second)
	v.leave() // after Accept, before a byte
	waitState(t, a, 15*time.Second, "stopped")
	if got := treeUnder(t, base); len(got) != 0 {
		t.Fatalf("an early stop left %q under the save base", got)
	}
}

// TestRunRequestDropMapsErrorsToFixedCodes (E-42): every way a drop can fail
// reaches the owner as a fixed code, never as the peer's words, pion's SDP
// error or an OS error, and the pairing spike's hostile metadata is refused
// before any folder exists.
func TestRunRequestDropMapsErrorsToFixedCodes(t *testing.T) {
	hostileReason := "$(calc) ]]><x \u202egnp.exe " + strings.Repeat("R", 5000)
	scan := func(t *testing.T, rec *snapRecorder, bad ...string) {
		t.Helper()
		for _, js := range rec.allRaw() {
			for _, h := range bad {
				if strings.Contains(js, h) {
					t.Fatalf("an event carries %q", h)
				}
			}
		}
	}
	// A sender's abort frame fits the 1,000-byte control cap (the engine's
	// incompatibleFrame shrinks the reason to fit), so the within-cap hostile
	// reason is the abort; the 5,000-character one is prose the engine refuses
	// as an oversize control message, which no peer abort explains.
	for _, c := range []struct {
		name, reason, code string
	}{
		{"hostile reason after Accept is peer-abort", "$(calc) ]]><x \u202egnp.exe " + strings.Repeat("R", 600), "peer-abort"},
		{"5000-character reason after Accept is unknown", hostileReason, "unknown"},
	} {
		t.Run(c.name, func(t *testing.T) {
			a, rec, f, room, _ := dropApp(t, nil)
			v := joinVisitor(t, f, room)
			v.connect(t)
			v.sendText(metaFrame(1, 1, "a.txt", 4, 4))
			acceptNext(t, a)
			v.frameOfType(t, "ack", 10*time.Second)
			b, _ := json.Marshal(map[string]any{"type": "incompatible", "reason": c.reason, "pv": 1, "pvMin": 1})
			v.sendText(string(b))
			waitSnap(t, a, 15*time.Second, "stopped", c.code)
			scan(t, rec, "calc", "]]>", "\u202e", "RRRRRRRR")
		})
	}
	t.Run("hostile SDP is setup-failed", func(t *testing.T) {
		a, rec, f, room, _ := dropApp(t, nil)
		v := joinVisitor(t, f, room)
		waitFor(t, 10*time.Second, "the host's offer", func() bool { return len(v.sc.Signal) > 0 })
		_ = v.sc.SendSignal(map[string]string{"type": "answer", "sdp": hostileReason})
		waitSnap(t, a, 5*time.Second, "waiting", "setup-failed")
		scan(t, rec, "calc", "]]>", "\u202e", "RRRRRRRR")
	})
	t.Run("bare close after Accept is unknown", func(t *testing.T) {
		a, rec, f, room, _ := dropApp(t, nil)
		v := joinVisitor(t, f, room)
		v.connect(t)
		v.sendText(metaFrame(1, 1, "a.txt", 1<<20, 1<<20))
		acceptNext(t, a)
		v.frameOfType(t, "ack", 10*time.Second)
		v.sendBin(make([]byte, 1<<10))
		time.Sleep(100 * time.Millisecond)
		v.leave()
		waitSnap(t, a, 15*time.Second, "stopped", "unknown")
		scan(t, rec, "closed mid-transfer", "connection closed")
	})
	for _, fx := range []struct{ name, meta string }{
		{"F2 path 40 levels", metaFrame(1, 1, strings.Repeat("d/", 40)+"f.txt", 4, 4)},
		{"F4b absolute Windows path", metaFrame(1, 1, `C:\Windows\System32\evil.dll`, 4, 4)},
		{"F6 704-byte name", metaFrame(1, 1, strings.Repeat("n", 700)+".txt", 4, 4)},
	} {
		t.Run(fx.name+" is refused before the prompt", func(t *testing.T) {
			a, rec, f, room, base := dropApp(t, nil)
			v := joinVisitor(t, f, room)
			v.connect(t)
			v.sendText(fx.meta)
			s := waitSnap(t, a, 15*time.Second, "stopped", "path-too-long")
			if s.Result != nil && s.Result.Saved != 0 {
				t.Fatalf("result %+v", s.Result)
			}
			for _, snap := range rec.all() {
				if snap.State == "deciding" {
					t.Fatal("the owner was asked about a path the receiver refuses")
				}
			}
			if got := treeUnder(t, base); len(got) != 0 {
				t.Fatalf("the refused metadata left %q", got)
			}
			scan(t, rec, "cannot create file", "syntax is incorrect", "System32", strings.Repeat("n", 64))
		})
	}
	t.Run("F5 8 PiB is refused after the prompt and leaves nothing", func(t *testing.T) {
		if runtime.GOOS != "windows" {
			t.Skip("free space is known on Windows only; elsewhere the engine cannot refuse F5")
		}
		a, rec, f, room, base := dropApp(t, nil)
		v := joinVisitor(t, f, room)
		v.connect(t)
		v.sendText(metaFrame(1, 1, "big.bin", 9007199254740991, 9007199254740991))
		s := deciding(t, a)
		if s.Prompt == nil || !strings.Contains(strings.Join(s.Prompt.Warnings, ","), "low-space") {
			t.Fatalf("the 8 PiB prompt carries no low-space warning: %+v", s.Prompt)
		}
		a.AnswerRequest(s.PromptGen, "accept")
		st := waitState(t, a, 15*time.Second, "stopped")
		if st.Code != "disk-full" && st.Code != "file-too-large-for-folder" {
			t.Fatalf("code %q", st.Code)
		}
		if got := treeUnder(t, base); len(got) != 0 {
			t.Fatalf("the refused 8 PiB file left %q", got)
		}
		scan(t, rec, "big.bin")
	})
}

// setVar swaps a package var for the test and restores it.
func setVar[T any](t *testing.T, v *T, val T) {
	t.Helper()
	old := *v
	*v = val
	t.Cleanup(func() { *v = old })
}

// countOpenChannelExpiries counts the E-35 timer firing.
func countOpenChannelExpiries(t *testing.T) *atomic.Int32 {
	t.Helper()
	var n atomic.Int32
	setVar(t, &requestOpenChannelExpired, func() { n.Add(1) })
	return &n
}

func TestRunRequestDropDrainsStaleSignals(t *testing.T) {
	f := newFakeSignalServer(t)
	sc, err := signaling.Connect(f.url())
	if err != nil {
		t.Fatal(err)
	}
	defer sc.Close()
	for i := 0; i < 5; i++ {
		sc.Signal <- json.RawMessage(`{"candidate":{"candidate":"candidate:1 1 udp 1 192.0.2.1 9 typ host"}}`)
	}
	sc.PeerLeft <- struct{}{}
	if n := drainSignals(sc); n != 5 {
		t.Fatalf("drained %d stale signals, want 5", n)
	}
	if len(sc.Signal) != 0 || len(sc.PeerLeft) != 0 {
		t.Fatalf("left %d signals and %d leaves for the next visitor", len(sc.Signal), len(sc.PeerLeft))
	}
	if n := drainSignals(sc); n != 0 {
		t.Fatalf("an empty socket drained %d", n)
	}
}

// TestRunRequestDropAcceptWithClosedChannelCreatesNothing (implication 8,
// spike case c): requestDecide with an accept already queued and the channel
// already closed. Both are ready when it selects, so over 50 runs both orders
// occur, and every one refuses with nothing on disk.
func TestRunRequestDropAcceptWithClosedChannelCreatesNothing(t *testing.T) {
	for i := 0; i < 50; i++ {
		a := &App{notifyFn: func(string, string) {}, wake: &wakeGuard{onBlock: func() {}, onAllow: func() {}}}
		l := a.lane()
		l.flashFn, l.setTitleFn = func(bool) {}, func(string) {}
		var raw []string
		l.emitFn = func(event string, data any) {
			b, _ := json.Marshal(data)
			raw = append(raw, string(b))
			if s, ok := data.(RequestLinkSnapshot); ok && s.State == "deciding" {
				a.AnswerRequest(s.PromptGen, "accept") // queued before requestDecide selects
			}
		}
		forceGen(a, 1)
		forceState(a, "connecting", 0)
		closed := make(chan struct{})
		close(closed)
		d := &requestDrop{closed: closed, abort: func(transfer.RefusalCode) {}}
		base := filepath.Join(t.TempDir(), "Floe requests")
		p := requestPairing{saveDir: base, label: "Acme footage", stop: make(chan struct{})}
		dec := a.requestDecide(1, p, d, transfer.IncomingInfo{Files: 1, TotalBytes: 4, FirstSize: 4})
		if dec.Kind == transfer.DecisionAccept || d.accepted.Load() {
			t.Fatalf("run %d: an Accept on a closed channel was taken", i)
		}
		if got := treeUnder(t, base); len(got) != 0 {
			t.Fatalf("run %d: an Accept on a closed channel left %q", i, got)
		}
		for _, js := range raw {
			if strings.Contains(js, "connection closed mid-transfer") {
				t.Fatalf("run %d: a snapshot says connection closed mid-transfer", i)
			}
		}
	}
}

// TestRunRequestDropJunkFloodReopens (E-35): a visitor that holds the channel
// open with junk and never sends a metadata is stopped when the open-channel
// timer fires: the coded stop reaches it, the room reopens, the link waits.
func TestRunRequestDropJunkFloodReopens(t *testing.T) {
	var fired *atomic.Int32
	a, _, f, room, _ := dropApp(t, func(a *App) {
		setVar(t, &requestOpenChannelTimeout, 200*time.Millisecond)
		fired = countOpenChannelExpiries(t)
	})
	v := joinVisitor(t, f, room)
	v.connect(t)
	stopFlood := make(chan struct{})
	go func() {
		for {
			select {
			case <-stopFlood:
				return
			case <-time.After(10 * time.Millisecond):
				_ = v.sendText("junk that is not a control frame")
				_ = v.sendBin([]byte("binary with no file open"))
			}
		}
	}()
	stop := v.frameOfType(t, "incompatible", 10*time.Second)
	close(stopFlood)
	if stop["code"] != "stopped" {
		t.Fatalf("the flood was stopped with code %v, want stopped", stop["code"])
	}
	waitSnap(t, a, 10*time.Second, "waiting", "setup-failed")
	waitFor(t, 5*time.Second, "request-reopen", func() bool { return f.count("request-reopen") >= 1 })
	if n := fired.Load(); n != 1 {
		t.Fatalf("the open-channel timer fired %d times, want 1", n)
	}
}

// TestRunRequestDropCancelsOpenChannelTimerOnReturn (WP-A2 review L3a): a
// first metadata the limits refuse never reaches OnIncoming, so the E-35
// timer is cancelled when the receive returns too, and never fires on the
// ended drop.
func TestRunRequestDropCancelsOpenChannelTimerOnReturn(t *testing.T) {
	var fired *atomic.Int32
	a, _, f, room, _ := dropApp(t, func(a *App) {
		setVar(t, &requestOpenChannelTimeout, 400*time.Millisecond)
		fired = countOpenChannelExpiries(t)
	})
	v := joinVisitor(t, f, room)
	v.connect(t)
	v.sendText(metaFrame(1, 1, strings.Repeat("d/", 40)+"f.txt", 4, 4))
	waitSnap(t, a, 10*time.Second, "stopped", "path-too-long")
	time.Sleep(800 * time.Millisecond)
	if n := fired.Load(); n != 0 {
		t.Fatalf("the open-channel timer fired %d times after the receive returned", n)
	}
}

func TestRunRequestDropDecideTimeoutRecordsMissed(t *testing.T) {
	a, _, f, room, base := dropApp(t, func(a *App) { setVar(t, &requestDecideWindow, 400*time.Millisecond) })
	paths := writeFiles(t, t.TempDir(), map[string][]byte{"a.txt": []byte("abcd")})
	v := joinVisitor(t, f, room)
	v.connect(t)
	sent := make(chan error, 1)
	go func() { sent <- v.sendFiles(paths, transfer.SendOptions{AckTimeout: time.Minute}) }()
	s := deciding(t, a)
	if s.Prompt == nil || s.Prompt.AnswerBy <= time.Now().UnixMilli()-1000 {
		t.Fatalf("prompt %+v has no answer-by time", s.Prompt)
	}
	var err error
	select {
	case err = <-sent:
	case <-time.After(15 * time.Second):
		t.Fatal("the send did not end")
	}
	var ps *transfer.PeerStoppedError
	if !errors.As(err, &ps) || ps.Code != transfer.CodeExpired {
		t.Fatalf("the visitor got %v, want the expired code", err)
	}
	w := waitSnap(t, a, 10*time.Second, "waiting", "")
	if w.MissedAt == 0 {
		t.Fatal("a missed request left no missedAt")
	}
	waitFor(t, 5*time.Second, "request-reopen", func() bool { return f.count("request-reopen") >= 1 })
	if got := treeUnder(t, base); len(got) != 0 {
		t.Fatalf("a missed request left %q", got)
	}
}

func TestRunRequestDropTimeLimitAbortsWithCode(t *testing.T) {
	a, _, f, room, _ := dropApp(t, func(a *App) { setVar(t, &requestDropCap, 400*time.Millisecond) })
	v := joinVisitor(t, f, room)
	v.connect(t)
	v.sendText(metaFrame(1, 1, "slow.bin", 1<<20, 1<<20))
	acceptNext(t, a)
	v.frameOfType(t, "ack", 10*time.Second)
	v.sendBin(make([]byte, 1<<10))
	stop := v.frameOfType(t, "incompatible", 10*time.Second)
	if stop["code"] != string(transfer.CodeTimeLimit) {
		t.Fatalf("the cap stopped the drop with code %v, want time-limit", stop["code"])
	}
	waitSnap(t, a, 10*time.Second, "stopped", "time-limit")
}

func TestRunRequestDropPassesCommitRetry(t *testing.T) {
	l := requestLimits()
	if l.CommitRetry != 5*time.Minute {
		t.Fatalf("CommitRetry %v, want 5 minutes (E-36)", l.CommitRetry)
	}
	if l.MaxFiles != 10000 || l.FreeReserve != 2<<30 || !l.BlockShellTypes || !l.HostRelayCheck {
		t.Fatalf("limits %+v", l)
	}
}

// TestRequestDropCancelReturnsAtOnce (WP-A2 review L3b): Cancel drop never
// waits on the stop it sends: not on the flush, not on the close, and not on
// a receive that a commit retry holds for up to 5 minutes.
func TestRequestDropCancelReturnsAtOnce(t *testing.T) {
	block := make(chan struct{})
	defer close(block)
	started := make(chan transfer.RefusalCode, 1)
	d := &requestDrop{abort: func(code transfer.RefusalCode) {
		started <- code
		<-block
	}}
	returned := make(chan struct{})
	go func() {
		d.cancelFunc()()
		close(returned)
	}()
	select {
	case <-returned:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("Cancel drop waited on its stop")
	}
	if !d.ownerCancel.Load() {
		t.Fatal("Cancel drop did not record the owner's stop")
	}
	select {
	case code := <-started:
		if code != transfer.CodeStopped {
			t.Fatalf("Cancel drop sent %q", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Cancel drop never sent its stop")
	}
}

func TestRequestProgressThrottled(t *testing.T) {
	clock := time.Unix(1_800_000_000, 0)
	var got []transfer.Progress
	emit := throttleProgress(100*time.Millisecond, func() time.Time { return clock }, func(p transfer.Progress) { got = append(got, p) })
	step := func(d time.Duration, bytes, size int64) {
		clock = clock.Add(d)
		emit(transfer.Progress{FileBytes: bytes, FileSize: size})
	}
	step(0, 1, 100)                    // first: sent
	step(10*time.Millisecond, 2, 100)  // inside the window: dropped
	step(10*time.Millisecond, 3, 100)  // dropped
	step(100*time.Millisecond, 4, 100) // window passed: sent
	step(1*time.Millisecond, 100, 100) // the file's final update: always sent
	step(1*time.Millisecond, 1, 50)    // the next file, inside the window: dropped
	step(1*time.Millisecond, 50, 50)   // its final update: sent
	var sent []int64
	for _, p := range got {
		sent = append(sent, p.FileBytes)
	}
	if fmt.Sprint(sent) != "[1 4 100 50]" {
		t.Fatalf("emitted %v, want [1 4 100 50]", sent)
	}
}

func TestRequestResultNamesCapped(t *testing.T) {
	var tally dropTally
	for i := 0; i < 201; i++ {
		name := fmt.Sprintf("f%03d.txt", i)
		if i == 7 {
			name = "evil.lnk.floe-blocked"
		}
		tally.add(transfer.FileDone{SavedName: name, Bytes: 10, Verified: i%2 == 0})
	}
	r := tally.result(201, "D:\\x")
	if r.Files != 201 || r.Saved != 201 || len(r.Names) != 200 || r.Bytes != 2010 || r.Verified != 101 || r.Renamed != 1 {
		t.Fatalf("result files %d saved %d names %d bytes %d verified %d renamed %d", r.Files, r.Saved, len(r.Names), r.Bytes, r.Verified, r.Renamed)
	}
	if r.Names[0] != "f000.txt" || r.Names[199] != "f199.txt" {
		t.Fatalf("names kept %q .. %q, want the first 200 in order", r.Names[0], r.Names[199])
	}
}

// TestDropFolderNameFitsNameMax (review 1b N2): the drop folder's name, with
// its time stamp and a " (99)", stays within the 255-byte component limit of
// ext4 and APFS, whatever the label; the 64-rune label cap alone is 256 bytes
// of four-byte runes.
func TestDropFolderNameFitsNameMax(t *testing.T) {
	now := time.Date(2026, 9, 14, 14, 5, 0, 0, time.Local)
	astral := strings.Repeat(string(rune(0x1F600)), 64)
	for _, label := range []string{astral, strings.Repeat("a", 300), strings.Repeat(string(rune(0x4E2D)), 64), "Acme footage", ""} {
		name := dropFolderName(label, now) + " (99)"
		if len(name) > 255 {
			t.Errorf("label of %d bytes: folder name is %d bytes, over 255", len(label), len(name))
		}
		if !utf8.ValidString(name) {
			t.Errorf("label of %d bytes: the cut split a rune", len(label))
		}
		if !strings.HasSuffix(name, " 2026-09-14 1405 (99)") {
			t.Errorf("folder name %q lost its time stamp", name)
		}
	}
	if got := dropFolderName("", now); got != "Request 2026-09-14 1405" {
		t.Errorf("empty label gives %q", got)
	}
	dir, err := makeDropFolder(t.TempDir(), astral, now)
	if err != nil {
		t.Fatalf("a long label's drop folder could not be made: %v", err)
	}
	if len(filepath.Base(dir)) > 255 {
		t.Fatal("the created folder's name is over 255 bytes")
	}
}

// TestRunRequestDropHideIPWithoutRelayReopens: Hide my IP is read at pairing,
// so turning it on after Make link holds the next pairing to a relay. With no
// TURN URL in the list, the room reopens and the link waits with no-relay
// before any offer leaves.
func TestRunRequestDropHideIPWithoutRelayReopens(t *testing.T) {
	a, _, f, room, _ := dropApp(t, nil)
	a.mu.Lock()
	a.cfg.HideIP = true
	a.mu.Unlock()
	joinVisitor(t, f, room)
	waitSnap(t, a, 10*time.Second, "waiting", "no-relay")
	waitFor(t, 5*time.Second, "request-reopen", func() bool { return f.count("request-reopen") >= 1 })
	f.mu.Lock()
	offers := f.hostSignals
	f.mu.Unlock()
	if offers != 0 {
		t.Fatalf("%d signals left the host without a relay", offers)
	}
}

// TestRequestPromptDriveLimitWarnsForFirstFileOnly (D-118, spec 05 8.3): the
// drive-limit warning asks about the first file, the only one known before
// Accept; a later file over the limit is refused at its own metadata. A batch
// of small files larger than 4 GB on a FAT32 drive gets no warning.
func TestRequestPromptDriveLimitWarnsForFirstFileOnly(t *testing.T) {
	const fat32Max = 4294967295
	setVar(t, &requestVolumeMaxFn, func(string) (int64, error) { return fat32Max, nil })
	p := requestPairing{saveDir: t.TempDir(), label: "x"}
	warns := func(in transfer.IncomingInfo) bool {
		for _, w := range requestPromptFor(p, in, "", time.Now()).Warnings {
			if w == "file-too-large-for-drive" {
				return true
			}
		}
		return false
	}
	if warns(transfer.IncomingInfo{Files: 3, TotalBytes: 6 << 30, FirstSize: 1 << 20}) {
		t.Error("a 6 GB batch whose first file is 1 MB warns about the drive limit")
	}
	if !warns(transfer.IncomingInfo{Files: 1, TotalBytes: 5 << 30, FirstSize: 5 << 30}) {
		t.Error("a 5 GB first file on a FAT32 drive gets no drive-limit warning")
	}
	if warns(transfer.IncomingInfo{Files: 1, TotalBytes: fat32Max, FirstSize: fat32Max}) {
		t.Error("a first file of exactly the drive's maximum warns")
	}
	setVar(t, &requestVolumeMaxFn, func(string) (int64, error) { return 0, nil })
	if warns(transfer.IncomingInfo{Files: 1, TotalBytes: 5 << 30, FirstSize: 5 << 30}) {
		t.Error("a volume with no known maximum warns")
	}
}
