package main

// The one-transfer-at-a-time state machine (transferstate.go): which handles
// a cancel reaches, what a superseded goroutine may no longer touch, and when
// a close request may proceed.

import "testing"

// TestCancelTransferIdle guards the Start-over path, which calls CancelTransfer
// unconditionally: with no transfer in flight (nil curSC/curConn) it must be a
// safe no-op, never a nil-dereference panic.
func TestCancelTransferIdle(t *testing.T) {
	(&App{}).CancelTransfer()
}

// fakeCloser records Close calls so the generation-tag tests can prove which
// handles a cancel actually reached.
type fakeCloser struct{ closed int }

func (f *fakeCloser) Close() { f.closed++ }

// TestCancelTransferClosesLiveHandles: a cancel must close exactly the live
// generation's registered handles.
func TestCancelTransferClosesLiveHandles(t *testing.T) {
	a := &App{}
	g := a.beginTransfer()
	sc, conn := &fakeCloser{}, &fakeCloser{}
	if !a.setSignaling(g, sc) || !a.setConn(g, conn) {
		t.Fatal("setters refused the live generation")
	}
	a.CancelTransfer()
	if sc.closed != 1 || conn.closed != 1 {
		t.Fatalf("cancel closed sc=%d conn=%d times, want 1/1", sc.closed, conn.closed)
	}
	if a.transferActive(g) {
		t.Fatal("generation still active after cancel")
	}
}

// TestClearTransferOldGenerationNoOp pins the race fix: a superseded
// goroutine's deferred clear must not wipe the live transfer's handles.
func TestClearTransferOldGenerationNoOp(t *testing.T) {
	a := &App{}
	g1 := a.beginTransfer()
	sc1, conn1 := &fakeCloser{}, &fakeCloser{}
	a.setSignaling(g1, sc1)
	a.setConn(g1, conn1)

	g2 := a.beginTransfer()
	sc2, conn2 := &fakeCloser{}, &fakeCloser{}
	if !a.setSignaling(g2, sc2) || !a.setConn(g2, conn2) {
		t.Fatal("setters refused the new live generation")
	}

	// The old goroutine exits up to 30 seconds later and runs its deferred
	// clear. It must be a no-op against the new generation's slots.
	a.clearTransfer(g1)

	a.CancelTransfer()
	if sc2.closed != 1 || conn2.closed != 1 {
		t.Fatalf("cancel missed the live handles after an old clear: sc2=%d conn2=%d, want 1/1", sc2.closed, conn2.closed)
	}
	if sc1.closed != 0 || conn1.closed != 0 {
		t.Fatalf("cancel closed the dead generation's handles: sc1=%d conn1=%d, want 0/0", sc1.closed, conn1.closed)
	}
}

// TestSupersededSetterRefuses: a goroutine whose generation was superseded must
// not be able to register handles into the live transfer's slots.
func TestSupersededSetterRefuses(t *testing.T) {
	a := &App{}
	g1 := a.beginTransfer()
	_ = a.beginTransfer() // g2 supersedes g1

	stale := &fakeCloser{}
	if a.setSignaling(g1, stale) {
		t.Fatal("superseded setSignaling accepted a handle")
	}
	if a.setConn(g1, stale) {
		t.Fatal("superseded setConn accepted a handle")
	}
	a.CancelTransfer()
	if stale.closed != 0 {
		t.Fatalf("cancel closed a handle that never entered the slots: %d, want 0", stale.closed)
	}
}

// TestCancelledSetterRefuses: after a cancel, the cancelled generation's own
// setters must refuse, so the goroutine bails instead of parking in WebRTC
// setup with an orphaned connection.
func TestCancelledSetterRefuses(t *testing.T) {
	a := &App{}
	g := a.beginTransfer()
	a.CancelTransfer()
	if a.setSignaling(g, &fakeCloser{}) {
		t.Fatal("cancelled setSignaling accepted a handle")
	}
	if a.setConn(g, &fakeCloser{}) {
		t.Fatal("cancelled setConn accepted a handle")
	}
}

// TestCancelThenBeginReArms pins the most common real flow (Cancel, then Start
// over): beginTransfer after a cancel must fully re-arm the machinery, which
// depends on it resetting the cancelled flag.
func TestCancelThenBeginReArms(t *testing.T) {
	a := &App{}
	_ = a.beginTransfer()
	a.CancelTransfer()
	g2 := a.beginTransfer()
	if !a.setSignaling(g2, &fakeCloser{}) || !a.setConn(g2, &fakeCloser{}) {
		t.Fatal("setters refused the fresh generation after a cancel")
	}
	if !a.transferActive(g2) {
		t.Fatal("fresh generation not active after a cancel")
	}
}

// TestCloseBlockedLifecycle pins the close guard's predicate across the
// transfer lifecycle, including the superseded-generation hole: an old
// goroutine's stale deferred clear must not un-guard the live transfer.
func TestCloseBlockedLifecycle(t *testing.T) {
	a := &App{}

	if a.closeBlocked() {
		t.Fatal("fresh app must not block close")
	}

	g1 := a.beginTransfer()
	if !a.closeBlocked() {
		t.Fatal("live transfer must block close")
	}

	a.clearTransfer(g1)
	if a.closeBlocked() {
		t.Fatal("finished transfer must not block close")
	}

	// Supersede: g2 begins, then g1's stale deferred clear fires late.
	g1 = a.beginTransfer()
	g2 := a.beginTransfer()
	a.clearTransfer(g1) // stale; must be a no-op
	if !a.closeBlocked() {
		t.Fatal("a superseded goroutine's stale clear un-guarded the live transfer")
	}
	a.clearTransfer(g2)
	if a.closeBlocked() {
		t.Fatal("live transfer's clear must un-guard")
	}

	// A cancelled transfer must not prompt a user who already gave up.
	a.beginTransfer()
	a.CancelTransfer()
	if a.closeBlocked() {
		t.Fatal("cancelled transfer must not block close")
	}
}

// TestConfirmCloseCancelsLatchesAndQuits: Close anyway aborts the transfer,
// quits exactly once, and latches allowClose one-way, so not even a LATER
// transfer can re-block the close that is already in motion.
func TestConfirmCloseCancelsLatchesAndQuits(t *testing.T) {
	quits := 0
	a := &App{quitFn: func() { quits++ }}

	g := a.beginTransfer()
	sc, conn := &fakeCloser{}, &fakeCloser{}
	if !a.setSignaling(g, sc) || !a.setConn(g, conn) {
		t.Fatal("setters refused for the live generation")
	}

	a.ConfirmClose()

	if sc.closed != 1 || conn.closed != 1 {
		t.Fatalf("handles closed sc=%d conn=%d, want 1 and 1", sc.closed, conn.closed)
	}
	if quits != 1 {
		t.Fatalf("quit called %d times, want 1", quits)
	}
	if a.closeBlocked() {
		t.Fatal("close still blocked after ConfirmClose")
	}

	// The latch is one-way by design: the app is exiting, and a transfer that
	// somehow begins during teardown must not resurrect the guard.
	a.beginTransfer()
	if a.closeBlocked() {
		t.Fatal("allowClose latch did not survive a later beginTransfer")
	}
}

// TestConfirmCloseIdle covers "transfer finished while the dialog was open,
// user clicks Close anyway": nothing to cancel, quit still happens.
func TestConfirmCloseIdle(t *testing.T) {
	quits := 0
	a := &App{quitFn: func() { quits++ }}
	a.ConfirmClose()
	if quits != 1 {
		t.Fatalf("quit called %d times, want 1", quits)
	}
}
