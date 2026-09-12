package main

import (
	"os"
	"path/filepath"
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
