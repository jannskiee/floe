package main

// Ctrl+C on a plain floe send (CLI-02). The real command tree runs against
// the fake plain room server, with main's handler on a test channel (os.Exit
// recorded) and an in-process peer as the receiver. Before the send had a
// stop step, the handler's exit told the receiver nothing and closed nothing:
// floe receive then sat until its stall watchdog (a minute once connected)
// and a browser until ICE gave up.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/jannskiee/floe/cli/engine/transfer"
	"github.com/pion/webrtc/v4"
)

// senderStoppedReason is the one sentence a Floe sender gives for its own
// cancel, as the receiver reads it off the wire.
const senderStoppedReason = "The sender stopped."

// plainReceiver seats an in-process peer second in the plain room at url,
// once the send under test holds the first seat, answers the send's offer and
// hands the open channel to part. The connection stays open until the test
// ends, whatever part returns, so only the send's own close can end a wait in
// part. done closes once part has returned. Call it after startCLI: its
// cleanup then runs first and closes the receiver's side, which is what ends
// a send that a failed test left waiting.
func plainReceiver(t *testing.T, url string, seated func() int, part func(dc *webrtc.DataChannel, early *peer.Early, quit <-chan struct{})) (done <-chan struct{}) {
	t.Helper()
	quit := make(chan struct{})
	returned := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		sc, err := signaling.Connect(url)
		if err != nil {
			t.Errorf("receiver signaling connect: %v", err)
			return
		}
		defer sc.Close()
		for wait := time.Now().Add(20 * time.Second); seated() < 1; time.Sleep(5 * time.Millisecond) {
			if time.Now().After(wait) {
				t.Error("the send never joined")
				return
			}
		}
		if err := sc.JoinRoom("plain-room"); err != nil {
			t.Errorf("receiver join: %v", err)
			return
		}
		select {
		case <-sc.Role:
		case <-time.After(10 * time.Second):
			t.Error("the receiver was never seated")
			return
		}
		conn, err := peer.New(nil, sc)
		if err != nil {
			t.Errorf("receiver peer: %v", err)
			return
		}
		defer conn.Close()
		// The test's end closes this side, so a part that does not watch quit
		// (the engine's receive) returns then too.
		go func() {
			<-quit
			conn.Close()
		}()
		dc, err := conn.SetupAsReceiver()
		if err != nil {
			t.Errorf("receiver setup: %v", err)
			return
		}
		part(dc, conn.Early(), quit)
		close(returned)
		<-quit
	}()
	t.Cleanup(func() {
		close(quit)
		select {
		case <-finished:
		case <-time.After(30 * time.Second):
			t.Errorf("the in-process receiver was still running 30 s after the test")
		}
	})
	return returned
}

// heardFromSender is what a scripted receiver saw the send do after its first
// metadata.
type heardFromSender struct {
	aborted bool   // an abort frame came
	reason  string // its reason
	closed  bool   // the send's side closed the connection
	// before and after count the file bytes that arrived before and after the
	// abort frame.
	before, after int64
}

// listen reads what the send does next until its close, the test's end or
// bound. A frame and the close can be ready at once, and pion delivers a
// frame before the close, so what is queued at the close is read first.
func (h *heardFromSender) listen(early *peer.Early, quit <-chan struct{}, bound time.Duration, onBytes func(total int64)) {
	take := func(m webrtc.DataChannelMessage) {
		if !m.IsString {
			if h.aborted {
				h.after += int64(len(m.Data))
			} else {
				h.before += int64(len(m.Data))
				if onBytes != nil {
					onBytes(h.before)
				}
			}
			return
		}
		if typ, _ := controlOf(m); typ == "incompatible" {
			var f struct {
				Reason string `json:"reason"`
			}
			_ = json.Unmarshal(m.Data, &f)
			h.aborted, h.reason = true, f.Reason
		}
	}
	deadline := time.After(bound)
	for {
		select {
		case m := <-early.Msgs:
			take(m)
		case <-early.Closed:
			for {
				select {
				case m := <-early.Msgs:
					take(m)
					continue
				default:
				}
				break
			}
			h.closed = true
			return
		case <-quit:
			return
		case <-deadline:
			return
		}
	}
}

// awaitFirstMetadata reads until the send's first metadata and returns its id.
func awaitFirstMetadata(early *peer.Early, quit <-chan struct{}) (id string, ok bool) {
	for {
		select {
		case m := <-early.Msgs:
			if typ, id := controlOf(m); typ == "metadata" {
				return id, true
			}
		case <-early.Closed:
			return "", false
		case <-quit:
			return "", false
		case <-time.After(20 * time.Second):
			return "", false
		}
	}
}

// wantSendCanceledAnd130 asserts the process as main runs it: the handler's
// exit 130 came, the command parked instead of returning first (main's
// os.Exit(1) would have raced the 130, behind an "Error:" line of its own),
// and stderr holds "Canceled." alone.
func wantSendCanceledAnd130(t *testing.T, c *ctrlC, r *cliRun, o *output) {
	t.Helper()
	if code := c.exits.awaitExit(t, 10*time.Second, "Ctrl+C"); code != 130 {
		t.Fatalf("exit %d, want 130", code)
	}
	select {
	case <-c.parked:
	case <-r.done:
		t.Fatalf("the command returned (%v) instead of parking: main's os.Exit(1) would have raced the 130", r.err)
	case <-time.After(10 * time.Second):
		t.Fatal("the command never parked after Ctrl+C took its ending")
	}
	c.free()
	r.wait(t, 20*time.Second).read(o)
	if !errors.Is(r.err, errSendToEnded) {
		t.Fatalf("the parked command returned %v, want the error execute prints nothing for", r.err)
	}
	if got := pionLog.ReplaceAllString(r.stderr, ""); got != canceledAlone {
		t.Fatalf("stderr = %q, want \"Canceled.\" alone\nstdout:\n%s", got, r.stdout)
	}
}

// TestPlainSendCtrlCBeforeTheAcceptTellsTheReceiver: Ctrl+C while the person
// at the other end has not answered yet sends the receiver the sender's fixed
// reason and closes the connection, within the handler's one-second step, and
// the send still prints "Canceled." alone and exits 130.
func TestPlainSendCtrlCBeforeTheAcceptTellsTheReceiver(t *testing.T) {
	o := captureOutput(t)
	url, seated := plainRoom(t)
	src := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(src, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	deciding := make(chan struct{})
	var heard heardFromSender
	c := newCtrlC(t)
	r := startCLI(t, src, "--server", url)
	c.letGo(t)
	done := plainReceiver(t, url, seated, func(_ *webrtc.DataChannel, early *peer.Early, quit <-chan struct{}) {
		if _, ok := awaitFirstMetadata(early, quit); !ok {
			return
		}
		close(deciding)
		// The person is deciding: no ack. What the send does next is all its own.
		heard.listen(early, quit, 20*time.Second, nil)
	})
	select {
	case <-deciding:
	case <-time.After(30 * time.Second):
		t.Fatal("the receiver never got the metadata")
	}
	pressed := time.Now()
	c.press()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the receiver heard nothing within 5 s of the sender's Ctrl+C: it would wait out its own timeouts")
	}
	if took := time.Since(pressed); took > 3*time.Second {
		t.Fatalf("the receiver heard the end %v after Ctrl+C", took)
	}
	if !heard.aborted || heard.reason != senderStoppedReason {
		t.Fatalf("the receiver read abort %v with reason %q, want the sender's fixed reason %q", heard.aborted, heard.reason, senderStoppedReason)
	}
	if !heard.closed {
		t.Fatal("the send told the receiver why and left the connection open")
	}
	wantSendCanceledAnd130(t, c, r, o)
}

// TestPlainSendCtrlCMidFileEndsTheReceiveAtOnce: Ctrl+C in the middle of a
// file ends floe receive's own loop (the engine's, as the binary runs it)
// within seconds, on the sender's reason or, when the frame could not leave
// in time behind what was already queued, on the close. Never on the stall
// watchdog. The receive deletes its unfinished file as it does for any end.
func TestPlainSendCtrlCMidFileEndsTheReceiveAtOnce(t *testing.T) {
	o := captureOutput(t)
	url, seated := plainRoom(t)
	src := filepath.Join(t.TempDir(), "big.bin")
	f, err := os.Create(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(256 << 20); err != nil {
		t.Fatal(err)
	}
	f.Close()
	out := t.TempDir()
	flowing := make(chan struct{})
	var once sync.Once
	var received error
	c := newCtrlC(t)
	r := startCLI(t, src, "--server", url)
	c.letGo(t)
	done := plainReceiver(t, url, seated, func(dc *webrtc.DataChannel, early *peer.Early, _ <-chan struct{}) {
		received = transfer.ReceiveFilesWithOptions(dc, out, true, "dev", "", transfer.ReceiveOptions{
			OnProgress: func(p transfer.Progress) {
				if p.FileBytes > 0 {
					once.Do(func() { close(flowing) })
				}
			},
			Messages: early.Msgs,
			Closed:   early.Closed,
		})
	})
	select {
	case <-flowing:
	case <-time.After(30 * time.Second):
		t.Fatal("no bytes reached the receiver")
	}
	c.press()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the receive was still waiting 5 s after the sender's Ctrl+C: it would sit until its stall watchdog")
	}
	switch {
	case received == nil:
		t.Fatal("the receive reported success for a file the sender stopped")
	case received.Error() == senderStoppedReason:
	case strings.HasPrefix(received.Error(), "connection closed mid-transfer"):
	default:
		t.Fatalf("the receive ended on %q, want the sender's reason or its close", received)
	}
	wantSendCanceledAnd130(t, c, r, o)
	if parts, _ := filepath.Glob(filepath.Join(out, "*")); len(parts) != 0 {
		t.Fatalf("the stopped receive left %v behind", parts)
	}
}

// TestPlainSendCtrlCSendsNothingAfterTheAbort: the send stops before its
// abort frame goes out, so the frame is the last thing on the channel and a
// receiver that reads on gets no file byte after it. The step's bounds are
// raised here, so that on a loaded machine the send always has time to stop
// and the frame to leave behind what was queued; TestPlainSendStopIsBounded
// holds them to the binary's values.
func TestPlainSendCtrlCSendsNothingAfterTheAbort(t *testing.T) {
	prevSettle, prevFlush, prevBound := sendStopSettle, sendStopFlush, interruptStopBound
	sendStopSettle, sendStopFlush, interruptStopBound = 5*time.Second, 10*time.Second, 20*time.Second
	t.Cleanup(func() { sendStopSettle, sendStopFlush, interruptStopBound = prevSettle, prevFlush, prevBound })
	o := captureOutput(t)
	url, seated := plainRoom(t)
	src := filepath.Join(t.TempDir(), "big.bin")
	f, err := os.Create(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(256 << 20); err != nil {
		t.Fatal(err)
	}
	f.Close()
	flowing := make(chan struct{})
	var once sync.Once
	var heard heardFromSender
	c := newCtrlC(t)
	r := startCLI(t, src, "--server", url)
	c.letGo(t)
	done := plainReceiver(t, url, seated, func(dc *webrtc.DataChannel, early *peer.Early, quit <-chan struct{}) {
		id, ok := awaitFirstMetadata(early, quit)
		if !ok {
			return
		}
		// The ack a Go receiver sends: binary, offset 0.
		if err := dc.Send([]byte(`{"type":"ack","id":"` + id + `","offset":0,"pv":1,"pvMin":1,"ver":"dev"}`)); err != nil {
			t.Errorf("receiver ack: %v", err)
			return
		}
		heard.listen(early, quit, 40*time.Second, func(total int64) {
			if total >= 4<<20 {
				once.Do(func() { close(flowing) })
			}
		})
	})
	select {
	case <-flowing:
	case <-time.After(30 * time.Second):
		t.Fatal("no bytes reached the receiver")
	}
	c.press()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("the receiver never heard the end of the send")
	}
	if !heard.aborted || heard.reason != senderStoppedReason || !heard.closed {
		t.Fatalf("the receiver read abort %v, reason %q, close %v; want the sender's fixed reason and then the close", heard.aborted, heard.reason, heard.closed)
	}
	if heard.after != 0 {
		t.Fatalf("%d file bytes followed the abort frame (%d before it)", heard.after, heard.before)
	}
	wantSendCanceledAnd130(t, c, r, o)
}

// TestPlainSendStopTellsOnlyWhileThereIsSomethingToStop: the step stops the
// send whenever it runs before the send has returned, tells the receiver
// only once a channel is open and the send has not ended in success, and
// leaves a send that returned first alone. No network: the command's side is
// driven by hand.
func TestPlainSendStopTellsOnlyWhileThereIsSomethingToStop(t *testing.T) {
	var told atomic.Int32
	prevTell, prevSettle := tellCanceled, sendStopSettle
	tellCanceled = func(*webrtc.DataChannel, *peer.Connection) { told.Add(1) }
	// Long, so that in the cases below the step moves on only because the
	// send returned; the one case about the bound shrinks it.
	sendStopSettle = 30 * time.Second
	t.Cleanup(func() { tellCanceled, sendStopSettle = prevTell, prevSettle })
	dc, conn := &webrtc.DataChannel{}, &peer.Connection{}
	halted := func(r *sendRun) bool {
		select {
		case <-r.halt:
			return true
		default:
			return false
		}
	}

	// Before the channel: nobody to tell, and the command parks.
	r := newSendRun()
	r.stop()
	if n := told.Load(); n != 0 {
		t.Fatalf("the step told the receiver %d time(s) before the channel opened", n)
	}
	if r.connected(dc, conn) {
		t.Fatal("a send whose setup Ctrl+C ended went on to send")
	}

	// Sending: the send sees its stop, returns, and only then is the receiver
	// told, once. The command does not get its ending back.
	r = newSendRun()
	r.connected(dc, conn)
	stepped := make(chan struct{})
	go func() {
		defer close(stepped)
		r.stop()
	}()
	<-r.halt
	if told.Load() != 0 {
		t.Fatal("the step told the receiver before the send had stopped")
	}
	if r.finish(false) {
		t.Fatal("the command kept its ending after Ctrl+C took it")
	}
	<-stepped
	if n := told.Load(); n != 1 {
		t.Fatalf("mid-send the step told the receiver %d time(s), want once", n)
	}

	// The receiver's "received" was already there when the stop landed, so
	// the send returned in success: every file arrived, and there is nothing
	// to stop.
	told.Store(0)
	r = newSendRun()
	r.connected(dc, conn)
	stepped = make(chan struct{})
	go func() {
		defer close(stepped)
		r.stop()
	}()
	<-r.halt
	if r.finish(true) {
		t.Fatal("the command kept its ending after Ctrl+C took it")
	}
	<-stepped
	if n := told.Load(); n != 0 {
		t.Fatalf("the step told the receiver %d time(s) after every file had arrived", n)
	}

	// The send returned before Ctrl+C: the command keeps its ending, and the
	// step neither stops nor tells.
	r = newSendRun()
	r.connected(dc, conn)
	if !r.finish(false) {
		t.Fatal("a send that returned before Ctrl+C lost its ending")
	}
	r.stop()
	if n := told.Load(); halted(r) || n != 0 {
		t.Fatalf("after the send had returned: stopped %v, told %d time(s); want neither", halted(r), n)
	}

	// A send that does not return within the bound (a disk read that stalls):
	// the receiver is told anyway.
	sendStopSettle = 50 * time.Millisecond
	r = newSendRun()
	r.connected(dc, conn)
	r.stop()
	if n := told.Load(); !halted(r) || n != 1 {
		t.Fatalf("with a send that never settled: stopped %v, told %d time(s); want it stopped and the receiver told once", halted(r), n)
	}
}

// TestPlainSendStopIsBounded: the step's two waits, for the send to stop and
// for the abort frame to leave, fit inside the one second main's handler
// gives a stop step (interruptStopBound) with room for the close, so Ctrl+C
// on a send never takes longer than that to print "Canceled.".
func TestPlainSendStopIsBounded(t *testing.T) {
	if sendStopSettle <= 0 || sendStopFlush <= 0 {
		t.Fatalf("bounds %v and %v, want both set", sendStopSettle, sendStopFlush)
	}
	if total := sendStopSettle + sendStopFlush; total >= interruptStopBound {
		t.Fatalf("the step may wait %v, which does not fit inside the handler's %v", total, interruptStopBound)
	}
}
