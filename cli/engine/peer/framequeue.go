package peer

import "time"

// maxChunk is the largest frame any Floe sender sends: the adaptive chunk's
// cap, maxChunkSize in transfer/sender.go and MAX_CHUNK in
// client/lib/transfer/protocol.ts. Control frames are under 1,000 bytes.
const maxChunk = 256 << 10

// EarlyBufferBytes is the most frame bytes the data channel's pump holds, 64
// MiB (F2-01, DV-AUDIT CP-SE). It is earlyBuffer frames of maxChunk, so the
// count binds first for every frame a Floe sender sends and no ordinary
// transfer ever meets it. It exists for a peer that sends larger frames: pion
// delivers them up to its SCTP receive window (4 MiB frames were measured in
// loopback), and while the receive loop reads nothing (Decide, for up to
// transfer.HostDecisionWindow, a commit retry, the terminal prompt) the count
// alone let 256 of them, 1 GiB, sit in the pump.
const EarlyBufferBytes = earlyBuffer * maxChunk

// frameQueuePoll is how often a Send held by the byte budget looks again.
const frameQueuePoll = 10 * time.Millisecond

// FrameQueue is a buffered channel that one goroutine fills, bounded twice: by
// count, as any buffered channel is, and by the bytes of the frames in it.
// Readers take from C like any channel, so a consumer written for a plain
// channel (transfer.ReceiveOptions.Messages) needs no change.
type FrameQueue[M any] struct {
	ch     chan M
	size   func(M) int
	budget int
	// ring holds the sizes of the frames sent that may still be in ch, oldest
	// at head; n of them, held bytes in all. One more slot than ch has, for
	// the frame just sent into a channel that was full a moment before.
	ring    []int
	head, n int
	held    int
}

// NewFrameQueue returns a queue of at most depth frames (depth at least 1)
// and at most budget bytes of them, as size measures a frame.
func NewFrameQueue[M any](depth, budget int, size func(M) int) *FrameQueue[M] {
	return &FrameQueue[M]{ch: make(chan M, depth), size: size, budget: budget, ring: make([]int, depth+1)}
}

// C is the queue's receiving side, for any number of readers.
func (q *FrameQueue[M]) C() <-chan M { return q.ch }

// Send queues m behind every frame sent before it and reports true, or gives
// up once stop closes and reports false. It waits while the queue is full by
// count, as a send on a buffered channel does, and while m would take the
// frames in it past the byte budget. A frame larger than the whole budget
// still goes into an empty queue, so no frame size can wedge it. With room,
// the frame goes in even if stop has closed. Only one goroutine may call Send.
func (q *FrameQueue[M]) Send(m M, stop <-chan struct{}) bool {
	size := q.size(m)
	q.forget()
	if q.n > 0 && q.held+size > q.budget {
		// A reader of a plain channel cannot be observed, so this looks again
		// every frameQueuePoll. No Floe sender's frame waits here (see
		// EarlyBufferBytes), and the frames already queued keep a reader busy
		// for far longer than one poll.
		tick := time.NewTicker(frameQueuePoll)
		defer tick.Stop()
		for q.n > 0 && q.held+size > q.budget {
			select {
			case <-stop:
				return false
			case <-tick.C:
			}
			q.forget()
		}
	}
	select {
	case q.ch <- m:
	default:
		select {
		case q.ch <- m:
		case <-stop:
			return false
		}
	}
	q.ring[(q.head+q.n)%len(q.ring)] = size
	q.n++
	q.held += size
	q.forget()
	return true
}

// forget drops the sizes of the frames that readers have taken. Only Send adds
// to ch and ch is first in, first out, so the frames still in it are the
// newest len(ch) sent. Readers only ever lower len(ch), so a value read while
// one takes a frame is high, never low, which errs toward holding less.
func (q *FrameQueue[M]) forget() {
	for q.n > len(q.ch) {
		q.held -= q.ring[q.head]
		q.head = (q.head + 1) % len(q.ring)
		q.n--
	}
}
