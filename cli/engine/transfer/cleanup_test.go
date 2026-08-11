// Partial-file cleanup tests: a receive that fails or is interrupted must not
// leave a half-written file behind under its final name, while completed files
// and successful transfers keep everything. Driven with raw senders over real
// in-process pion pairs (see loopback_test.go for the harness); timeout vars
// are shrunk per test and restored via t.Cleanup, set BEFORE the receiver
// goroutine starts, matching watchdog_test.go.
package transfer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// listDir returns the recursive file names under dir, for "nothing left
// behind" assertions that also catch de-collided names and stray subfiles.
func listDir(t *testing.T, dir string) []string {
	t.Helper()
	var names []string
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			rel, _ := filepath.Rel(dir, path)
			names = append(names, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", dir, err)
	}
	return names
}

// TestReceiverStallMidFileRemovesPartial: the mid-file stall watchdog fires
// and the partial file must be deleted, not left at its final name.
func TestReceiverStallMidFileRemovesPartial(t *testing.T) {
	oldIdle, oldStall := receiveIdleTimeout, receiveStallTimeout
	receiveIdleTimeout = 5 * time.Second
	receiveStallTimeout = 500 * time.Millisecond
	t.Cleanup(func() { receiveIdleTimeout = oldIdle; receiveStallTimeout = oldStall })

	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	outDir := t.TempDir()
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFiles(dc, outDir, true, "", "")
	}()

	time.Sleep(300 * time.Millisecond)

	meta := `{"type":"metadata","id":"c-1","fileName":"stall.bin","fileSize":4096,"index":1,"total":1,"totalBytes":4096}`
	if err := sender.SendText(meta); err != nil {
		t.Fatalf("SendText metadata: %v", err)
	}
	if err := sender.Send(make([]byte, 1024)); err != nil {
		t.Fatalf("Send chunk: %v", err)
	}

	select {
	case err := <-recvErr:
		if err == nil || !strings.Contains(err.Error(), "stall") {
			t.Fatalf("expected a stall error, got: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("ReceiveFiles did not return")
	}
	if left := listDir(t, outDir); len(left) != 0 {
		t.Fatalf("expected an empty output dir after a stalled receive, found %v", left)
	}
}

// TestReceiverShortEndRemovesPartial: an "end" marker with a short byte count
// closes the handle before the integrity check, so the truncated file needs
// its own removal on that path.
func TestReceiverShortEndRemovesPartial(t *testing.T) {
	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	outDir := t.TempDir()
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFiles(dc, outDir, true, "", "")
	}()

	time.Sleep(300 * time.Millisecond)

	meta := `{"type":"metadata","id":"c-2","fileName":"short.bin","fileSize":4096,"index":1,"total":1,"totalBytes":4096}`
	if err := sender.SendText(meta); err != nil {
		t.Fatalf("SendText metadata: %v", err)
	}
	if err := sender.Send(make([]byte, 1024)); err != nil {
		t.Fatalf("Send chunk: %v", err)
	}
	if err := sender.SendText(`{"type":"end"}`); err != nil {
		t.Fatalf("SendText end: %v", err)
	}

	select {
	case err := <-recvErr:
		if err == nil || !strings.Contains(err.Error(), "incomplete file") {
			t.Fatalf("expected an incomplete-file error, got: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("ReceiveFiles did not return")
	}
	if left := listDir(t, outDir); len(left) != 0 {
		t.Fatalf("expected the truncated file to be removed, found %v", left)
	}
}

// TestReceiverCloseMidFileRemovesPartial: the sender's channel closes while a
// file is half-written; the deferred cleanup must remove the partial.
func TestReceiverCloseMidFileRemovesPartial(t *testing.T) {
	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	outDir := t.TempDir()
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFiles(dc, outDir, true, "", "")
	}()

	time.Sleep(300 * time.Millisecond)

	meta := `{"type":"metadata","id":"c-3","fileName":"cut.bin","fileSize":4096,"index":1,"total":1,"totalBytes":4096}`
	if err := sender.SendText(meta); err != nil {
		t.Fatalf("SendText metadata: %v", err)
	}
	if err := sender.Send(make([]byte, 1024)); err != nil {
		t.Fatalf("Send chunk: %v", err)
	}
	// Give the chunk time to land before the close races it.
	time.Sleep(300 * time.Millisecond)
	if err := sender.Close(); err != nil {
		t.Fatalf("sender close: %v", err)
	}

	select {
	case err := <-recvErr:
		if err == nil || !strings.Contains(err.Error(), "connection closed mid-transfer") {
			t.Fatalf("expected a connection-closed error, got: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("ReceiveFiles did not return")
	}
	if left := listDir(t, outDir); len(left) != 0 {
		t.Fatalf("expected an empty output dir after a cut receive, found %v", left)
	}
}

// TestReceiverSuccessKeepsFile pins the other side of the contract: the
// cleanup must never remove a completed file on the success path.
func TestReceiverSuccessKeepsFile(t *testing.T) {
	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	outDir := t.TempDir()
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFiles(dc, outDir, true, "", "")
	}()

	time.Sleep(300 * time.Millisecond)

	meta := `{"type":"metadata","id":"c-4","fileName":"ok.bin","fileSize":4,"index":1,"total":1,"totalBytes":4}`
	if err := sender.SendText(meta); err != nil {
		t.Fatalf("SendText metadata: %v", err)
	}
	if err := sender.Send(make([]byte, 4)); err != nil {
		t.Fatalf("Send chunk: %v", err)
	}
	if err := sender.SendText(`{"type":"end"}`); err != nil {
		t.Fatalf("SendText end: %v", err)
	}
	// Close so the receiver's post-completion grace wait ends immediately.
	time.Sleep(300 * time.Millisecond)
	_ = sender.Close()

	select {
	case err := <-recvErr:
		if err != nil {
			t.Fatalf("expected success, got: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("ReceiveFiles did not return")
	}
	got, err := os.ReadFile(filepath.Join(outDir, "ok.bin"))
	if err != nil {
		t.Fatalf("completed file missing after success: %v", err)
	}
	if len(got) != 4 {
		t.Fatalf("completed file has %d bytes, want 4", len(got))
	}
}

// TestReceiverMidBatchFailureKeepsCompletedFiles: when file 2 of a batch is
// interrupted, file 1 must survive intact and only the in-flight partial is
// removed.
func TestReceiverMidBatchFailureKeepsCompletedFiles(t *testing.T) {
	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	outDir := t.TempDir()
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFiles(dc, outDir, true, "", "")
	}()

	time.Sleep(300 * time.Millisecond)

	m1 := `{"type":"metadata","id":"c-5a","fileName":"first.bin","fileSize":4,"index":1,"total":2,"totalBytes":4100}`
	if err := sender.SendText(m1); err != nil {
		t.Fatalf("SendText metadata 1: %v", err)
	}
	if err := sender.Send(make([]byte, 4)); err != nil {
		t.Fatalf("Send chunk 1: %v", err)
	}
	if err := sender.SendText(`{"type":"end"}`); err != nil {
		t.Fatalf("SendText end 1: %v", err)
	}
	m2 := `{"type":"metadata","id":"c-5b","fileName":"second.bin","fileSize":4096,"index":2,"total":2,"totalBytes":4100}`
	if err := sender.SendText(m2); err != nil {
		t.Fatalf("SendText metadata 2: %v", err)
	}
	if err := sender.Send(make([]byte, 1024)); err != nil {
		t.Fatalf("Send chunk 2: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	if err := sender.Close(); err != nil {
		t.Fatalf("sender close: %v", err)
	}

	select {
	case err := <-recvErr:
		if err == nil || !strings.Contains(err.Error(), "connection closed mid-transfer") {
			t.Fatalf("expected a connection-closed error, got: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("ReceiveFiles did not return")
	}

	got, err := os.ReadFile(filepath.Join(outDir, "first.bin"))
	if err != nil {
		t.Fatalf("completed first.bin missing after mid-batch failure: %v", err)
	}
	if len(got) != 4 {
		t.Fatalf("first.bin has %d bytes, want 4", len(got))
	}
	if left := listDir(t, outDir); len(left) != 1 || left[0] != "first.bin" {
		t.Fatalf("expected only first.bin to remain, found %v", left)
	}
}

// TestReceiverAbandonedFileCleanedOnNextMetadata: a second metadata while a
// file is still open (no "end") must close and delete the abandoned partial,
// not leak the handle or leave the half-written file.
func TestReceiverAbandonedFileCleanedOnNextMetadata(t *testing.T) {
	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	outDir := t.TempDir()
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFiles(dc, outDir, true, "", "")
	}()

	time.Sleep(300 * time.Millisecond)

	mA := `{"type":"metadata","id":"c-6a","fileName":"abandoned.bin","fileSize":4096,"index":1,"total":2,"totalBytes":4100}`
	if err := sender.SendText(mA); err != nil {
		t.Fatalf("SendText metadata A: %v", err)
	}
	if err := sender.Send(make([]byte, 1024)); err != nil {
		t.Fatalf("Send chunk A: %v", err)
	}
	// No "end" for A: the sender abandons it and starts B.
	mB := `{"type":"metadata","id":"c-6b","fileName":"kept.bin","fileSize":4,"index":2,"total":2,"totalBytes":4100}`
	if err := sender.SendText(mB); err != nil {
		t.Fatalf("SendText metadata B: %v", err)
	}
	if err := sender.Send(make([]byte, 4)); err != nil {
		t.Fatalf("Send chunk B: %v", err)
	}
	if err := sender.SendText(`{"type":"end"}`); err != nil {
		t.Fatalf("SendText end B: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	if err := sender.Close(); err != nil {
		t.Fatalf("sender close: %v", err)
	}

	select {
	case err := <-recvErr:
		// B completed but A never did, so the batch ends short: 1 of 2 files.
		if err == nil || !strings.Contains(err.Error(), "after 1 of 2 files") {
			t.Fatalf("expected a 1-of-2-files close error, got: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("ReceiveFiles did not return")
	}

	got, err := os.ReadFile(filepath.Join(outDir, "kept.bin"))
	if err != nil {
		t.Fatalf("completed kept.bin missing: %v", err)
	}
	if len(got) != 4 {
		t.Fatalf("kept.bin has %d bytes, want 4", len(got))
	}
	if left := listDir(t, outDir); len(left) != 1 || left[0] != "kept.bin" {
		t.Fatalf("expected only kept.bin to remain (abandoned.bin cleaned), found %v", left)
	}
}
