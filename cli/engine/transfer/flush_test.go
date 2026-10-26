package transfer

// flushControl waits for the send buffer to drain so that an abort frame is not
// lost to the teardown (#284). This pins its other side: a channel whose peer
// has gone never drains, so the wait must end once the channel has closed
// instead of at the deadline.
//
// Found as a flake of the desktop's
// TestRunRequestDropVisitorLeavesWhileDecidingReopens (2.0028 s against a 2 s
// bound, on #760's CI). A request-link host makes the channel, so its buffer
// still counts the 16-byte DCEP OPEN until the visitor's delayed SACK, about
// 200 ms after the channel opens. A visitor who left inside that window took
// the SACK with it, and the host's refusal then polled a closed channel for the
// whole controlFlushTimeout before the link could wait again.
//
// The test builds that state instead of waiting for it. It used to rely on the
// DCEP OPEN alone and skipped whenever the answerer acknowledged it before
// leaving. Now the answerer's reads are held, so it acknowledges one receive
// window and the one message its parked read loop has taken (80 KiB of the
// 256 KiB queued, measured), and four windows are queued before it leaves;
// pion releases buffered bytes only on an acknowledgment, so the rest stays
// counted on the closed channel.

import (
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// stuckWindow is the answerer's receive window, set rather than left at pion's
// default so that the four windows queued below are four by construction.
const stuckWindow = 64 << 10

func TestFlushControlReturnsOnceTheChannelHasClosed(t *testing.T) {
	dc := closedChannelHoldingBytes(t)

	start := time.Now()
	sendIncompatible(dc, incompatibleFrame("test", "", "stopped", -1), false)
	if d := time.Since(start); d > controlFlushTimeout/4 {
		t.Fatalf("the flush of a closed channel took %v, want under %v", d, controlFlushTimeout/4)
	}
}

// closedChannelHoldingBytes returns the creator's end of a loopback pair whose
// answerer has left with bytes still unacknowledged: the channel is Closed and
// its BufferedAmount is above zero, and with the answerer gone neither can
// change. It fails the test rather than skipping it when that does not hold.
// cli/cmd/floe/stopflush_test.go keeps a copy, because a test helper cannot
// cross packages; a change to one belongs in both.
func closedChannelHoldingBytes(t *testing.T) *webrtc.DataChannel {
	t.Helper()
	se := webrtc.SettingEngine{}
	se.SetIncludeLoopbackCandidate(true)
	se.SetSCTPMaxReceiveBufferSize(stuckWindow)
	api := webrtc.NewAPI(webrtc.WithSettingEngine(se))
	pcCreator, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("create creator PC: %v", err)
	}
	pcAnswerer, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("create answerer PC: %v", err)
	}
	// The answerer's read loop stays parked in OnMessage until release closes,
	// so close it first and let that loop return.
	release := make(chan struct{})
	t.Cleanup(func() {
		close(release)
		pcCreator.Close()
		pcAnswerer.Close()
	})

	answered := make(chan *webrtc.DataChannel, 1)
	pcAnswerer.OnDataChannel(func(dc *webrtc.DataChannel) {
		// Here, not in OnOpen: pion runs OnDataChannel before it starts the
		// channel's read loop, and a loop that finds no handler drops each
		// message and keeps reading, which acknowledges all of them.
		dc.OnMessage(func(webrtc.DataChannelMessage) { <-release })
		dc.OnOpen(func() { answered <- dc })
	})
	dc, err := pcCreator.CreateDataChannel("floe", nil)
	if err != nil {
		t.Fatalf("create data channel: %v", err)
	}
	opened := make(chan struct{})
	closed := make(chan struct{})
	dc.OnOpen(func() { close(opened) })
	dc.OnClose(func() { close(closed) })

	offer, err := pcCreator.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gc := webrtc.GatheringCompletePromise(pcCreator)
	if err := pcCreator.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gc
	if err := pcAnswerer.SetRemoteDescription(*pcCreator.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	answer, err := pcAnswerer.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	ga := webrtc.GatheringCompletePromise(pcAnswerer)
	if err := pcAnswerer.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	<-ga
	if err := pcCreator.SetRemoteDescription(*pcAnswerer.LocalDescription()); err != nil {
		t.Fatal(err)
	}

	var remote *webrtc.DataChannel
	select {
	case <-opened:
	case <-time.After(20 * time.Second):
		t.Fatal("the creator's data channel never opened")
	}
	select {
	case remote = <-answered:
	case <-time.After(20 * time.Second):
		t.Fatal("the answerer's data channel never opened")
	}

	// 16 KiB a message, the engine's defaultChunkSize (cli/engine/transfer/sender.go).
	const queued = 4 * stuckWindow
	chunk := make([]byte, 16<<10)
	for sent := 0; sent < queued; sent += len(chunk) {
		if err := dc.Send(chunk); err != nil {
			t.Fatalf("queue %d of %d bytes: %v", sent, queued, err)
		}
	}

	// Leave the way a closing page does: the channel, then the connection.
	// Nothing waits for the answerer's own OnClose, which its parked read loop
	// cannot reach.
	_ = remote.Close()
	pcAnswerer.Close()
	select {
	case <-closed:
	case <-time.After(10 * time.Second):
		t.Fatal("the creator never heard the channel close")
	}
	if s := dc.ReadyState(); s != webrtc.DataChannelStateClosed {
		t.Fatalf("precondition: the creator's channel is %s after its OnClose", s)
	}
	if dc.BufferedAmount() == 0 {
		t.Fatalf("precondition: none of the %d bytes queued against a %d-byte window is still buffered", queued, stuckWindow)
	}
	return dc
}
