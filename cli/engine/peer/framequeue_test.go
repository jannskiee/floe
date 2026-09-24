package peer

import (
	"testing"
	"time"
)

func frameLen(b []byte) int { return len(b) }

// sendAsync runs one Send on its own goroutine and reports its result.
func sendAsync(q *FrameQueue[[]byte], m []byte, stop <-chan struct{}) <-chan bool {
	done := make(chan bool, 1)
	go func() { done <- q.Send(m, stop) }()
	return done
}

func expectWaiting(t *testing.T, done <-chan bool, why string) {
	t.Helper()
	select {
	case ok := <-done:
		t.Fatalf("Send returned %v, want it waiting: %s", ok, why)
	case <-time.After(100 * time.Millisecond):
	}
}

func expectSent(t *testing.T, done <-chan bool, want bool) {
	t.Helper()
	select {
	case ok := <-done:
		if ok != want {
			t.Fatalf("Send returned %v, want %v", ok, want)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Send still waiting")
	}
}

// The budget is 256 of the largest chunk a Floe sender sends (256 KiB in
// transfer/sender.go and client/lib/transfer/protocol.ts), 64 MiB.
func TestEarlyBufferBytesIsTheCountTimesTheLargestChunk(t *testing.T) {
	budget, chunk, count := EarlyBufferBytes, maxChunk, earlyBuffer
	if chunk != 256<<10 || budget != count*chunk || budget != 64<<20 {
		t.Fatalf("maxChunk %d, earlyBuffer %d, EarlyBufferBytes %d", chunk, count, budget)
	}
}

// Floe-sized frames never meet the byte bound: the pump's 256 slots fill
// exactly as a plain channel's would, and the 257th waits for a slot.
func TestFrameQueueChunksMeetOnlyTheCount(t *testing.T) {
	q := NewFrameQueue(earlyBuffer, EarlyBufferBytes, frameLen)
	stop := make(chan struct{})
	chunk := make([]byte, maxChunk)
	for i := 0; i < earlyBuffer; i++ {
		expectSent(t, sendAsync(q, chunk, stop), true)
	}
	next := sendAsync(q, []byte("x"), stop)
	expectWaiting(t, next, "the queue is full by count")
	<-q.C()
	expectSent(t, next, true)
}

// A frame that would take the queue past its bytes waits for a reader, and
// goes in once one has taken enough; order is kept throughout.
func TestFrameQueueWaitsForBytes(t *testing.T) {
	q := NewFrameQueue(8, 10, frameLen)
	stop := make(chan struct{})
	expectSent(t, sendAsync(q, []byte("aaaa"), stop), true)
	expectSent(t, sendAsync(q, []byte("bbbb"), stop), true)
	third := sendAsync(q, []byte("cccc"), stop)
	expectWaiting(t, third, "12 bytes would pass the budget of 10")
	if got := string(<-q.C()); got != "aaaa" {
		t.Fatalf("first frame %q", got)
	}
	expectSent(t, third, true)
	for _, want := range []string{"bbbb", "cccc"} {
		if got := string(<-q.C()); got != want {
			t.Fatalf("frame %q, want %q", got, want)
		}
	}
}

// A frame larger than the whole budget still goes into an empty queue, so no
// frame size can wedge it, and holds everything behind it until it is read.
func TestFrameQueueLoneOversizeFrame(t *testing.T) {
	q := NewFrameQueue(8, 10, frameLen)
	stop := make(chan struct{})
	expectSent(t, sendAsync(q, make([]byte, 50), stop), true)
	next := sendAsync(q, []byte("a"), stop)
	expectWaiting(t, next, "the oversize frame is still queued")
	<-q.C()
	expectSent(t, next, true)
}

// stop ends a wait for bytes or for a slot, and reports that nothing was sent.
func TestFrameQueueStopEndsAWait(t *testing.T) {
	q := NewFrameQueue(1, 10, frameLen)
	stop := make(chan struct{})
	expectSent(t, sendAsync(q, make([]byte, 8), stop), true)
	byBytes := sendAsync(q, make([]byte, 8), stop)
	expectWaiting(t, byBytes, "the budget is full")
	close(stop)
	expectSent(t, byBytes, false)

	q = NewFrameQueue(1, 10, frameLen)
	stop = make(chan struct{})
	expectSent(t, sendAsync(q, []byte("a"), stop), true)
	bySlot := sendAsync(q, []byte("b"), stop)
	expectWaiting(t, bySlot, "the only slot is taken")
	close(stop)
	expectSent(t, bySlot, false)
}

// With room, a frame goes in even after stop has closed, so a local close
// never costs a frame the reader could still take.
func TestFrameQueueRoomWinsOverStop(t *testing.T) {
	stop := make(chan struct{})
	close(stop)
	q := NewFrameQueue(4, 10, frameLen)
	for i := 0; i < 50; i++ {
		if !q.Send([]byte("a"), stop) {
			t.Fatalf("send %d dropped with room in the queue", i)
		}
		<-q.C()
	}
}
