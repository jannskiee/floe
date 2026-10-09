package main

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

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
	want := "Floe - receive failed|The transfer didn't finish"
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

// toastTap records what reached each delivery seam of notify. A toast is
// whatever arrives at notifyFn (the existing seam) or pushFn (the one that
// carries the sound flag); with neither set, notify would call the Wails
// runtime, which a bare test App must never reach.
type toastTap struct {
	mu     sync.Mutex
	sent   []string
	silent []bool
}

func (r *toastTap) wire(a *App) {
	a.pushFn = func(title, body string, silent bool) {
		r.mu.Lock()
		r.sent = append(r.sent, title+"|"+body)
		r.silent = append(r.silent, silent)
		r.mu.Unlock()
	}
}

func (r *toastTap) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.sent)
}

// setFloeInFront sets the foreground rule's seam for one test.
func setFloeInFront(t *testing.T, front bool) {
	t.Helper()
	prev := floeInFrontFn
	floeInFrontFn = func() bool { return front }
	t.Cleanup(func() { floeInFrontFn = prev })
}

// TestNotifyOffSendsNothing (S-11): with Show notifications off, nothing
// reaches either delivery seam from any of the app's toasts: a literal notify,
// the failure toast, and all three request toasts. Run once per seam.
func TestNotifyOffSendsNothing(t *testing.T) {
	for _, seam := range []string{"notifyFn", "pushFn"} {
		a, rec := attentionApp(t, nil)
		count := func() int { _, _, toasts := rec.snapshot(); return len(toasts) }
		if seam == "pushFn" {
			var tap toastTap
			a.notifyFn = nil // attentionApp wires the lane recorder here
			tap.wire(a)
			count = tap.count
		}
		g := a.beginTransfer()
		fire := func() {
			a.notify("Floe", "Files received.")
			a.notifyTransferFailed(g, "Floe - receive failed")
			a.notifyRequest(1, toastRequestArrived)
			a.notifyRequest(1, toastDropDone)
			a.notifyRequest(1, toastDropFailed)
		}

		a.cfg.NoToasts = true
		fire()
		if n := count(); n != 0 {
			t.Fatalf("%s: %d toasts reached the seam with notifications off", seam, n)
		}

		// Notifications back on: each of the five arrives, so the zero above
		// was the gate and not a broken harness.
		a.cfg.NoToasts = false
		fire()
		if n := count(); n != 5 {
			t.Fatalf("%s: %d toasts with notifications on, want 5", seam, n)
		}
	}
}

// TestNotifyOffKeepsFlashAndTitle: the request floor never turns off. With
// notifications off a prompt still flashes the taskbar and sets "(1) Floe",
// and sends no toast; Accept puts both back.
func TestNotifyOffKeepsFlashAndTitle(t *testing.T) {
	a, rec := attentionApp(t, nil)
	a.cfg.NoToasts = true

	a.openPrompt(1, RequestPrompt{})
	titles, flashes, toasts := rec.snapshot()
	if len(toasts) != 0 {
		t.Fatalf("a prompt toasted with notifications off: %q", toasts)
	}
	if len(flashes) != 1 || !flashes[0] {
		t.Fatalf("flashes after the prompt = %v, want one start", flashes)
	}
	if len(titles) == 0 || titles[len(titles)-1] != "(1) Floe" {
		t.Fatalf("titles after the prompt = %q, want the last to be (1) Floe", titles)
	}

	a.acceptDrop(1, RequestResult{})
	titles, flashes, _ = rec.snapshot()
	if len(flashes) != 2 || flashes[1] {
		t.Fatalf("flashes after Accept = %v, want a stop", flashes)
	}
	if titles[len(titles)-1] != "Floe" {
		t.Fatalf("titles after Accept = %q, want the last to be Floe", titles)
	}
}

// TestNotifySilentReachesPush: the sound preference rides to the delivery
// seam as the silent flag, with the title and body untouched.
func TestNotifySilentReachesPush(t *testing.T) {
	var tap toastTap
	a := &App{}
	tap.wire(a)

	a.notify("Floe", "Files received.")
	a.cfg.SilentToasts = true
	a.notify("Floe", "Files received.")

	if len(tap.sent) != 2 {
		t.Fatalf("%d toasts, want 2: %q", len(tap.sent), tap.sent)
	}
	if tap.silent[0] || !tap.silent[1] {
		t.Errorf("silent flags = %v, want [false true]", tap.silent)
	}
	for _, s := range tap.sent {
		if s != "Floe|Files received." {
			t.Errorf("toast text = %q, want it untouched", s)
		}
	}
}

// TestNotifySkippedWhileFloeInFront (S-12): no OS toast while Floe is the
// foreground window and the PC is in use; the same call delivers once Floe is
// behind another window, minimized or the PC idle.
func TestNotifySkippedWhileFloeInFront(t *testing.T) {
	var tap toastTap
	a := &App{}
	tap.wire(a)

	setFloeInFront(t, true)
	a.notify("Floe", "Files received.")
	if n := tap.count(); n != 0 {
		t.Fatalf("a toast fired while Floe was in front: %q", tap.sent)
	}
	setFloeInFront(t, false)
	a.notify("Floe", "Files received.")
	if n := tap.count(); n != 1 {
		t.Fatalf("%d toasts with Floe in the background, want 1", n)
	}
}

// TestNotifyReadsPrefsAtSendTime: the gate reads the preferences when the
// toast fires, never a copy taken when the transfer began, so flipping the
// switch mid-transfer applies to the toast at its end.
func TestNotifyReadsPrefsAtSendTime(t *testing.T) {
	var tap toastTap
	a := &App{}
	tap.wire(a)
	g := a.beginTransfer() // the transfer is under way

	if err := a.SetToasts(false); err != nil {
		t.Fatal(err)
	}
	a.notifyTransferFailed(g, "Floe - send failed")
	if n := tap.count(); n != 0 {
		t.Fatalf("a toast fired after notifications were switched off mid-transfer: %q", tap.sent)
	}
	if err := a.SetToasts(true); err != nil {
		t.Fatal(err)
	}
	if err := a.SetToastSound(false); err != nil {
		t.Fatal(err)
	}
	a.notifyTransferFailed(g, "Floe - send failed")
	if len(tap.sent) != 1 || !tap.silent[0] {
		t.Fatalf("toasts = %q silent = %v, want one silent toast after the switches changed back", tap.sent, tap.silent)
	}
}
