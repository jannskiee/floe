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
// not burn the whole ack deadline, which is 120 s by default and much longer
// for a request-link visitor.
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
			t.Fatalf("sender took %v to fail; want well under 10s, never the whole ack deadline", elapsed)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("SendFiles did not return; the done channel is not wired into the ack wait")
	}
}

// The default ack wait is what every caller that leaves SendOptions.AckTimeout
// at zero gets, and it is the number the docs quote. Pinned here because the
// literal moved out of sender.go into deadlines.go, where a change would
// otherwise be invisible from the send path.
func TestSenderAckTimeoutDefaultIs120s(t *testing.T) {
	if defaultAckTimeout != 120*time.Second {
		t.Fatalf("defaultAckTimeout = %v, want 120s", defaultAckTimeout)
	}
	var zero SendOptions
	if got := ackTimeoutOrDefault(zero.AckTimeout); got != 120*time.Second {
		t.Fatalf("the zero SendOptions waits %v for an ack, want 120s", got)
	}
	if got := ackTimeoutOrDefault(-time.Second); got != 120*time.Second {
		t.Fatalf("a negative option gives %v; want the default, never a timer that has already fired", got)
	}
	if got := ackTimeoutOrDefault(VisitorAckTimeout + VisitorAckGrace); got != 615*time.Second {
		t.Fatalf("a request-link visitor's ack wait is %v, want 615s", got)
	}
}

// A caller's AckTimeout must be the wait, not the default. The option exists
// so a request-link visitor can wait 615 s instead of 120 s; one that is
// silently dropped would make that a no-op and a held Decide window would end
// in "timed out waiting for ack" after two minutes.
func TestSenderAckTimeoutHonored(t *testing.T) {
	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	srcDir := t.TempDir()
	src := filepath.Join(srcDir, "unacked.bin")
	if err := os.WriteFile(src, make([]byte, 4096), 0644); err != nil {
		t.Fatal(err)
	}

	// Take the receiver's channel and hold it OPEN without ever running
	// ReceiveFiles: no ack can arrive and no close can end the wait early, so
	// only the deadline can end it.
	dc := <-recvCh
	defer dc.Close()

	start := time.Now()
	sendErr := make(chan error, 1)
	go func() {
		sendErr <- SendFilesWithOptions(sender, []string{src}, "", SendOptions{AckTimeout: 200 * time.Millisecond})
	}()

	select {
	case err := <-sendErr:
		if err == nil || !strings.Contains(err.Error(), "timed out waiting for ack") {
			t.Fatalf("expected an ack timeout, got: %v", err)
		}
		// The only other value this wait could have taken is the 120 s
		// default, so a generous bound still discriminates. It is generous on
		// purpose: several suites share this machine.
		if elapsed := time.Since(start); elapsed > 5*time.Second {
			t.Fatalf("the sender waited %v, so the 200ms AckTimeout was ignored", elapsed)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("SendFilesWithOptions never returned; AckTimeout did not reach the ack wait")
	}
}

// timersIn lists every timer construction in a region of source text.
func timersIn(region string) (armed []string) {
	for _, line := range strings.Split(region, "\n") {
		for _, ctor := range []string{"time.After(", "time.NewTimer(", "time.NewTicker(", "time.Tick("} {
			if strings.Contains(line, ctor) {
				armed = append(armed, strings.TrimSpace(line))
				break
			}
		}
	}
	return armed
}

// The ack wait arms exactly one timer: its own deadline. That is what makes a
// much longer AckTimeout a constant change rather than a behavior change, so
// nothing else may start running while a person decides. Driving all three
// other timers in process would mean holding a real ack for minutes, so this
// is a source-shape check in the style of cli/engine/peer/setupsites_test.go.
//
// The order checked is PROGRAM order, not file order: the delivery stall timer
// and the drain ticker are written in SendFilesWithOptions, which sits earlier
// in the file than sendFile, but they are created after the per-file loop and
// therefore after every ack.
func TestSenderAckWaitArmsNothingElse(t *testing.T) {
	src, err := os.ReadFile("sender.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(src)
	at := func(needle string) int {
		i := strings.Index(text, needle)
		if i < 0 {
			t.Fatalf("sender.go no longer contains %q; re-anchor this test by symbol", needle)
		}
		return i
	}

	sendFileCall := at("if err := sendFile(")
	if at("stall := time.NewTimer(") < sendFileCall || at("drainTick := time.NewTicker(") < sendFileCall {
		t.Fatal("the delivery stall timer or the drain ticker is created before the per-file loop, so it would be running during an ack wait")
	}

	deadline := at("ackDeadline := time.After(ackTimeout)")
	ackLabel := at("\nackLoop:")
	breakAck := at("break ackLoop")
	step3 := at("// Step 3: Send binary chunks")
	backpressure := at("case <-time.After(60 * time.Second):")
	if !(deadline < ackLabel && ackLabel < breakAck && breakAck < step3 && step3 < backpressure) {
		t.Fatal("the ack deadline, the ack loop and the backpressure wait are no longer in that order; re-anchor this test")
	}

	if armed := timersIn(text[ackLabel:step3]); len(armed) != 0 {
		t.Fatalf("timers armed inside the ack wait: %q", armed)
	}

	// The rule itself must catch one: over a region with a ticker between the
	// label and the break it flags exactly that line.
	snippet := "ackLoop:\n\tfor {\n\t\tt := time.NewTicker(time.Second)\n\t\t_ = t\n\t}\n"
	if armed := timersIn(snippet); len(armed) != 1 {
		t.Fatalf("the shape rule must flag the ticker in the snippet, flagged %q", armed)
	}
}
