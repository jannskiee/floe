// Partial-file cleanup tests: a receive that fails or is interrupted must not
// leave a half-written file behind under its final name, while completed files
// and successful transfers keep everything. Driven with raw senders over real
// in-process pion pairs (see loopback_test.go for the harness); timeout vars
// are shrunk per test and restored via t.Cleanup, set BEFORE the receiver
// goroutine starts, matching watchdog_test.go.
package transfer

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

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
	// The staging file must be gone: success ends with a rename, not a copy,
	// so the only thing on disk is the completed file under its final name.
	if left := listDir(t, outDir); len(left) != 1 || left[0] != "ok.bin" {
		t.Fatalf("expected exactly [ok.bin] after success, found %v", left)
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

// TestReceiverDecollidedPartialRemoved pins that cleanup removes the file the
// receiver actually created, not a path recomputed from the sender's name: a
// completed "dup.bin" must survive while the interrupted second "dup.bin"
// (on disk as "dup (1).bin") is removed.
func TestReceiverDecollidedPartialRemoved(t *testing.T) {
	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	outDir := t.TempDir()
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFiles(dc, outDir, true, "", "")
	}()

	time.Sleep(300 * time.Millisecond)

	m1 := `{"type":"metadata","id":"c-9a","fileName":"dup.bin","fileSize":4,"index":1,"total":2,"totalBytes":4100}`
	if err := sender.SendText(m1); err != nil {
		t.Fatalf("SendText metadata 1: %v", err)
	}
	if err := sender.Send(make([]byte, 4)); err != nil {
		t.Fatalf("Send chunk 1: %v", err)
	}
	if err := sender.SendText(`{"type":"end"}`); err != nil {
		t.Fatalf("SendText end 1: %v", err)
	}
	m2 := `{"type":"metadata","id":"c-9b","fileName":"dup.bin","fileSize":4096,"index":2,"total":2,"totalBytes":4100}`
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
		if err == nil {
			t.Fatal("expected an error, got nil")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("ReceiveFiles did not return")
	}
	got, err := os.ReadFile(filepath.Join(outDir, "dup.bin"))
	if err != nil {
		t.Fatalf("completed dup.bin missing (cleanup removed the wrong file?): %v", err)
	}
	if len(got) != 4 {
		t.Fatalf("dup.bin has %d bytes, want the completed 4", len(got))
	}
	if left := listDir(t, outDir); len(left) != 1 || left[0] != "dup.bin" {
		t.Fatalf(`expected only the completed dup.bin ("dup (1).bin" removed), found %v`, left)
	}
}

// TestReceiverAbandonDuringEndKeepsTodaysBehavior pins the other half of the
// end arm's Sync/Close split. An abandon (the CLI's Ctrl+C handler, the
// desktop's shutdown hook) closes a finished file's handle before its end
// marker is handled, and a newer receive re-claims the path the abandon freed.
// The end arm must still read that as an abandon: no removal, no refusal to
// the peer, and above all no touching the newer claim, which is exactly what
// treating the abandon's os.ErrClosed like a real write failure would delete.
//
// Deterministic rather than a race loop in the TestCommitAbandonTorture style:
// the abandon lands at the one instant that matters, after the last byte is
// written and before "end". Earlier it makes the next Write fail instead, and
// later (after the unregister) it cannot reach the handle at all.
func TestReceiverAbandonDuringEndKeepsTodaysBehavior(t *testing.T) {
	sender, recvCh, msgs, closed, closeFn := newPumpedPair(t)
	defer closeFn()

	var rdc *webrtc.DataChannel
	select {
	case rdc = <-recvCh:
	case <-time.After(20 * time.Second):
		t.Fatal("receiver data channel never opened")
	}

	back := make(chan webrtc.DataChannelMessage, 8)
	sender.OnMessage(func(m webrtc.DataChannelMessage) {
		select {
		case back <- m:
		default:
		}
	})

	outDir := t.TempDir()
	payload := []byte("FIRST!")
	written := make(chan struct{}, 1)
	recvErr := make(chan error, 1)
	go func() {
		recvErr <- ReceiveFilesWithOptions(rdc, outDir, true, "", "", ReceiveOptions{
			Messages: msgs,
			Closed:   closed,
			// Runs right after each Write returns, on the receive goroutine.
			OnProgress: func(p Progress) {
				if p.FileBytes >= int64(len(payload)) {
					select {
					case written <- struct{}{}:
					default:
					}
				}
			},
		})
	}()

	meta := `{"type":"metadata","id":"ab-1","fileName":"race.bin","fileSize":6,"index":1,"total":1,"totalBytes":6,"pv":1,"pvMin":1}`
	if err := sender.SendText(meta); err != nil {
		t.Fatalf("SendText metadata: %v", err)
	}
	select {
	case <-back:
	case <-time.After(20 * time.Second):
		t.Fatal("receiver never acked")
	}
	if err := sender.Send(payload); err != nil {
		t.Fatalf("Send chunk: %v", err)
	}
	select {
	case <-written:
	case <-time.After(20 * time.Second):
		t.Fatal("the chunk was never written")
	}

	// The abandon closes the registered handle and removes its .part.
	AbandonPartials()

	// A newer receive claims the freed path, and it must be the SAME path, or
	// this test proves nothing about theft.
	base := filepath.Join(outDir, "race.bin")
	newer, dest, err := claimPart(base, nil)
	if err != nil {
		t.Fatalf("re-claim after the abandon: %v", err)
	}
	partPath := base + partSuffix
	if newer.Name() != partPath {
		newer.Close()
		t.Fatalf("re-claim landed at %s, want the freed %s", newer.Name(), partPath)
	}
	if _, err := newer.Write([]byte("SECOND")); err != nil {
		t.Fatalf("write the newer claim: %v", err)
	}
	if err := newer.Close(); err != nil {
		t.Fatalf("close the newer claim: %v", err)
	}

	// Only now does the stale transfer's end marker arrive.
	if err := sender.SendText(`{"type":"end"}`); err != nil {
		t.Fatalf("SendText end: %v", err)
	}

	// Errorf, not Fatalf, from here on: when this breaks, the disk checks
	// below say what the wrong branch did, which the error alone does not.
	select {
	case err := <-recvErr:
		if err == nil || !strings.Contains(err.Error(), "transfer abandoned while completing") {
			t.Errorf("expected today's abandon error, got: %v", err)
		}
		var refused *RefusedError
		if errors.As(err, &refused) {
			t.Errorf("an abandon was reported as a refusal: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("ReceiveFiles did not return")
	}

	if got, err := os.ReadFile(partPath); err != nil {
		t.Errorf("the newer claim was removed by the abandoned transfer: %v", err)
	} else if string(got) != "SECOND" {
		t.Errorf("the newer claim holds %q, want %q", got, "SECOND")
	}
	if _, err := os.Lstat(dest); !os.IsNotExist(err) {
		t.Errorf("the abandoned transfer committed a final name: %v", err)
	}

	// No refusal crossed the wire: an abandon reaches the peer as the close,
	// exactly as before.
	select {
	case m := <-back:
		var frame map[string]interface{}
		if json.Unmarshal(m.Data, &frame) == nil && frame["type"] == "incompatible" {
			t.Errorf("an abandon sent a refusal: %s", m.Data)
		}
	case <-time.After(500 * time.Millisecond):
	}
}

// TestReceiverNestedFolderPartialRemoved: a partial inside a folder transfer's
// subdirectory is removed too (the empty directories stay, by design).
func TestReceiverNestedFolderPartialRemoved(t *testing.T) {
	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	outDir := t.TempDir()
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFiles(dc, outDir, true, "", "")
	}()

	time.Sleep(300 * time.Millisecond)

	meta := `{"type":"metadata","id":"c-10","fileName":"sub/dir/part.bin","fileSize":4096,"index":1,"total":1,"totalBytes":4096}`
	if err := sender.SendText(meta); err != nil {
		t.Fatalf("SendText metadata: %v", err)
	}
	if err := sender.Send(make([]byte, 1024)); err != nil {
		t.Fatalf("Send chunk: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	if err := sender.Close(); err != nil {
		t.Fatalf("sender close: %v", err)
	}

	select {
	case err := <-recvErr:
		if err == nil {
			t.Fatal("expected an error, got nil")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("ReceiveFiles did not return")
	}
	if left := listDir(t, outDir); len(left) != 0 {
		t.Fatalf("expected no files under the folder tree, found %v", left)
	}
}
