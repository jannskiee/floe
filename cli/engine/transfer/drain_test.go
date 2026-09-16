// The delivery wait after the last file.
//
// It used to give up after a fixed 30 s. With up to 8 MB still queued in pion's
// send buffer, any transfer that still had more than it could drain in 30 s
// (about 4 MB at 1.1 Mbps) aborted at 94 to 99 percent with "timed out waiting
// for delivery confirmation from peer", and the receiver deleted the file
// (reproduced at 250 ms RTT with 1 percent loss). The wait now gives up only after a full deliveryStallWindow in which
// the buffer did not shrink.
//
// These tests replace deliveryBuffered with a fake, so the real buffer on the
// loopback pair is irrelevant. They swap package state, so no test in this
// package may call t.Parallel (none does).
package transfer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// fakeDrain is a send buffer that shrinks by step on every read and saturates
// at zero (an unsigned subtraction past zero would wrap, and the tick arm would
// never see 0). With freezeAfterReads set, it shrinks on that many reads and
// then holds, a count rather than a clock, so a paused runner cannot move the
// freeze relative to the stall timer.
type fakeDrain struct {
	mu               sync.Mutex
	left             uint64
	step             uint64
	freezeAfterReads int
	reads            int
	first            time.Time
}

func (f *fakeDrain) read(*webrtc.DataChannel) uint64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.first.IsZero() {
		f.first = time.Now()
	}
	f.reads++
	if f.freezeAfterReads > 0 && f.reads > f.freezeAfterReads {
		return f.left
	}
	if f.left > f.step {
		f.left -= f.step
	} else {
		f.left = 0
	}
	return f.left
}

func (f *fakeDrain) firstRead() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.first
}

// useDelivery installs the fake and, when window is non-zero, a test window;
// both are restored when the test ends.
func useDelivery(t *testing.T, f *fakeDrain, window time.Duration) {
	t.Helper()
	prevRead, prevWindow := deliveryBuffered, deliveryStallWindow
	t.Cleanup(func() { deliveryBuffered, deliveryStallWindow = prevRead, prevWindow })
	deliveryBuffered = f.read
	if window > 0 {
		deliveryStallWindow = window
	}
}

// sendOneAndReachDeliveryWait sends one small file to a scripted receiver that
// acks the metadata, reads the bytes and the end marker, optionally answers
// "received", and keeps its channel open like a browser receiver. It returns
// the sender's result channel.
func sendOneAndReachDeliveryWait(t *testing.T, sendReceived bool) <-chan error {
	t.Helper()
	sender, recvCh, msgs, _, closeFn := newPumpedPair(t)
	t.Cleanup(closeFn)

	src := filepath.Join(t.TempDir(), "tail.bin")
	if err := os.WriteFile(src, make([]byte, 64*1024), 0o600); err != nil {
		t.Fatalf("write source: %v", err)
	}

	var rdc *webrtc.DataChannel
	select {
	case rdc = <-recvCh:
	case <-time.After(20 * time.Second):
		t.Fatal("receiver data channel never opened")
	}

	sendErr := make(chan error, 1)
	go func() { sendErr <- SendFiles(sender, []string{src}, "") }()

	var meta struct {
		ID string `json:"id"`
	}
	select {
	case m := <-msgs:
		if err := json.Unmarshal(m.Data, &meta); err != nil || meta.ID == "" {
			t.Fatalf("first message is not the metadata: %q", m.Data)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("metadata never arrived")
	}
	if err := rdc.Send([]byte(`{"type":"ack","id":"` + meta.ID + `","offset":0,"pv":1,"pvMin":1}`)); err != nil {
		t.Fatalf("ack: %v", err)
	}
	for ended := false; !ended; {
		select {
		case m := <-msgs:
			if msgType, ok := classifyControl(m.Data); ok && msgType == "end" {
				ended = true
			}
		case <-time.After(20 * time.Second):
			t.Fatal("the end marker never arrived")
		}
	}
	if sendReceived {
		// Binary, as the Go receiver sends it.
		if err := rdc.Send([]byte(`{"type":"received"}`)); err != nil {
			t.Fatalf("received: %v", err)
		}
	}
	return sendErr
}

func TestDeliveryWaitSurvivesSlowDrain(t *testing.T) {
	window := 200 * time.Millisecond
	f := &fakeDrain{left: 6 << 20, step: 64 << 10}
	useDelivery(t, f, window)

	sendErr := sendOneAndReachDeliveryWait(t, false)
	select {
	case err := <-sendErr:
		if err != nil {
			t.Fatalf("a slow but steady drain must finish, got: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the delivery wait never finished")
	}
	if waited := time.Since(f.firstRead()); waited < 2*window {
		t.Fatalf("the drain should span several windows, but the wait took only %v", waited)
	}
}

func TestDeliveryWaitAbortsOnRealStall(t *testing.T) {
	window := 200 * time.Millisecond
	f := &fakeDrain{left: 5 << 20, step: 0}
	useDelivery(t, f, window)

	sendErr := sendOneAndReachDeliveryWait(t, false)
	select {
	case err := <-sendErr:
		if err == nil || !strings.Contains(err.Error(), "timed out waiting for delivery confirmation from peer") {
			t.Fatalf("a buffer that never shrinks must abort with the delivery timeout, got: %v", err)
		}
		if waited := time.Since(f.firstRead()); waited > 5*time.Second {
			t.Fatalf("the stall should end the wait after one window, but it took %v", waited)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("a frozen buffer never ended the delivery wait")
	}
}

// Progress resets the window, and a stall after progress still aborts: this is
// the case that fails if the stall arm stops updating its last sample (the wait
// would never end) or uses one fixed window (it would end after the first).
func TestDeliveryWaitAbortsAfterProgressStops(t *testing.T) {
	window := 300 * time.Millisecond
	// The initial sample is read 1 and the first stall reads 2 or later, which
	// still shrink, so the first stall always sees progress.
	f := &fakeDrain{left: 6 << 20, step: 64 << 10, freezeAfterReads: 3}
	useDelivery(t, f, window)

	sendErr := sendOneAndReachDeliveryWait(t, false)
	select {
	case err := <-sendErr:
		if err == nil || !strings.Contains(err.Error(), "timed out waiting for delivery confirmation from peer") {
			t.Fatalf("a drain that stops must abort with the delivery timeout, got: %v", err)
		}
		if waited := time.Since(f.firstRead()); waited < 2*window {
			t.Fatalf("progress in the first window must reset the wait, but it aborted after %v", waited)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("a drain that stopped never ended the delivery wait")
	}
}

// The receiver's "received" wins even though the buffer never reports empty (the
// SACK race). The window keeps its 60 s default, so no timer can win a race on a
// loaded runner; the assertion is only that the wait ends promptly.
func TestDeliveryWaitReceivedStillWins(t *testing.T) {
	f := &fakeDrain{left: 5 << 20, step: 0}
	useDelivery(t, f, 0)

	sendErr := sendOneAndReachDeliveryWait(t, true)
	select {
	case err := <-sendErr:
		if err != nil {
			t.Fatalf("a received frame must end the wait with success, got: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the received frame did not end the delivery wait")
	}
}
