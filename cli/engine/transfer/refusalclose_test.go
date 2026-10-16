package transfer

// A receiver that refuses sends its incompatible frame, flushes it, and then
// closes. On the sender both can be ready at once, and a refusal that arrived
// must be reported as the refusal, every time, never as a lost connection
// (WP-W1 review 2, the Go sender's twin of the browser's F1). The three places
// that judged a close without looking at a queued refusal: the pump forwarder
// (it could return on Closed with the frame still in Messages), the ack wait
// (a random pick between the frame and the close) and the backpressure wait
// (it never read the frames at all).
//
// The receiver side of each test is a real pion channel whose handler takes
// the first message and then blocks, so nothing drains the sender's buffer;
// the frames the sender reads come from test-owned Messages and Closed
// channels, so the refusal and the close are made ready exactly together.
// Two more pin the backpressure wait with no close at all (TL-16): a refusal
// alone must end it, and other frames must not restart its stall window.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// diskFullRefusal is a Go receiver's disk-full refusal, as AbortWithCode sends it.
const diskFullRefusal = `{"type":"incompatible","reason":"the receiver's drive is full","pv":1,"pvMin":1,"ver":"test","code":"disk-full","saved":0}`

// newBlockingPair opens a loopback pair. The receiver hands its first message
// (the metadata) to first and then blocks every later message until the test
// ends, so the sender's buffered amount can only grow.
func newBlockingPair(t *testing.T) (sender *webrtc.DataChannel, first <-chan []byte) {
	t.Helper()
	se := webrtc.SettingEngine{}
	se.SetIncludeLoopbackCandidate(true)
	api := webrtc.NewAPI(webrtc.WithSettingEngine(se))
	pcSender, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("create sender PC: %v", err)
	}
	pcReceiver, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("create receiver PC: %v", err)
	}
	release := make(chan struct{})
	var releaseOnce sync.Once
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(release) })
		pcSender.Close()
		pcReceiver.Close()
	})

	got := make(chan []byte, 1)
	pcReceiver.OnDataChannel(func(dc *webrtc.DataChannel) {
		var n int
		dc.OnMessage(func(m webrtc.DataChannelMessage) {
			n++
			if n == 1 {
				got <- append([]byte(nil), m.Data...)
				return
			}
			<-release
		})
	})

	dc, err := pcSender.CreateDataChannel("floe", nil)
	if err != nil {
		t.Fatalf("create data channel: %v", err)
	}
	open := make(chan struct{})
	dc.OnOpen(func() { close(open) })
	offer, err := pcSender.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create offer: %v", err)
	}
	gs := webrtc.GatheringCompletePromise(pcSender)
	if err := pcSender.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gs
	if err := pcReceiver.SetRemoteDescription(*pcSender.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	answer, err := pcReceiver.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gr := webrtc.GatheringCompletePromise(pcReceiver)
	if err := pcReceiver.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	<-gr
	if err := pcSender.SetRemoteDescription(*pcReceiver.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-open:
	case <-time.After(20 * time.Second):
		t.Fatal("sender data channel never opened")
	}
	return dc, got
}

// sizedFile writes a file of n bytes (content irrelevant) and returns its path.
func sizedFile(t *testing.T, n int) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "payload.bin")
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(int64(n)); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	return p
}

// wantDiskFull fails unless err is the receiver's disk-full refusal, reported
// with its fixed sentence and never as a closed connection.
func wantDiskFull(t *testing.T, err error) {
	t.Helper()
	var stopped *PeerStoppedError
	if !errors.As(err, &stopped) || stopped.Code != CodeDiskFull {
		t.Fatalf("send returned %v, want the receiver's disk-full refusal", err)
	}
	if err.Error() != (&PeerStoppedError{Code: CodeDiskFull}).Error() {
		t.Fatalf("send returned %q, want the fixed disk-full sentence", err.Error())
	}
}

// The ack wait with the refusal and the close ready at once: both are in
// place before the send starts, so the forwarder sees Messages and Closed
// ready together and the ack wait sees its frame and done ready together.
// Before the fix each was a coin flip (about 1 in 4 runs reported the
// refusal); run with -count=20.
//
// The race is a Go select between two ready cases, so one pass catches a
// regression only some of the time: the scenario runs 10 times per test run,
// each on a fresh pair (review F3).
func TestSenderReportsARefusalThatArrivesWithTheCloseAtTheAckWait(t *testing.T) {
	for i := 0; i < 10; i++ {
		dc, _ := newBlockingPair(t)
		msgs := make(chan webrtc.DataChannelMessage, 4)
		closed := make(chan struct{})
		msgs <- webrtc.DataChannelMessage{IsString: true, Data: []byte(diskFullRefusal)}
		close(closed)

		err := SendFilesWithOptions(dc, []string{sizedFile(t, 1024)}, "test", SendOptions{
			OnProgress: func(Progress) {},
			Messages:   msgs,
			Closed:     closed,
		})
		wantDiskFull(t, err)
	}
}

// A send that fails because the channel just closed: pion marks the channel
// Closed before it runs onClose, so dc.Send returns io.ErrClosedPipe while the
// refusal already sits in ackCh and done has not fired yet (review F1). Here
// the sender's own channel is closed after the metadata, the ack and the
// refusal are queued in that order, and Closed fires 100 ms later: the ack
// wait takes the ack, the first chunk's Send fails, and the refusal must
// still be reported. Deterministic both ways.
func TestSenderReportsARefusalThatArrivesWithTheCloseAtASend(t *testing.T) {
	dc, first := newBlockingPair(t)
	path := sizedFile(t, 256*1024)
	msgs := make(chan webrtc.DataChannelMessage, 4)
	closed := make(chan struct{})
	errc := make(chan error, 1)
	go func() {
		errc <- SendFilesWithOptions(dc, []string{path}, "test", SendOptions{
			OnProgress: func(Progress) {},
			Messages:   msgs,
			Closed:     closed,
		})
	}()
	var meta struct {
		ID string `json:"id"`
	}
	select {
	case raw := <-first:
		if err := json.Unmarshal(raw, &meta); err != nil || meta.ID == "" {
			t.Fatalf("first frame is not the metadata: %v", err)
		}
	case err := <-errc:
		t.Fatalf("send ended before the metadata: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("no metadata within 10s")
	}
	if err := dc.Close(); err != nil {
		t.Fatalf("close the sender's channel: %v", err)
	}
	ack, _ := json.Marshal(map[string]interface{}{"type": "ack", "id": meta.ID, "offset": 0, "pv": 1, "pvMin": 1})
	msgs <- webrtc.DataChannelMessage{IsString: true, Data: ack}
	msgs <- webrtc.DataChannelMessage{IsString: true, Data: []byte(diskFullRefusal)}
	time.AfterFunc(100*time.Millisecond, func() { close(closed) })
	select {
	case err := <-errc:
		wantDiskFull(t, err)
	case <-time.After(10 * time.Second):
		t.Fatal("the send did not end within 10s")
	}
}

// The metadata Send: the sender's channel is already closed when the send
// starts, the refusal is queued, and Closed fires 100 ms later. This is the
// second or later file of a batch whose receiver refused the one before at
// finalize and closed (FT-GO-REFUSAL review 2, R2-1).
func TestSenderReportsARefusalThatArrivesWithTheCloseAtTheMetadataSend(t *testing.T) {
	dc, _ := newBlockingPair(t)
	if err := dc.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	path := sizedFile(t, 1024)
	msgs := make(chan webrtc.DataChannelMessage, 4)
	closed := make(chan struct{})
	msgs <- webrtc.DataChannelMessage{IsString: true, Data: []byte(diskFullRefusal)}
	time.AfterFunc(100*time.Millisecond, func() { close(closed) })
	err := SendFilesWithOptions(dc, []string{path}, "test", SendOptions{
		OnProgress: func(Progress) {}, Messages: msgs, Closed: closed,
	})
	wantDiskFull(t, err)
}

// The end-marker Send: a 0-byte file sends no chunk, so after the ack the
// first Send is the end marker, on a channel closed after the metadata. This
// is a mid-file refusal whose last chunk's Send still succeeded (R2-1).
func TestSenderReportsARefusalThatArrivesWithTheCloseAtTheEndMarkerSend(t *testing.T) {
	dc, first := newBlockingPair(t)
	path := sizedFile(t, 0)
	msgs := make(chan webrtc.DataChannelMessage, 4)
	closed := make(chan struct{})
	errc := make(chan error, 1)
	go func() {
		errc <- SendFilesWithOptions(dc, []string{path}, "test", SendOptions{
			OnProgress: func(Progress) {}, Messages: msgs, Closed: closed,
		})
	}()
	var meta struct {
		ID string `json:"id"`
	}
	select {
	case raw := <-first:
		if err := json.Unmarshal(raw, &meta); err != nil || meta.ID == "" {
			t.Fatalf("first frame is not the metadata: %v", err)
		}
	case err := <-errc:
		t.Fatalf("send ended before the metadata: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("no metadata within 10s")
	}
	if err := dc.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	ack, _ := json.Marshal(map[string]interface{}{"type": "ack", "id": meta.ID, "offset": 0, "pv": 1, "pvMin": 1})
	msgs <- webrtc.DataChannelMessage{IsString: true, Data: ack}
	msgs <- webrtc.DataChannelMessage{IsString: true, Data: []byte(diskFullRefusal)}
	time.AfterFunc(100*time.Millisecond, func() { close(closed) })
	select {
	case err := <-errc:
		wantDiskFull(t, err)
	case <-time.After(10 * time.Second):
		t.Fatal("the send did not end within 10s")
	}
}

// blockedSend is a send of a 24 MiB file to newBlockingPair's receiver with
// its metadata acked, so the sender fills the buffer and parks in the
// backpressure wait. The test owns the sender's Messages (msgs) and its
// Closed (closeChannel). A cleanup closes Closed if the test did not and waits
// for the send to return, so no send outlives its test or races the restore
// of a package variable the test swapped before starting it.
type blockedSend struct {
	msgs      chan webrtc.DataChannelMessage
	errc      chan error
	sent      atomic.Int64
	closed    chan struct{}
	closeOnce sync.Once
}

func (b *blockedSend) closeChannel() { b.closeOnce.Do(func() { close(b.closed) }) }

func startBlockedSend(t *testing.T) *blockedSend {
	t.Helper()
	dc, first := newBlockingPair(t)
	path := sizedFile(t, 24<<20)
	b := &blockedSend{
		msgs:   make(chan webrtc.DataChannelMessage, 4),
		errc:   make(chan error, 1),
		closed: make(chan struct{}),
	}
	returned := make(chan struct{})
	go func() {
		defer close(returned)
		b.errc <- SendFilesWithOptions(dc, []string{path}, "test", SendOptions{
			OnProgress: func(p Progress) { b.sent.Store(p.FileBytes) },
			Messages:   b.msgs,
			Closed:     b.closed,
		})
	}()
	t.Cleanup(func() {
		b.closeChannel()
		select {
		case <-returned:
		case <-time.After(10 * time.Second):
			t.Error("the send was still running 10s after its channel closed")
		}
	})

	var meta struct {
		ID string `json:"id"`
	}
	select {
	case raw := <-first:
		if err := json.Unmarshal(raw, &meta); err != nil || meta.ID == "" {
			t.Fatalf("first frame is not the metadata: %v", err)
		}
	case err := <-b.errc:
		t.Fatalf("send ended before the metadata: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("no metadata within 10s")
	}
	ack, _ := json.Marshal(map[string]interface{}{"type": "ack", "id": meta.ID, "offset": 0, "pv": 1, "pvMin": 1})
	b.msgs <- webrtc.DataChannelMessage{IsString: true, Data: ack}
	return b
}

// waitParked returns once the sender is parked: more than the high-water mark
// handed to the channel and no progress for 300 ms. dc.Send never blocks, so
// the backpressure wait is the only place the chunk loop can stop. The
// buffered amount itself is no signal: SACKs for what the receiver's own
// buffer took pull it back under the mark after the sender has parked.
func (b *blockedSend) waitParked(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	last, stableSince := int64(-1), time.Now()
	for {
		select {
		case err := <-b.errc:
			t.Fatalf("send ended before it parked: %v", err)
		default:
		}
		if cur := b.sent.Load(); cur != last {
			last, stableSince = cur, time.Now()
		}
		if last >= bufferedAmountHighWater && time.Since(stableSince) >= 300*time.Millisecond {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the sender never parked on a full buffer (%d bytes handed over)", last)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// The backpressure wait: the receiver has accepted and then stopped reading,
// so the sender is parked on a full buffer when the refusal and the close
// arrive together. Before the fix that wait never read the receiver's frames,
// so every run reported "connection closed mid-transfer".
func TestSenderReportsARefusalThatArrivesWithTheCloseDuringBackpressure(t *testing.T) {
	b := startBlockedSend(t)
	b.waitParked(t)
	b.msgs <- webrtc.DataChannelMessage{IsString: true, Data: []byte(diskFullRefusal)}
	b.closeChannel()
	select {
	case err := <-b.errc:
		wantDiskFull(t, err)
	case <-time.After(10 * time.Second):
		t.Fatal("the send did not end within 10s of the refusal and the close")
	}
}

// The same wait with a refusal and no close (TL-16). A browser receiver sends
// its refusal and keeps the channel open, and a receiver that has stopped
// reading leaves the buffer full, so nothing else ends the wait. Before the
// fix the refusal sat unread for the whole 60 s stall window and the send
// then ended with "backpressure stall", its cause lost.
func TestSenderReportsARefusalWithoutACloseDuringBackpressure(t *testing.T) {
	b := startBlockedSend(t)
	b.waitParked(t)
	b.msgs <- webrtc.DataChannelMessage{IsString: true, Data: []byte(diskFullRefusal)}
	select {
	case err := <-b.errc:
		wantDiskFull(t, err)
	case <-time.After(10 * time.Second):
		t.Fatal("the send did not end within 10s of a refusal that came without a close")
	}
}

// Reading a frame that is not a refusal must not restart the backpressure
// wait's stall window. A peer that sends anything at all more often than
// once a window would otherwise park the sender for good on a buffer that
// never moves. The window is shrunk to 1 s and a frame arrives every 100 ms,
// so a wait that re-armed its timer on every pass would never fire.
func TestSenderBackpressureStallIsNotExtendedByOtherFrames(t *testing.T) {
	prev := deliveryStallWindow
	t.Cleanup(func() { deliveryStallWindow = prev })
	deliveryStallWindow = time.Second

	b := startBlockedSend(t)
	// None of these is a refusal: an ack for another file, a received, a
	// frame that is not JSON, a type under the wrong key, and a refusal past
	// the control cap, which a sender never parses.
	junk := [][]byte{
		[]byte(`{"type":"ack","id":"another-file","offset":0,"pv":1,"pvMin":1}`),
		[]byte(`{"type":"received","verified":0}`),
		[]byte("not json"),
		[]byte(`{"TYPE":"incompatible","code":"disk-full","pv":1,"pvMin":1}`),
		[]byte(`{"type":"incompatible","code":"disk-full","pv":1,"pvMin":1,"reason":"` + strings.Repeat("x", controlMsgMax) + `"}`),
	}
	stopJunk := make(chan struct{})
	defer close(stopJunk)
	go func() {
		tick := time.NewTicker(100 * time.Millisecond)
		defer tick.Stop()
		for i := 0; ; i++ {
			select {
			case <-stopJunk:
				return
			case <-tick.C:
				select {
				case b.msgs <- webrtc.DataChannelMessage{Data: junk[i%len(junk)]}:
				default:
				}
			}
		}
	}()

	select {
	case err := <-b.errc:
		if err == nil || !strings.Contains(err.Error(), "backpressure stall") {
			t.Fatalf("send returned %v, want the backpressure stall", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("the send was still parked 15s into a 1s stall window: the other frames kept restarting it")
	}
}
