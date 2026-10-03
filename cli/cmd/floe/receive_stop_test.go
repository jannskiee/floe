package main

// The guards around floe receive's Ctrl+C step (FU-54): the handler's order
// and its one 5 s deadline, the second Ctrl+C that stays swallowed, the gates
// on the step itself, and the plain send's line for code stopped.

import (
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/transfer"
	"github.com/pion/webrtc/v4"
)

// resetReceiveStop clears the step a receive left behind: runReceive leaves
// it in place for the rest of the process, and a test is not the rest of the
// process.
func resetReceiveStop() { interruptStop.Store(nil) }

// TestHandleInterruptsStopStepRunsBeforeTheCleanupAndKeepsTheSecondSignalSwallowed
// (FU-54 review 1 M1, LA2-5): with only the receive's step installed and no
// hook, Ctrl+C prints "Canceled.", runs the step and then the partial-file
// cleanup, in that order, and a second Ctrl+C while the cleanup is held is
// swallowed: no exit until the cleanup ends, then exactly one 130.
func TestHandleInterruptsStopStepRunsBeforeTheCleanupAndKeepsTheSecondSignalSwallowed(t *testing.T) {
	o := captureOutput(t)
	interruptHook.Store(nil)
	var mu sync.Mutex
	var order []string
	step := func() {
		mu.Lock()
		order = append(order, "stop")
		mu.Unlock()
	}
	interruptStop.Store(&step)
	entered := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	prev := abandonPartials
	abandonPartials = func(time.Duration) {
		mu.Lock()
		order = append(order, "abandon")
		mu.Unlock()
		close(entered)
		<-release
	}
	sig := make(chan os.Signal, 1)
	exits := make(exitRecorder, 4)
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(release) })
		abandonPartials = prev
		resetReceiveStop()
	})
	go handleInterrupts(sig, exits.exit)
	sig <- os.Interrupt
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the partial-file cleanup never ran")
	}
	sig <- os.Interrupt
	select {
	case code := <-exits:
		t.Fatalf("a second Ctrl+C exited %d during the held cleanup", code)
	case <-time.After(500 * time.Millisecond):
	}
	releaseOnce.Do(func() { close(release) })
	if code := exits.awaitExit(t, 5*time.Second, "the cleanup's end"); code != 130 {
		t.Fatalf("exit %d, want 130", code)
	}
	select {
	case code := <-exits:
		t.Fatalf("a second exit (%d) after the first", code)
	case <-time.After(200 * time.Millisecond):
	}
	mu.Lock()
	got := append([]string(nil), order...)
	mu.Unlock()
	if len(got) != 2 || got[0] != "stop" || got[1] != "abandon" {
		t.Fatalf("order = %v, want the stop step before the cleanup", got)
	}
	if _, stderr := o.text(); stderr != "\n  Canceled.\n" {
		t.Fatalf("stderr = %q, want today's line alone", stderr)
	}
}

// TestHandleInterruptsStopAndCleanupShareOneDeadline (FU-54 review 1 L5,
// FU-12): the step is cut at interruptStopBound and the cleanup gets what is
// left of one interruptCleanupBound, so a stalled step plus a stalled cleanup
// still exits within 5 s of the line. The bounds are the binary's own.
func TestHandleInterruptsStopAndCleanupShareOneDeadline(t *testing.T) {
	if interruptCleanupBound != 5*time.Second || interruptStopBound != time.Second {
		t.Fatalf("bounds %v and %v, want FU-12's 5 s shared with a 1 s step", interruptCleanupBound, interruptStopBound)
	}
	o := captureOutput(t)
	interruptHook.Store(nil)
	stall := make(chan struct{})
	step := func() { <-stall }
	interruptStop.Store(&step)
	got := make(chan time.Duration, 1)
	prev := abandonPartials
	abandonPartials = func(within time.Duration) {
		got <- within
		time.Sleep(within) // a cleanup that uses all it is given
	}
	sig := make(chan os.Signal, 1)
	exits := make(exitRecorder, 4)
	t.Cleanup(func() {
		close(stall)
		abandonPartials = prev
		resetReceiveStop()
		close(sig)
	})
	go handleInterrupts(sig, exits.exit)
	start := time.Now()
	sig <- os.Interrupt
	within := <-got
	if within > interruptCleanupBound-interruptStopBound+50*time.Millisecond || within < interruptCleanupBound-interruptStopBound-500*time.Millisecond {
		t.Fatalf("the cleanup got %v after a stalled step, want what is left of the 5 s deadline (about 4 s)", within)
	}
	if code := exits.awaitExit(t, 10*time.Second, "Ctrl+C"); code != 130 {
		t.Fatalf("exit %d, want 130", code)
	}
	if total := time.Since(start); total > interruptCleanupBound+300*time.Millisecond {
		t.Fatalf("the exit came %v after Ctrl+C, want within FU-12's 5 s", total)
	}
	if _, stderr := o.text(); stderr != "\n  Canceled.\n" {
		t.Fatalf("stderr = %q, want today's line alone", stderr)
	}
}

// TestReceiveStopTellsOnlyWhileThereIsSomethingToStop: the step tells the
// sender nothing before the channel opens (today's behavior) and nothing once
// every announced file is committed; in between it tells it once, with the
// saved count. After the receive returned on its own, the step leaves the
// command's ending alone.
func TestReceiveStopTellsOnlyWhileThereIsSomethingToStop(t *testing.T) {
	var calls []int
	prev := tellStopped
	tellStopped = func(_ *webrtc.DataChannel, _ *peer.Connection, saved int) { calls = append(calls, saved) }
	t.Cleanup(func() { tellStopped = prev })
	dc, conn := &webrtc.DataChannel{}, &peer.Connection{}

	// Before the channel: nothing to tell, and the command parks.
	r := &receiveRun{}
	r.stop()
	if len(calls) != 0 {
		t.Fatalf("the step told the sender %v before the channel opened", calls)
	}
	if r.connected(dc, conn) {
		t.Fatal("a receive whose setup Ctrl+C ended went on to receive")
	}

	// Mid-transfer: 1 of 3 saved.
	r = &receiveRun{}
	r.connected(dc, conn)
	r.files.Store(3)
	r.saved.Store(1)
	r.stop()
	if len(calls) != 1 || calls[0] != 1 {
		t.Fatalf("mid-transfer the step told %v, want one stop with 1 saved", calls)
	}
	if r.finish() {
		t.Fatal("the command kept its ending after Ctrl+C took it")
	}

	// Every file committed: nothing to stop.
	calls = nil
	r = &receiveRun{}
	r.connected(dc, conn)
	r.files.Store(2)
	r.saved.Store(2)
	r.stop()
	if len(calls) != 0 {
		t.Fatalf("the step told the sender %v after the last file was committed", calls)
	}

	// The receive returned first: the command keeps its ending.
	r = &receiveRun{}
	r.connected(dc, conn)
	if !r.finish() {
		t.Fatal("a receive that returned before Ctrl+C lost its ending")
	}
	r.stop()
	if len(calls) != 0 {
		t.Fatalf("the step told the sender %v after the receive had returned", calls)
	}
}

// TestPlainSendEndChangesOnlyStopped (D-159): the plain send prints its own
// line for code stopped, and every other code and error exactly as before,
// so floe send --to, which never calls it, keeps TL-24 (sendto_test.go pins
// "They stopped this drop." for the request-link send).
func TestPlainSendEndChangesOnlyStopped(t *testing.T) {
	if got := plainSendEnd(&transfer.PeerStoppedError{Code: transfer.CodeStopped, Saved: 2}); got == nil || got.Error() != "They stopped the transfer." {
		t.Fatalf("code stopped prints %v, want the approved plain line", got)
	}
	for _, c := range transfer.RefusalCodes {
		if c == transfer.CodeStopped {
			continue
		}
		in := &transfer.PeerStoppedError{Code: c}
		if got := plainSendEnd(in); got != error(in) {
			t.Errorf("code %s became %v, want it unchanged", c, got)
		}
	}
	other := errors.New("connection closed")
	if got := plainSendEnd(other); got != other {
		t.Errorf("a non-refusal error became %v", got)
	}
	if got := plainSendEnd(nil); got != nil {
		t.Errorf("a success became %v", got)
	}
	if got := (&transfer.PeerStoppedError{Code: transfer.CodeStopped}).Error(); got != "They stopped this drop." {
		t.Errorf("the engine's sentence for the request-link send changed to %q", got)
	}
}
