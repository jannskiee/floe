package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestShareLink guards the property that matters: the room id is the transfer's
// only secret, so it must live in the URL fragment, which browsers never send to
// a server. Anything before the '#' does reach the server, so the room id
// appearing there would leak it into access logs, Referer headers, and analytics.
func TestShareLink(t *testing.T) {
	const (
		base   = "https://floe.one"
		nonce  = "deadbeef"
		roomID = "6f207790-92a6-4662-bb68-4c4059f75139"
	)

	got := shareLink(base, nonce, roomID)

	if want := base + "/?s=" + nonce + "#room=" + roomID; got != want {
		t.Errorf("shareLink = %q, want %q", got, want)
	}

	// The invariant, asserted independently of the exact shape above.
	beforeFragment, _, found := strings.Cut(got, "#")
	if !found {
		t.Fatalf("shareLink = %q, want a '#' fragment", got)
	}
	if strings.Contains(beforeFragment, roomID) {
		t.Errorf("room id leaked into the server-visible part %q", beforeFragment)
	}
	if strings.Contains(got, "?room=") {
		t.Errorf("shareLink = %q, must not use the leaky ?room= form", got)
	}
	if strings.Contains(got, base+"//") {
		t.Errorf("shareLink = %q, has a double slash after the host", got)
	}
}

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

// TestFilterFileArgs verifies command-line arg filtering keeps only existing
// files/dirs and drops flags, empties, and stale paths.
func TestFilterFileArgs(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	got := filterFileArgs([]string{
		file,
		dir,
		filepath.Join(dir, "missing.bin"),
		"--flag",
		"-v",
		"",
	})

	if len(got) != 2 || got[0] != file || got[1] != dir {
		t.Errorf("filterFileArgs = %v, want [%s %s]", got, file, dir)
	}
}

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

// TestFailureToastsOnce: a live generation's failure produces exactly one
// notification with the generic body (raw engine errors stay off toasts).
func TestFailureToastsOnce(t *testing.T) {
	var got []string
	a := &App{notifyFn: func(title, body string) { got = append(got, title+"|"+body) }}
	g := a.beginTransfer()
	a.notifyTransferFailed(g, "Floe - receive failed")
	if len(got) != 1 {
		t.Fatalf("notified %d times, want 1: %v", len(got), got)
	}
	want := "Floe - receive failed|The transfer did not complete. Open Floe to see what happened."
	if got[0] != want {
		t.Fatalf("notification = %q, want %q", got[0], want)
	}
}

// TestCancelSuppressesFailureToast: a user cancel is not a failure and must
// not toast.
func TestCancelSuppressesFailureToast(t *testing.T) {
	calls := 0
	a := &App{notifyFn: func(string, string) { calls++ }}
	g := a.beginTransfer()
	a.CancelTransfer()
	a.notifyTransferFailed(g, "Floe - receive failed")
	if calls != 0 {
		t.Fatalf("cancelled transfer toasted %d times, want 0", calls)
	}
}

// TestSupersededTransferDoesNotToast: a dead attempt must not toast over the
// live one.
func TestSupersededTransferDoesNotToast(t *testing.T) {
	calls := 0
	a := &App{notifyFn: func(string, string) { calls++ }}
	g1 := a.beginTransfer()
	_ = a.beginTransfer()
	a.notifyTransferFailed(g1, "Floe - send failed")
	if calls != 0 {
		t.Fatalf("superseded transfer toasted %d times, want 0", calls)
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

// TestSecondInstanceFilesStageUntilFirstPull pins the multi-select "Send with
// Floe" fix. Explorer launches one process per selected file; before the
// frontend's first pull every forward must be staged (an emit would be
// silently discarded by the JS event bus, which is how five selected files
// used to arrive as one), and after the pull forwards are emitted.
func TestSecondInstanceFilesStageUntilFirstPull(t *testing.T) {
	a := &App{}

	if a.stageOrEmit([]string{"a"}) {
		t.Fatal("first forward before the pull should stage, not emit")
	}
	if a.stageOrEmit([]string{"b", "c"}) {
		t.Fatal("burst forward before the pull should stage, not emit")
	}

	got := a.GetPendingFiles()
	if len(got) != 3 || got[0] != "a" || got[1] != "b" || got[2] != "c" {
		t.Fatalf("pull = %v, want [a b c]", got)
	}

	if !a.stageOrEmit([]string{"d"}) {
		t.Fatal("forward after the pull should emit")
	}
	if late := a.GetPendingFiles(); late != nil {
		t.Fatalf("emit path must stage nothing, second pull = %v", late)
	}
}

// TestStageOrEmitEmptyNoOp preserves the existing gate: launches with no file
// arguments neither stage nor emit.
func TestStageOrEmitEmptyNoOp(t *testing.T) {
	a := &App{}
	if a.stageOrEmit(nil) {
		t.Fatal("empty forward emitted before ready")
	}
	a.GetPendingFiles()
	if a.stageOrEmit(nil) {
		t.Fatal("empty forward emitted after ready")
	}
	if got := a.GetPendingFiles(); got != nil {
		t.Fatalf("empty forwards staged something: %v", got)
	}
}

// TestColdStartArgsMergeWithStagedFiles pins the startup interleave: a second
// instance can stage files BEFORE the startup goroutine stages the cold-start
// arguments, and startup must merge rather than assign, or the earlier files
// are silently discarded.
func TestColdStartArgsMergeWithStagedFiles(t *testing.T) {
	a := &App{}

	// A second instance lands first (the nil-ctx path appends directly).
	if a.stageOrEmit([]string{"second-instance.txt"}) {
		t.Fatal("should stage")
	}
	// Then startup stages the cold-start args through the same seam.
	if a.stageOrEmit([]string{"cold-start.txt"}) {
		t.Fatal("should stage")
	}

	got := a.GetPendingFiles()
	if len(got) != 2 || got[0] != "second-instance.txt" || got[1] != "cold-start.txt" {
		t.Fatalf("pull = %v, want both files in arrival order", got)
	}
}

// TestGetPendingFilesDrains: the pull clears the staging area.
func TestGetPendingFilesDrains(t *testing.T) {
	a := &App{pendingFiles: []string{"x"}}
	if got := a.GetPendingFiles(); len(got) != 1 {
		t.Fatalf("first pull = %v", got)
	}
	if got := a.GetPendingFiles(); got != nil {
		t.Fatalf("second pull = %v, want nil", got)
	}
}
