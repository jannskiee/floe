// Watchdog tests: the receiver's stall timeouts and the sender's fast-fail on
// data channel close, over real in-process pion pairs (see loopback_test.go
// for the harness). Timeout vars are shrunk per test and restored via
// t.Cleanup; they must be set BEFORE the receiver goroutine starts.
package transfer

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestReceiverStallBeforeMetadata reproduces the captured CI failure mode:
// both sides connect, then no data ever arrives. The receiver must fail fast
// with a clear pre-metadata stall error instead of hanging forever.
func TestReceiverStallBeforeMetadata(t *testing.T) {
	old := receiveIdleTimeout
	receiveIdleTimeout = 500 * time.Millisecond
	t.Cleanup(func() { receiveIdleTimeout = old })

	_, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	outDir := t.TempDir()
	start := time.Now()
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFiles(dc, outDir, true, "", "")
	}()

	select {
	case err := <-recvErr:
		if err == nil {
			t.Fatal("expected a stall error, got nil")
		}
		if !strings.Contains(err.Error(), "no data arrived") {
			t.Fatalf("expected a no-data stall error, got: %v", err)
		}
		if elapsed := time.Since(start); elapsed > 5*time.Second {
			t.Fatalf("stall error took %v; want well under 5s", elapsed)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("ReceiveFiles did not return; the pre-metadata watchdog is missing")
	}
}

// TestReceiverStallMidFile drives the receiver with a raw sender that delivers
// metadata plus a partial chunk and then goes silent without closing. The
// receiver must fail with a mid-file stall error naming the file and progress.
func TestReceiverStallMidFile(t *testing.T) {
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

	// Let the receiver register its OnMessage handler before sending: pion
	// drops messages delivered while the handler is nil.
	time.Sleep(300 * time.Millisecond)

	meta := `{"type":"metadata","id":"stall-1","fileName":"stall.bin","fileSize":4096,"index":1,"total":1,"totalBytes":4096}`
	if err := sender.SendText(meta); err != nil {
		t.Fatalf("SendText metadata: %v", err)
	}
	// Zero bytes: the first byte 0x00 fails the JSON-object probe, so this is
	// written as file data (1024 of the promised 4096). Then: silence.
	if err := sender.Send(make([]byte, 1024)); err != nil {
		t.Fatalf("Send chunk: %v", err)
	}

	select {
	case err := <-recvErr:
		if err == nil {
			t.Fatal("expected a stall error, got nil")
		}
		if !strings.Contains(err.Error(), "stall.bin") || !strings.Contains(err.Error(), "1024 of 4096") {
			t.Fatalf("expected a mid-file stall naming stall.bin with 1024 of 4096, got: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("ReceiveFiles did not return; the mid-transfer watchdog is missing")
	}
}

// TestReceiverNoMisfireWhileFlowing guards the timer-arming semantics: the
// watchdog measures only time blocked on an empty message queue, so a normal
// transfer must succeed even with a stall timeout far below its total
// duration. A misfire here means the timer is being armed or reset wrong.
func TestReceiverNoMisfireWhileFlowing(t *testing.T) {
	oldStall := receiveStallTimeout
	receiveStallTimeout = 2 * time.Second
	t.Cleanup(func() { receiveStallTimeout = oldStall })

	srcDir := t.TempDir()
	src := filepath.Join(srcDir, "flow.bin")
	content := bytes.Repeat([]byte{0xAB}, 2*1024*1024)
	if err := os.WriteFile(src, content, 0644); err != nil {
		t.Fatal(err)
	}

	outDir := runTransfer(t, []string{src})

	got, err := os.ReadFile(filepath.Join(outDir, "flow.bin"))
	if err != nil {
		t.Fatalf("received file missing: %v", err)
	}
	if !bytes.Equal(got, content) {
		t.Fatalf("received %d bytes, want %d identical bytes", len(got), len(content))
	}
}

// TestSenderAckWaitConnectionClosed: the receiver's data channel closes while
// the sender is waiting for an ack (the decline path and any receiver
// error-exit land here). The sender must fail in seconds via its done channel,
// not burn the 120-second ack deadline.
func TestSenderAckWaitConnectionClosed(t *testing.T) {
	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	srcDir := t.TempDir()
	src := filepath.Join(srcDir, "closed.bin")
	if err := os.WriteFile(src, make([]byte, 4096), 0644); err != nil {
		t.Fatal(err)
	}

	// Take the receiver's channel but never run ReceiveFiles: no ack will come.
	dc := <-recvCh

	start := time.Now()
	sendErr := make(chan error, 1)
	go func() { sendErr <- SendFiles(sender, []string{src}, "") }()

	// Let the sender send metadata and enter its ack wait, then close the
	// receiving side gracefully (stream reset reaches the sender's OnClose).
	time.Sleep(300 * time.Millisecond)
	if err := dc.Close(); err != nil {
		t.Fatalf("receiver dc close: %v", err)
	}

	select {
	case err := <-sendErr:
		if err == nil {
			t.Fatal("expected an error after the receiver closed, got nil")
		}
		if !strings.Contains(err.Error(), "connection closed while waiting") {
			t.Fatalf("expected a connection-closed ack-wait error, got: %v", err)
		}
		if elapsed := time.Since(start); elapsed > 10*time.Second {
			t.Fatalf("sender took %v to fail; want well under 10s, never the 120s ack deadline", elapsed)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("SendFiles did not return; the done channel is not wired into the ack wait")
	}
}
