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
func TestSenderReportsARefusalThatArrivesWithTheCloseAtTheAckWait(t *testing.T) {
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

// The backpressure wait: the receiver has accepted and then stopped reading,
// so the sender is parked on a full buffer when the refusal and the close
// arrive together. Before the fix that wait never read the receiver's frames,
// so every run reported "connection closed mid-transfer".
func TestSenderReportsARefusalThatArrivesWithTheCloseDuringBackpressure(t *testing.T) {
	dc, first := newBlockingPair(t)
	msgs := make(chan webrtc.DataChannelMessage, 4)
	closed := make(chan struct{})
	errc := make(chan error, 1)
	var sent atomic.Int64
	go func() {
		errc <- SendFilesWithOptions(dc, []string{sizedFile(t, 24<<20)}, "test", SendOptions{
			OnProgress: func(p Progress) { sent.Store(p.FileBytes) },
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
	ack, _ := json.Marshal(map[string]interface{}{"type": "ack", "id": meta.ID, "offset": 0, "pv": 1, "pvMin": 1})
	msgs <- webrtc.DataChannelMessage{IsString: true, Data: ack}

	// Parked: more than the high-water mark handed to the channel and no
	// progress for 300 ms. dc.Send never blocks, so the backpressure wait is
	// the only place the chunk loop can stop. The buffered amount itself is
	// no signal: SACKs for what the receiver's own buffer took pull it back
	// under the mark after the sender has parked.
	deadline := time.Now().Add(20 * time.Second)
	last, stableSince := int64(-1), time.Now()
	for {
		select {
		case err := <-errc:
			t.Fatalf("send ended before it parked: %v", err)
		default:
		}
		if cur := sent.Load(); cur != last {
			last, stableSince = cur, time.Now()
		}
		if last >= bufferedAmountHighWater && time.Since(stableSince) >= 300*time.Millisecond {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the sender never parked on a full buffer (%d bytes handed over)", last)
		}
		time.Sleep(10 * time.Millisecond)
	}

	msgs <- webrtc.DataChannelMessage{IsString: true, Data: []byte(diskFullRefusal)}
	close(closed)
	select {
	case err := <-errc:
		wantDiskFull(t, err)
	case <-time.After(10 * time.Second):
		t.Fatal("the send did not end within 10s of the refusal and the close")
	}
}
