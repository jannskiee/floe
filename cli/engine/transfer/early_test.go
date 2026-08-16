package transfer

import (
	"crypto/rand"
	"crypto/sha256"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// newPumpedPair is newConnectedPair with the receiver wired the way
// peer.Connection now wires it: the message handler is installed inside
// OnDataChannel, before OnOpen and before pion can start reading, and it feeds a
// channel instead of the transfer layer registering its own handler later.
//
// It is deliberately a separate harness rather than a change to
// newConnectedPair. The other loopback tests rely on nothing being delivered
// before ReceiveFiles installs its handler, which is the very assumption this
// file exists to attack, and giving them a pump would make them flaky for
// reasons that have nothing to do with what they test.
func newPumpedPair(t *testing.T) (sender *webrtc.DataChannel, recvCh <-chan *webrtc.DataChannel, msgs <-chan webrtc.DataChannelMessage, closed <-chan struct{}, closeFn func()) {
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

	got := make(chan *webrtc.DataChannel, 1)
	pump := make(chan webrtc.DataChannelMessage, 256)
	shut := make(chan struct{})
	var once sync.Once
	pcReceiver.OnDataChannel(func(dc *webrtc.DataChannel) {
		dc.OnClose(func() { once.Do(func() { close(shut) }) })
		dc.OnMessage(func(m webrtc.DataChannelMessage) {
			select {
			case pump <- m:
			case <-shut:
			}
		})
		dc.OnOpen(func() { got <- dc })
	})

	dc, err := pcSender.CreateDataChannel("floe", nil)
	if err != nil {
		t.Fatalf("create data channel: %v", err)
	}
	senderOpen := make(chan struct{})
	dc.OnOpen(func() { close(senderOpen) })

	offer, err := pcSender.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create offer: %v", err)
	}
	gatherSender := webrtc.GatheringCompletePromise(pcSender)
	if err := pcSender.SetLocalDescription(offer); err != nil {
		t.Fatalf("sender SetLocalDescription: %v", err)
	}
	<-gatherSender
	if err := pcReceiver.SetRemoteDescription(*pcSender.LocalDescription()); err != nil {
		t.Fatalf("receiver SetRemoteDescription: %v", err)
	}

	answer, err := pcReceiver.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("create answer: %v", err)
	}
	gatherReceiver := webrtc.GatheringCompletePromise(pcReceiver)
	if err := pcReceiver.SetLocalDescription(answer); err != nil {
		t.Fatalf("receiver SetLocalDescription: %v", err)
	}
	<-gatherReceiver
	if err := pcSender.SetRemoteDescription(*pcReceiver.LocalDescription()); err != nil {
		t.Fatalf("sender SetRemoteDescription: %v", err)
	}

	select {
	case <-senderOpen:
	case <-time.After(20 * time.Second):
		pcSender.Close()
		pcReceiver.Close()
		t.Fatal("sender data channel never opened")
	}

	return dc, got, pump, shut, func() {
		pcSender.Close()
		pcReceiver.Close()
	}
}

// TestReceiveDrainsMessagesThatArrivedFirst is the regression test for a bug
// that silently ate roughly four out of five same-machine transfers.
//
// pion acknowledges a data channel and starts reading from it before the
// application is told anything, and a message it reads while DataChannel's
// handler is still nil is discarded permanently: SCTP has already acked it, so
// it is never retransmitted and the sender believes it was delivered. The
// transfer layer used to register that handler at the top of the receive, one
// goroutine hop and a couple of prints too late, so on a fast path the sender's
// metadata could be gone before anyone was listening. Both ends then sat on a
// healthy connection with nothing happening until a watchdog fired.
//
// The test is deterministic rather than timing-based: it waits for the message
// to be sitting in the pump BEFORE the receive starts, which is precisely the
// state that used to be unrecoverable. Nothing here sleeps hoping to win a race.
func TestReceiveDrainsMessagesThatArrivedFirst(t *testing.T) {
	sender, recvCh, msgs, closed, closeFn := newPumpedPair(t)
	defer closeFn()

	src := filepath.Join(t.TempDir(), "early.bin")
	payload := make([]byte, 64*1024)
	if _, err := rand.Read(payload); err != nil {
		t.Fatalf("seed payload: %v", err)
	}
	if err := os.WriteFile(src, payload, 0o600); err != nil {
		t.Fatalf("write source: %v", err)
	}

	var dc *webrtc.DataChannel
	select {
	case dc = <-recvCh:
	case <-time.After(20 * time.Second):
		t.Fatal("receiver data channel never opened")
	}

	// Send with nobody in the transfer layer listening yet.
	sendErr := make(chan error, 1)
	go func() { sendErr <- SendFiles(sender, []string{src}, "") }()

	// Block until the sender's first message is provably buffered. This is the
	// whole point: at this instant the metadata has been delivered and acked at
	// the SCTP layer, and the receive has not started.
	deadline := time.After(20 * time.Second)
	for len(msgs) == 0 {
		select {
		case <-deadline:
			t.Fatal("sender's first message never reached the pump")
		default:
			time.Sleep(2 * time.Millisecond)
		}
	}

	outDir := t.TempDir()
	recvErr := make(chan error, 1)
	go func() {
		recvErr <- ReceiveFilesWithOptions(dc, outDir, true, "", "", ReceiveOptions{
			Messages: msgs,
			Closed:   closed,
		})
	}()

	select {
	case err := <-recvErr:
		if err != nil {
			t.Fatalf("receive failed on a message that arrived before it started: %v", err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("receive hung: the early message was dropped, which is the bug this guards")
	}

	select {
	case err := <-sendErr:
		if err != nil {
			t.Fatalf("send failed: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("send did not return")
	}

	out, err := os.ReadFile(filepath.Join(outDir, "early.bin"))
	if err != nil {
		t.Fatalf("read received file: %v", err)
	}
	if sha256.Sum256(out) != sha256.Sum256(payload) {
		t.Fatal("received bytes differ from the source")
	}
}

// TestReceiveWithoutPumpStillWorks keeps the fallback honest: a caller that owns
// its data channel and registered nothing must still get the old behaviour,
// because that is what every other test in this package relies on.
func TestReceiveWithoutPumpStillWorks(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "plain.bin")
	payload := make([]byte, 32*1024)
	if _, err := rand.Read(payload); err != nil {
		t.Fatalf("seed payload: %v", err)
	}
	if err := os.WriteFile(src, payload, 0o600); err != nil {
		t.Fatalf("write source: %v", err)
	}
	outDir := runTransfer(t, []string{src})
	out, err := os.ReadFile(filepath.Join(outDir, "plain.bin"))
	if err != nil {
		t.Fatalf("read received file: %v", err)
	}
	if sha256.Sum256(out) != sha256.Sum256(payload) {
		t.Fatal("received bytes differ from the source")
	}
}
