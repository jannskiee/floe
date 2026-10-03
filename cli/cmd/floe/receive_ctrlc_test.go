package main

// Ctrl+C on floe receive, and what a plain floe send prints for it (FU-54,
// D-159). The real command tree runs against a fake plain room server, with
// main's handler run on a test channel (os.Exit recorded) and an in-process
// engine peer on the other side. Before FU-54 the handler's partial-file
// cleanup closed the in-flight .part under the still-running receive loop,
// whose next write failed, and the sender ended on write-failed: "Their
// computer could not save a file." (QA-H6 N10).

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/jannskiee/floe/cli/engine/transfer"
)

// plainRoom stands in for server.js's plain room over /ws: the first
// join-room is the sender, the second the receiver (and the sender is told
// user-connected), and a signal goes to the other seat. It also answers the
// ICE fetch (a STUN address on the loopback, so nothing leaves the machine)
// and the code registration a plain send makes. seated reports how many
// peers have joined.
func plainRoom(t *testing.T) (url string, seated func() int) {
	t.Helper()
	type seat struct {
		ws  *websocket.Conn
		wmu sync.Mutex
	}
	send := func(s *seat, v map[string]any) {
		s.wmu.Lock()
		defer s.wmu.Unlock()
		_ = s.ws.WriteJSON(v)
	}
	var mu sync.Mutex
	var seats []*seat
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/turn-credentials", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `[{"urls":"stun:127.0.0.1:9"}]`)
	})
	mux.HandleFunc("/api/code", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"code": "olive-tiger-castle"})
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		me := &seat{ws: ws}
		defer ws.Close()
		for {
			var m struct {
				Type   string          `json:"type"`
				Signal json.RawMessage `json:"signal"`
			}
			if ws.ReadJSON(&m) != nil {
				return
			}
			switch m.Type {
			case "join-room":
				mu.Lock()
				seats = append(seats, me)
				n := len(seats)
				var first *seat
				if n == 2 {
					first = seats[0]
				}
				mu.Unlock()
				if n == 1 {
					send(me, map[string]any{"type": "room-joined", "role": "sender"})
					continue
				}
				send(me, map[string]any{"type": "room-joined", "role": "receiver"})
				if first != nil {
					send(first, map[string]any{"type": "user-connected", "id": "receiver"})
				}
			case "signal":
				mu.Lock()
				var other *seat
				for _, s := range seats {
					if s != me {
						other = s
					}
				}
				mu.Unlock()
				if other != nil {
					send(other, map[string]any{"type": "signal", "signal": m.Signal, "sender": "peer"})
				}
			}
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(func() {
		mu.Lock()
		for _, s := range seats {
			_ = s.ws.Close()
		}
		mu.Unlock()
		srv.Close()
	})
	return srv.URL, func() int {
		mu.Lock()
		defer mu.Unlock()
		return len(seats)
	}
}

// engineSender is the in-process sender: seated first, it waits for the
// receiver, offers, and sends paths with the engine. connected closes once
// its data channel is open; the send's error arrives on the returned channel.
func engineSender(t *testing.T, url, room string, paths []string) (connected <-chan struct{}, result <-chan error) {
	t.Helper()
	sc, err := signaling.Connect(url)
	if err != nil {
		t.Fatalf("sender signaling connect: %v", err)
	}
	if err := sc.JoinRoom(room); err != nil {
		t.Fatalf("sender join: %v", err)
	}
	select {
	case role := <-sc.Role:
		if role != "sender" {
			t.Fatalf("the in-process sender was seated as %q", role)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the in-process sender was never seated")
	}
	up := make(chan struct{})
	res := make(chan error, 1)
	var conn *peer.Connection
	var connMu sync.Mutex
	go func() {
		select {
		case <-sc.PeerConnected:
		case <-time.After(30 * time.Second):
			res <- errors.New("no receiver came")
			return
		}
		c, err := peer.New(nil, sc)
		if err != nil {
			res <- err
			return
		}
		connMu.Lock()
		conn = c
		connMu.Unlock()
		dc, err := c.SetupAsSender()
		if err != nil {
			res <- err
			return
		}
		close(up)
		early := c.Early()
		res <- transfer.SendFilesWithOptions(dc, paths, "dev", transfer.SendOptions{
			Messages:   early.Msgs,
			Closed:     early.Closed,
			OnProgress: func(transfer.Progress) {},
		})
	}()
	t.Cleanup(func() {
		connMu.Lock()
		if conn != nil {
			conn.Close()
		}
		connMu.Unlock()
		sc.Close()
	})
	return up, res
}

// receiveCtrlC is one `floe receive` through execute, as main runs it, with
// main's handler on a test channel. The real partial-file cleanup runs: it is
// what used to turn this Ctrl+C into write-failed. The command's park is made
// releasable, and every piece of process state the run sets is put back.
type receiveCtrlC struct {
	sig      chan os.Signal
	exits    exitRecorder
	parked   chan struct{}
	parkOnce sync.Once
	release  chan struct{}
	relOnce  sync.Once
	done     chan struct{}
	err      error
}

func startReceiveCtrlC(t *testing.T, url string, args ...string) *receiveCtrlC {
	t.Helper()
	resetSharedFlags(t)
	t.Setenv("FLOE_SERVER", url)
	t.Setenv("FLOE_NO_STATS", "1")
	rootCmd.SetOut(nil)
	rootCmd.SetErr(nil)
	c := &receiveCtrlC{
		sig:     make(chan os.Signal, 1),
		exits:   make(exitRecorder, 4),
		parked:  make(chan struct{}),
		release: make(chan struct{}),
		done:    make(chan struct{}),
	}
	prevPark := parkUntilExit
	parkUntilExit = func() {
		c.parkOnce.Do(func() { close(c.parked) })
		<-c.release
	}
	go handleInterrupts(c.sig, c.exits.exit)
	argv := append([]string{"receive"}, args...)
	argv = append(argv, "--server", url, "--no-report")
	go func() {
		defer close(c.done)
		c.err = execute(argv)
	}()
	t.Cleanup(func() {
		c.free()
		select {
		case <-c.done:
		case <-time.After(30 * time.Second):
			t.Errorf("floe receive was still running 30 s after the test")
		}
		parkUntilExit = prevPark
		resetReceiveStop()
		close(c.sig)
		for _, name := range []string{"output", "yes", "no-report"} {
			if f := receiveCmd.Flags().Lookup(name); f != nil {
				_ = f.Value.Set(f.DefValue)
				f.Changed = false
			}
		}
		rootCmd.SetArgs(nil)
	})
	return c
}

func (c *receiveCtrlC) free() { c.relOnce.Do(func() { close(c.release) }) }

// wantCanceledAnd130 asserts the process as main runs it: the handler's exit
// 130 came, the command parked instead of returning first (main's os.Exit(1)
// would have raced the 130), and stderr holds "Canceled." alone.
func (c *receiveCtrlC) wantCanceledAnd130(t *testing.T, o *output) {
	t.Helper()
	if code := c.exits.awaitExit(t, 10*time.Second, "Ctrl+C"); code != 130 {
		t.Fatalf("exit %d, want 130", code)
	}
	select {
	case <-c.parked:
	case <-c.done:
		t.Fatalf("the command returned (%v) instead of parking: main's os.Exit(1) would have raced the 130", c.err)
	case <-time.After(10 * time.Second):
		t.Fatal("the command never parked after Ctrl+C took its ending")
	}
	c.free()
	select {
	case <-c.done:
	case <-time.After(20 * time.Second):
		t.Fatal("the released command did not return")
	}
	_, stderr := o.text()
	if got := pionLog.ReplaceAllString(stderr, ""); got != "\n  Canceled.\n" {
		t.Fatalf("stderr = %q, want \"Canceled.\" alone", got)
	}
}

// wantStopped requires the sender's send to end on the receiver's refusal
// with code stopped and saved count saved, within bound.
func wantStopped(t *testing.T, result <-chan error, saved int, bound time.Duration) {
	t.Helper()
	select {
	case err := <-result:
		var stopped *transfer.PeerStoppedError
		if !errors.As(err, &stopped) {
			t.Fatalf("the sender ended on %v, want the receiver's refusal with code stopped", err)
		}
		if stopped.Code != transfer.CodeStopped || stopped.Saved != saved {
			t.Fatalf("the sender read code %q saved %d, want code stopped saved %d", stopped.Code, stopped.Saved, saved)
		}
	case <-time.After(bound):
		t.Fatalf("the sender heard nothing within %v of the receiver's Ctrl+C", bound)
	}
}

// TestReceiveCtrlCMidFileTellsTheSenderStopped (FU-54, QA-H6 N10): Ctrl+C in
// the middle of a file sends the sender code stopped with the saved count
// before the cleanup closes the .part, and the receiver still prints
// "Canceled." alone, exits 130 and leaves no .part behind.
func TestReceiveCtrlCMidFileTellsTheSenderStopped(t *testing.T) {
	o := captureOutput(t)
	url, _ := plainRoom(t)
	src := filepath.Join(t.TempDir(), "big.bin")
	f, err := os.Create(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(256 << 20); err != nil {
		t.Fatal(err)
	}
	f.Close()
	room := uuid.New().String()
	_, result := engineSender(t, url, room, []string{src})
	out := t.TempDir()
	c := startReceiveCtrlC(t, url, url+"/#room="+room, "-y", "--output", out)

	// Mid-file: the .part exists and holds bytes.
	deadline := time.Now().Add(30 * time.Second)
	for {
		if parts, _ := filepath.Glob(filepath.Join(out, "*.part")); len(parts) == 1 {
			if fi, err := os.Stat(parts[0]); err == nil && fi.Size() > 0 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("the receive never started writing the file")
		}
		time.Sleep(2 * time.Millisecond)
	}
	c.sig <- os.Interrupt

	wantStopped(t, result, 0, 5*time.Second)
	c.wantCanceledAnd130(t, o)
	if parts, _ := filepath.Glob(filepath.Join(out, "*.part")); len(parts) != 0 {
		t.Fatalf("the canceled receive left %v behind", parts)
	}
	if _, err := os.Stat(filepath.Join(out, "big.bin")); !os.IsNotExist(err) {
		t.Fatalf("a canceled receive left a finished-looking file (stat err %v)", err)
	}
}

// TestReceiveCtrlCAtThePromptTellsTheSenderStopped (FU-54 review 1 M2 part
// 2): with the receive loop parked in the Accept prompt's read, Ctrl+C still
// sends code stopped, from the signal path, with nothing saved.
func TestReceiveCtrlCAtThePromptTellsTheSenderStopped(t *testing.T) {
	o := captureOutput(t)
	url, _ := plainRoom(t)
	src := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(src, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A stdin that never answers, so the prompt's read parks.
	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	prevStdin := os.Stdin
	os.Stdin = stdinR
	t.Cleanup(func() {
		_ = stdinW.Close() // the parked read returns, and the loop ends
		os.Stdin = prevStdin
		_ = stdinR.Close()
	})
	room := uuid.New().String()
	connected, result := engineSender(t, url, room, []string{src})
	c := startReceiveCtrlC(t, url, url+"/#room="+room, "--output", t.TempDir())
	select {
	case <-connected:
	case <-time.After(30 * time.Second):
		t.Fatal("the in-process sender never connected")
	}
	// The metadata goes out at once; on the loopback the receiver is at the
	// prompt well within this.
	time.Sleep(time.Second)
	c.sig <- os.Interrupt

	wantStopped(t, result, 0, 5*time.Second)
	if code := c.exits.awaitExit(t, 10*time.Second, "Ctrl+C at the prompt"); code != 130 {
		t.Fatalf("exit %d, want 130", code)
	}
	_ = stdinW.Close()
	select {
	case <-c.parked:
	case <-c.done:
		t.Fatalf("the command returned (%v) instead of parking", c.err)
	case <-time.After(10 * time.Second):
		t.Fatal("the command never parked after Ctrl+C took its ending")
	}
	c.free()
	<-c.done
	_, stderr := o.text()
	if got := pionLog.ReplaceAllString(stderr, ""); got != "\n  Canceled.\n" {
		t.Fatalf("stderr = %q, want \"Canceled.\" alone", got)
	}
}

// TestPlainSendPrintsTheyStoppedTheTransfer (D-159): a plain floe send whose
// receiver refuses with code stopped ends on the approved plain line, behind
// cobra's "Error: ", and exits 1 (a non-nil error).
func TestPlainSendPrintsTheyStoppedTheTransfer(t *testing.T) {
	o := captureOutput(t)
	url, seated := plainRoom(t)
	src := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(src, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	// The receiver: answers the offer, reads the first metadata, refuses
	// with code stopped as floe receive's Ctrl+C does, and holds the
	// channel open.
	stopped := make(chan error, 1)
	go func() {
		sc, err := signaling.Connect(url)
		if err != nil {
			stopped <- err
			return
		}
		defer sc.Close()
		// The send joins first: wait until its seat is taken.
		for wait := time.Now().Add(20 * time.Second); seated() < 1; time.Sleep(5 * time.Millisecond) {
			if time.Now().After(wait) {
				stopped <- errors.New("the send never joined")
				return
			}
		}
		if err := sc.JoinRoom("plain-room"); err != nil {
			stopped <- err
			return
		}
		select {
		case <-sc.Role:
		case <-time.After(10 * time.Second):
			stopped <- errors.New("the receiver was never seated")
			return
		}
		conn, err := peer.New(nil, sc)
		if err != nil {
			stopped <- err
			return
		}
		defer conn.Close()
		dc, err := conn.SetupAsReceiver()
		if err != nil {
			stopped <- err
			return
		}
		early := conn.Early()
		for {
			select {
			case m := <-early.Msgs:
				if typ, _ := controlOf(m); typ == "metadata" {
					transfer.AbortWithCode(dc, "dev", transfer.CodeStopped, transfer.CodeStopped.WireReason(), 0)
					stopped <- nil
					select {
					case <-early.Closed:
					case <-time.After(20 * time.Second):
					}
					return
				}
			case <-time.After(20 * time.Second):
				stopped <- errors.New("no metadata from the send")
				return
			}
		}
	}()
	r := startCLI(t, src, "--server", url)
	if err := <-stopped; err != nil {
		t.Fatalf("the in-process receiver: %v", err)
	}
	r.wait(t, 30*time.Second).read(o)
	if r.err == nil {
		t.Fatal("the send succeeded, want exit 1")
	}
	if got := pionLog.ReplaceAllString(r.stderr, ""); got != "Error: They stopped the transfer.\n" {
		t.Fatalf("stderr = %q, want the approved plain line", got)
	}
}
