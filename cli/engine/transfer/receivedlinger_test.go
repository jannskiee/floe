package transfer

// After its "received" the receive keeps the connection open for the sender
// (review A1 F3). A Go sender whose ack promised its word (confirms) waits for
// exactly that frame, so a receive that closed while a lost copy of it still
// waited for its retransmission reported a saved transfer to that sender as
// unconfirmed. The rule under test: the sender's close ends the wait at once;
// otherwise it ends at receivedGrace, as it always did, once this side's send
// buffer is empty (the sender's SCTP acknowledged the frame), and while the
// buffer still holds it the wait goes on, up to receivedLinger from the send.
// The buffer read is the receivedBuffered seam, because a real SACK cannot be
// held back on demand; the hand sender never closes here.

import (
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// lingerTimes shrinks the grace and the ceiling for one test.
func lingerTimes(t *testing.T, grace, linger time.Duration) {
	t.Helper()
	prevGrace, prevLinger := receivedGrace, receivedLinger
	t.Cleanup(func() { receivedGrace, receivedLinger = prevGrace, prevLinger })
	receivedGrace, receivedLinger = grace, linger
}

// holdBuffer stands in a send buffer that reads 64 bytes while held is true
// and empty after, for one test.
func holdBuffer(t *testing.T, held *atomic.Bool) {
	t.Helper()
	prev := receivedBuffered
	t.Cleanup(func() { receivedBuffered = prev })
	receivedBuffered = func(*webrtc.DataChannel) uint64 {
		if held.Load() {
			return 64
		}
		return 0
	}
}

// receiveToReceived runs one small file through the real receive loop from a
// hand sender that never closes, and returns once the receive has sent its
// "received". The caller watches h.recvErr.
func receiveToReceived(t *testing.T) (h *handSender, receivedAt time.Time) {
	t.Helper()
	h = newHandSender(t)
	data := []byte("one small file")
	h.meta("a.txt", len(data), 1, 1, len(data))
	h.bytes(data)
	h.text(`{"type":"end","sha256":"` + hexSHA256(data) + `"}`)
	for deadline := time.After(20 * time.Second); ; {
		select {
		case m := <-h.back:
			if ok, _, _ := parseReceived(m.Data, 1); ok {
				return h, time.Now()
			}
		case err := <-h.recvErr:
			t.Fatalf("the receive returned %v before its received", err)
		case <-deadline:
			t.Fatal("no received from the receive")
		}
	}
}

// TestReceiveHoldsReceivedUntilAcknowledged: with the frame still in the send
// buffer the receive stays well past its grace, and returns, with nil, once
// the buffer empties. Before, it returned at the grace whatever the buffer
// held, and the caller's close tore the retransmission down.
func TestReceiveHoldsReceivedUntilAcknowledged(t *testing.T) {
	lingerTimes(t, 200*time.Millisecond, 20*time.Second)
	var held atomic.Bool
	held.Store(true)
	holdBuffer(t, &held)
	h, at := receiveToReceived(t)
	defer h.restore()
	select {
	case err := <-h.recvErr:
		t.Fatalf("the receive returned %v %v after its received, past a 200ms grace, with the frame still unacknowledged", err, time.Since(at).Round(time.Millisecond))
	case <-time.After(1500 * time.Millisecond):
	}
	held.Store(false) // the sender's SCTP acknowledged the frame
	select {
	case err := <-h.recvErr:
		if err != nil {
			t.Fatalf("the receive returned %v once received was acknowledged; want nil", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the receive did not return within 3s of received being acknowledged")
	}
}

// TestReceiveGivesUpAtTheLingerCeiling: a frame that is never acknowledged (a
// sender that vanished after the last byte) holds the receive no longer than
// receivedLinger from the send, and the receive still returns nil: the files
// are saved, only the word could not be delivered.
func TestReceiveGivesUpAtTheLingerCeiling(t *testing.T) {
	lingerTimes(t, 100*time.Millisecond, 1500*time.Millisecond)
	var held atomic.Bool
	held.Store(true)
	holdBuffer(t, &held)
	h, at := receiveToReceived(t)
	defer h.restore()
	select {
	case err := <-h.recvErr:
		took := time.Since(at)
		if err != nil {
			t.Fatalf("the receive returned %v at its ceiling; want nil", err)
		}
		if took < time.Second {
			t.Fatalf("the receive returned %v after its received, before its 1.5s ceiling, with the frame unacknowledged", took.Round(time.Millisecond))
		}
		t.Logf("the receive gave up %v after its received (ceiling 1.5s)", took.Round(time.Millisecond))
	case <-time.After(6 * time.Second):
		t.Fatal("the receive was still waiting 6s after its received, past its 1.5s ceiling")
	}
}

// TestReceiveReturnsAtGraceOnceAcknowledged is the normal case of a sender that
// never closes after the drain (the browser's plain send lingers with the
// channel open): the real buffer is empty once the sender's SCTP acknowledged
// the frame, so the receive returns at its grace, as it always did, and never
// waits out the ceiling. A wait for the close alone would hold floe receive
// for the whole ceiling behind every browser sender.
func TestReceiveReturnsAtGraceOnceAcknowledged(t *testing.T) {
	lingerTimes(t, 300*time.Millisecond, 20*time.Second)
	h, at := receiveToReceived(t)
	defer h.restore()
	select {
	case err := <-h.recvErr:
		took := time.Since(at)
		if err != nil {
			t.Fatalf("the receive returned %v; want nil", err)
		}
		// Not sooner either: the grace is the timing every browser sender
		// gets today, and this change keeps it.
		if took < 250*time.Millisecond {
			t.Fatalf("the receive returned %v after its received, before its 300ms grace", took.Round(time.Millisecond))
		}
		t.Logf("the receive returned %v after its received (grace 300ms)", took.Round(time.Millisecond))
	case <-time.After(5 * time.Second):
		t.Fatal("the receive was still waiting 5s after an acknowledged received, far past its 300ms grace")
	}
}
