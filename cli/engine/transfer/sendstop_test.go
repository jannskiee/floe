package transfer

// SendOptions.Stop (FU-20 round 3; review lens A finding 1, lens B M3): once a
// caller stops a send it queues nothing more and returns at once from every
// wait, so the caller's abort, sent after the send has returned, is the last
// frame the receiver reads. Before this the request-link send's Ctrl+C wrote
// its abort while the chunk loop kept writing, and a receiver that read on got
// most of a 128 MiB file after it.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// frameLog is the receiving end of a stop test. It reads every frame the
// moment it arrives, so the sender never waits on backpressure the test did
// not mean to cause, and it keeps their order.
type frameLog struct {
	mu      sync.Mutex
	f       frames
	changed chan struct{}
}

// frames is what a frameLog has seen so far.
type frames struct {
	ids        []string // metadata ids, in order
	bytes      int64    // file bytes before the abort frame
	ends       int
	abort      string // the abort frame's reason once it came
	afterAbort int    // frames of any kind after the abort frame
}

func (l *frameLog) note(m webrtc.DataChannelMessage) {
	l.mu.Lock()
	defer l.mu.Unlock()
	defer func() {
		select {
		case l.changed <- struct{}{}:
		default:
		}
	}()
	if l.f.abort != "" {
		l.f.afterAbort++
		return
	}
	if !m.IsString {
		l.f.bytes += int64(len(m.Data))
		return
	}
	var f struct {
		Type   string `json:"type"`
		ID     string `json:"id"`
		Reason string `json:"reason"`
	}
	_ = json.Unmarshal(m.Data, &f)
	switch f.Type {
	case "metadata":
		l.f.ids = append(l.f.ids, f.ID)
	case "end":
		l.f.ends++
	case "incompatible":
		l.f.abort = f.Reason
	}
}

// await polls cond under the lock until it holds or bound passes.
func (l *frameLog) await(t *testing.T, what string, bound time.Duration, cond func(frames) bool) {
	t.Helper()
	deadline := time.After(bound)
	for {
		ok := cond(l.snapshot())
		if ok {
			return
		}
		select {
		case <-l.changed:
		case <-time.After(20 * time.Millisecond):
		case <-deadline:
			t.Fatalf("%s: not within %v", what, bound)
		}
	}
}

func (l *frameLog) snapshot() frames {
	l.mu.Lock()
	defer l.mu.Unlock()
	f := l.f
	f.ids = append([]string(nil), l.f.ids...)
	return f
}

// stopPair is a pumped loopback pair whose receiving end is a frameLog. It
// returns the sender's channel, the receiver's (for acks) and the log.
func stopPair(t *testing.T) (*webrtc.DataChannel, *webrtc.DataChannel, *frameLog) {
	t.Helper()
	sender, recvCh, msgs, _, closeFn := newPumpedPair(t)
	t.Cleanup(closeFn)
	var rdc *webrtc.DataChannel
	select {
	case rdc = <-recvCh:
	case <-time.After(20 * time.Second):
		t.Fatal("receiver data channel never opened")
	}
	l := &frameLog{changed: make(chan struct{}, 1)}
	quit := make(chan struct{})
	t.Cleanup(func() { close(quit) })
	go func() {
		for {
			select {
			case m := <-msgs:
				l.note(m)
			case <-quit:
				return
			}
		}
	}()
	return sender, rdc, l
}

// startStoppable runs the send on its own goroutine, pumped as
// peer.Connection pumps a channel.
func startStoppable(sender *webrtc.DataChannel, paths []string, opts SendOptions) <-chan error {
	opts.Messages, opts.Closed = pumpChannel(sender, nil)
	errc := make(chan error, 1)
	go func() { errc <- SendFilesWithOptions(sender, paths, "test", opts) }()
	return errc
}

func stopFile(t *testing.T, name string, size int) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, make([]byte, size), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func ackFile(t *testing.T, rdc *webrtc.DataChannel, id string) {
	t.Helper()
	if err := rdc.Send([]byte(`{"type":"ack","id":"` + id + `","offset":0}`)); err != nil {
		t.Fatalf("ack: %v", err)
	}
}

func awaitStopped(t *testing.T, errc <-chan error, bound time.Duration) {
	t.Helper()
	select {
	case err := <-errc:
		if !errors.Is(err, ErrSendStopped) {
			t.Fatalf("the send returned %v, want ErrSendStopped", err)
		}
	case <-time.After(bound):
		t.Fatalf("the send ran on for %v after the stop", bound)
	}
}

// TestSendStopQueuesNothingMore: stopped mid-file, the send returns at once
// having queued at most what was already inside dc.Send, sends no end marker,
// and the abort the caller sends next is the last frame the receiver reads.
func TestSendStopQueuesNothingMore(t *testing.T) {
	sender, rdc, l := stopPair(t)
	src := stopFile(t, "big.bin", 64<<20)
	stop := make(chan struct{})
	var queued atomic.Int64
	errc := startStoppable(sender, []string{src}, SendOptions{
		Stop:       stop,
		OnProgress: func(p Progress) { queued.Store(p.FileBytes) },
	})
	l.await(t, "metadata", 20*time.Second, func(l frames) bool { return len(l.ids) == 1 })
	ackFile(t, rdc, l.snapshot().ids[0])
	l.await(t, "4 MiB of file bytes", 20*time.Second, func(l frames) bool { return l.bytes >= 4<<20 })

	close(stop)
	atStop := queued.Load()
	awaitStopped(t, errc, 2*time.Second)
	// OnProgress reports after each dc.Send, so two chunks at most: the one
	// reported just after the load above, and the one already past the last
	// look when stop closed.
	if more := queued.Load() - atStop; more > 2*maxChunkSize {
		t.Fatalf("the send queued %d bytes after the stop, want at most two chunks (%d)", more, 2*maxChunkSize)
	}

	AbortSend(sender, "test", VisitorCancelReason)
	l.await(t, "the abort frame", 5*time.Second, func(l frames) bool { return l.abort != "" })
	time.Sleep(300 * time.Millisecond)
	got := l.snapshot()
	if got.abort != VisitorCancelReason {
		t.Fatalf("the abort frame says %q", got.abort)
	}
	if got.afterAbort != 0 {
		t.Fatalf("%d frames followed the abort frame", got.afterAbort)
	}
	if got.ends != 0 {
		t.Fatal("an end marker went out for the file the stop cut")
	}
	if got.bytes >= 64<<20 {
		t.Fatalf("the whole file went out (%d bytes) although the send stopped", got.bytes)
	}
}

// TestSendStopEndsTheAckWait: stopped while the receiver decides, the send
// returns at once instead of at its ack timeout, and the next file's metadata
// never goes out.
func TestSendStopEndsTheAckWait(t *testing.T) {
	sender, _, l := stopPair(t)
	a, b := stopFile(t, "a.bin", 1024), stopFile(t, "b.bin", 1024)
	stop := make(chan struct{})
	errc := startStoppable(sender, []string{a, b}, SendOptions{
		Stop:       stop,
		AckTimeout: time.Minute,
		OnProgress: func(Progress) {},
	})
	l.await(t, "the first metadata", 20*time.Second, func(l frames) bool { return len(l.ids) == 1 })
	close(stop)
	awaitStopped(t, errc, 2*time.Second)
	time.Sleep(300 * time.Millisecond)
	if got := l.snapshot(); len(got.ids) != 1 || got.bytes != 0 {
		t.Fatalf("after the stop the receiver got %d metadata frames and %d bytes, want 1 and 0", len(got.ids), got.bytes)
	}
}

// TestSendStopEndsTheWaitForReceived: under RequireReceived the wait after
// the last file has no deadline of its own; a stop ends it at once.
func TestSendStopEndsTheWaitForReceived(t *testing.T) {
	sender, rdc, l := stopPair(t)
	src := stopFile(t, "a.bin", 64<<10)
	stop := make(chan struct{})
	errc := startStoppable(sender, []string{src}, SendOptions{
		Stop:            stop,
		RequireReceived: true,
		OnProgress:      func(Progress) {},
	})
	l.await(t, "metadata", 20*time.Second, func(l frames) bool { return len(l.ids) == 1 })
	ackFile(t, rdc, l.snapshot().ids[0])
	l.await(t, "the end marker", 20*time.Second, func(l frames) bool { return l.ends == 1 })
	select {
	case err := <-errc:
		t.Fatalf("the send returned %v with no received", err)
	case <-time.After(300 * time.Millisecond):
	}
	close(stop)
	awaitStopped(t, errc, 2*time.Second)
}

// TestSendStopBeforeTheFirstFileSendsNothing: a stop that came first sends
// nothing at all, not even the first metadata.
func TestSendStopBeforeTheFirstFileSendsNothing(t *testing.T) {
	sender, _, l := stopPair(t)
	src := stopFile(t, "a.bin", 1024)
	stop := make(chan struct{})
	close(stop)
	errc := startStoppable(sender, []string{src}, SendOptions{Stop: stop, OnProgress: func(Progress) {}})
	awaitStopped(t, errc, 2*time.Second)
	time.Sleep(300 * time.Millisecond)
	if got := l.snapshot(); len(got.ids) != 0 || got.bytes != 0 {
		t.Fatalf("a send stopped before it began sent %d metadata frames and %d bytes", len(got.ids), got.bytes)
	}
}
