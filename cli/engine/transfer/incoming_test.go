package transfer

// The OnIncoming contract (ReceiveOptions.OnIncoming): it fires exactly once,
// with the batch summary, before the first OnProgress call. Driven with raw
// senders over real in-process pion pairs (see loopback_test.go for the
// harness).

import (
	"testing"
	"time"
)

// TestReceiverIncomingHookFiresBeforeFirstByte: OnIncoming must fire exactly
// once, with the batch summary, strictly before any OnProgress call.
func TestReceiverIncomingHookFiresBeforeFirstByte(t *testing.T) {
	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	outDir := t.TempDir()
	// Both callbacks run on the receive loop goroutine, so an unlocked slice
	// is safe; the test reads it only after the receive returns.
	var events []string
	var got IncomingInfo
	opts := ReceiveOptions{
		OnIncoming: func(inc IncomingInfo) {
			events = append(events, "incoming")
			got = inc
		},
		OnProgress: func(Progress) {
			events = append(events, "progress")
		},
	}
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFilesWithOptions(dc, outDir, true, "", "", opts)
	}()

	time.Sleep(300 * time.Millisecond)

	meta := `{"type":"metadata","id":"c-7","fileName":"a.txt","fileSize":4,"index":1,"total":1,"totalBytes":4}`
	if err := sender.SendText(meta); err != nil {
		t.Fatalf("SendText metadata: %v", err)
	}
	if err := sender.Send(make([]byte, 4)); err != nil {
		t.Fatalf("Send chunk: %v", err)
	}
	if err := sender.SendText(`{"type":"end"}`); err != nil {
		t.Fatalf("SendText end: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	_ = sender.Close()

	select {
	case err := <-recvErr:
		if err != nil {
			t.Fatalf("expected success, got: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("ReceiveFilesWithOptions did not return")
	}

	if len(events) == 0 || events[0] != "incoming" {
		t.Fatalf("expected the incoming hook to fire before any progress, got sequence %v", events)
	}
	if n := countOf(events, "incoming"); n != 1 {
		t.Fatalf("incoming hook fired %d times, want exactly 1", n)
	}
	if n := countOf(events, "progress"); n < 1 {
		t.Fatalf("no progress events fired, so the before-progress ordering claim is vacuous: %v", events)
	}
	if got.Files != 1 || got.TotalBytes != 4 || got.FirstName != "a.txt" {
		t.Fatalf("incoming payload = %+v, want Files=1 TotalBytes=4 FirstName=a.txt", got)
	}
}

// TestReceiverIncomingHookLegacyFallback: a sender that predates totalBytes
// still yields the single file's size in the incoming summary.
func TestReceiverIncomingHookLegacyFallback(t *testing.T) {
	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	outDir := t.TempDir()
	var got IncomingInfo
	fired := 0
	opts := ReceiveOptions{
		OnIncoming: func(inc IncomingInfo) { fired++; got = inc },
	}
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFilesWithOptions(dc, outDir, true, "", "", opts)
	}()

	time.Sleep(300 * time.Millisecond)

	// No totalBytes field, like a pre-1.6.0 sender.
	meta := `{"type":"metadata","id":"c-8","fileName":"old.bin","fileSize":4,"index":1,"total":1}`
	if err := sender.SendText(meta); err != nil {
		t.Fatalf("SendText metadata: %v", err)
	}
	if err := sender.Send(make([]byte, 4)); err != nil {
		t.Fatalf("Send chunk: %v", err)
	}
	if err := sender.SendText(`{"type":"end"}`); err != nil {
		t.Fatalf("SendText end: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	_ = sender.Close()

	select {
	case err := <-recvErr:
		if err != nil {
			t.Fatalf("expected success, got: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("ReceiveFilesWithOptions did not return")
	}
	if fired != 1 {
		t.Fatalf("incoming hook fired %d times, want 1", fired)
	}
	if got.TotalBytes != 4 {
		t.Fatalf("legacy fallback TotalBytes = %d, want the file size 4", got.TotalBytes)
	}
}

func countOf(list []string, want string) int {
	n := 0
	for _, s := range list {
		if s == want {
			n++
		}
	}
	return n
}
