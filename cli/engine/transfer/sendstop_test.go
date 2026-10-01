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
// not mean to cause (holdReads makes it on purpose), and it keeps their order.
type frameLog struct {
	mu      sync.Mutex
	f       frames
	changed chan struct{}
	gate    chan struct{} // while set, the reader waits for it to close
}

// holdReads stops the reading end until the returned release, so the send's
// buffer fills and the send parks in its backpressure wait.
func (l *frameLog) holdReads() (release func()) {
	g := make(chan struct{})
	l.mu.Lock()
	l.gate = g
	l.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			l.mu.Lock()
			l.gate = nil
			l.mu.Unlock()
			close(g)
		})
	}
}

func (l *frameLog) gateNow() chan struct{} {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.gate
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
			if g := l.gateNow(); g != nil {
				select {
				case <-g:
				case <-quit:
					return
				}
			}
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

// waitParked returns once the send has queued nothing for 300 ms: it is
// parked at its backpressure wait.
func waitParked(t *testing.T, queued *atomic.Int64) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	last, since := queued.Load(), time.Now()
	for time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
		if cur := queued.Load(); cur != last {
			last, since = cur, time.Now()
		} else if time.Since(since) >= 300*time.Millisecond {
			return
		}
	}
	t.Fatal("the send never parked at its backpressure wait")
}

// startStoppable runs the send on its own goroutine, pumped as
// peer.Connection pumps a channel.
func startStoppable(sender *webrtc.DataChannel, paths []string, opts SendOptions) <-chan error {
	opts.Messages, opts.Closed = pumpChannel(sender, nil)
	errc := make(chan error, 1)
	go func() { errc <- SendFilesWithOptions(sender, paths, "test", opts) }()
	return errc
}

// stopFile is size bytes of zeros, made by Truncate so a large one costs no
// memory.
func stopFile(t *testing.T, name string, size int) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(int64(size)); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
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

// TestSendStopQueuesNothingMore: the send returns at once having queued at
// most what was already inside dc.Send, sends no end marker, and the abort
// the caller sends next is the last frame the receiver reads. Two moments,
// each caught by one look alone: as its file starts, with the buffer empty
// (the stop closes in OnAck, on the send's own goroutine, before the first
// chunk), where only the look before each write can catch it; and held at the
// backpressure wait with the buffer full and not draining, where only that
// wait's own stop arm can.
func TestSendStopQueuesNothingMore(t *testing.T) {
	for _, c := range []struct {
		name string
		held bool
		size int
	}{
		{"as the file starts", false, 64 << 20},
		// Past what a paused reader absorbs before the send has to wait: the
		// test pump's 256 frames (64 MiB at the 256 KiB chunk), the SCTP
		// window, and the 8 MB high-water mark.
		{"held at the backpressure wait", true, 160 << 20},
	} {
		t.Run(c.name, func(t *testing.T) {
			sender, rdc, l := stopPair(t)
			src := stopFile(t, "big.bin", c.size)
			stop := make(chan struct{})
			var queued atomic.Int64
			opts := SendOptions{
				Stop:       stop,
				OnProgress: func(p Progress) { queued.Store(p.FileBytes) },
			}
			if !c.held {
				opts.OnAck = func(int) { close(stop) }
			}
			errc := startStoppable(sender, []string{src}, opts)
			l.await(t, "metadata", 20*time.Second, func(f frames) bool { return len(f.ids) == 1 })
			ackFile(t, rdc, l.snapshot().ids[0])
			release := func() {}
			if c.held {
				l.await(t, "4 MiB of file bytes", 20*time.Second, func(f frames) bool { return f.bytes >= 4<<20 })
				release = l.holdReads()
				waitParked(t, &queued)
				close(stop)
			}
			atStop := queued.Load()
			awaitStopped(t, errc, 2*time.Second)
			// OnProgress reports after each dc.Send, so two chunks at most: the
			// one reported just after the load above, and the one already past
			// the last look when stop closed.
			if more := queued.Load() - atStop; more > 2*maxChunkSize {
				t.Fatalf("the send queued %d bytes after the stop, want at most two chunks (%d)", more, 2*maxChunkSize)
			}

			release()
			AbortSend(sender, "test", VisitorCancelReason)
			l.await(t, "the abort frame", 5*time.Second, func(f frames) bool { return f.abort != "" })
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
			if got.bytes >= int64(c.size) {
				t.Fatalf("the whole file went out (%d bytes) although the send stopped", got.bytes)
			}
		})
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

// TestSendStopWhileTheNextFileOpensSendsNoMetadata: a stop that lands while
// the send opens its next file (a slow open: an on-open scan, a cloud
// placeholder, a network share) sends no metadata for that file, so a
// receiver that ignores the abort never reads the name and size of a file
// the person stopped before it was announced (review lens B re-check N2).
// The open is held through the openForSend seam until the stop has closed.
func TestSendStopWhileTheNextFileOpensSendsNoMetadata(t *testing.T) {
	sender, rdc, l := stopPair(t)
	a, b := stopFile(t, "a.bin", 1024), stopFile(t, "b.bin", 1024)
	stop := make(chan struct{})
	opening := make(chan struct{})
	prev := openForSend
	t.Cleanup(func() { openForSend = prev })
	openForSend = func(name string) (*os.File, error) {
		if filepath.Base(name) == "b.bin" {
			close(opening)
			<-stop
		}
		return prev(name)
	}
	errc := startStoppable(sender, []string{a, b}, SendOptions{Stop: stop, OnProgress: func(Progress) {}})
	l.await(t, "the first metadata", 20*time.Second, func(f frames) bool { return len(f.ids) == 1 })
	ackFile(t, rdc, l.snapshot().ids[0])
	select {
	case <-opening:
	case <-time.After(20 * time.Second):
		t.Fatal("the send never opened the second file")
	}
	close(stop)
	awaitStopped(t, errc, 2*time.Second)
	time.Sleep(300 * time.Millisecond)
	if got := l.snapshot(); len(got.ids) != 1 || got.ends != 1 {
		t.Fatalf("after a stop during the next file's open the receiver got %d metadata frames and %d end markers, want 1 and 1", len(got.ids), got.ends)
	}
}

// TestReceivedAtStopKeepsAQueuedReceived: the delivery wait's stop arm
// (receivedAtStop) keeps a success when the receiver's received is already
// queued, because the files arrived, and stops on anything else: a queued
// refusal or nothing at all (review re-check LA2-2, whose mutation of the arm
// survived every test before this one). A Ctrl+C that lands as the host's
// received arrives must not print "You stopped this drop." for a drop the
// host saved in full.
func TestReceivedAtStopKeepsAQueuedReceived(t *testing.T) {
	const received = `{"type":"received","verified":2}`
	const refusal = `{"type":"incompatible","reason":"x","pv":1,"pvMin":1,"code":"disk-full","saved":1}`
	for _, c := range []struct {
		name     string
		queued   []string
		success  bool
		verified int
	}{
		{"a queued received", []string{received}, true, 2},
		{"a stray frame, then a received", []string{`{"type":"ack","id":"x"}`, received}, true, 2},
		{"a queued refusal", []string{refusal}, false, 0},
		{"a refusal ahead of a received", []string{refusal, received}, false, 0},
		{"an empty queue", nil, false, 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			ackCh := make(chan []byte, 4)
			for _, f := range c.queued {
				ackCh <- []byte(f)
			}
			v, has, err := receivedAtStop(ackCh, "test", "", 2)
			if !c.success {
				if !errors.Is(err, ErrSendStopped) {
					t.Fatalf("receivedAtStop returned %v, want ErrSendStopped", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("a queued received lost to the stop: %v", err)
			}
			if !has || v != c.verified {
				t.Fatalf("verified %d (has %v), want %d from the received frame", v, has, c.verified)
			}
		})
	}
}
