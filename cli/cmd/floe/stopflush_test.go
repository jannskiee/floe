package main

// Ctrl+C's stop work waits for this side's send buffer to empty before it
// closes the connection: tellCanceled on a plain send, and endLinger, which
// the receive's stop starts on its own goroutine once the receive has
// finished. pion releases buffered bytes only on the peer's acknowledgment,
// so once the peer has gone the count never falls, and each wait sat out its
// whole bound (sendStopFlush, receiveStopFlush). On the send that held back
// "Canceled."; the receive already ends on the channel's close, so nothing
// waited for endLinger, and its guard keeps the two loops alike. Both now end
// once the channel has closed, the guard the engine's flushControl has
// (TestFlushControlReturnsOnceTheChannelHasClosed).

import (
	"testing"
	"time"

	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/pion/webrtc/v4"
)

func TestTellCanceledReturnsOnceTheChannelHasClosed(t *testing.T) {
	dc, conn := closedChannelHoldingBytes(t), idleConnection(t)

	start := time.Now()
	tellCanceled(dc, conn)
	if d := time.Since(start); d >= sendStopFlush/2 {
		t.Fatalf("tellCanceled on a closed channel took %v, want under %v", d, sendStopFlush/2)
	}
}

func TestEndLingerReturnsOnceTheChannelHasClosed(t *testing.T) {
	dc, conn := closedChannelHoldingBytes(t), idleConnection(t)

	start := time.Now()
	endLinger(dc, conn)
	if d := time.Since(start); d >= receiveStopFlush/2 {
		t.Fatalf("endLinger on a closed channel took %v, want under %v", d, receiveStopFlush/2)
	}
}

// idleConnection is the connection the two calls close at the end. Nothing
// binds: no offer arrives, so ICE never gathers.
func idleConnection(t *testing.T) *peer.Connection {
	t.Helper()
	conn, err := peer.New(nil, &signaling.Client{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(conn.Close)
	return conn
}

// stuckWindow is the answerer's receive window, set rather than left at pion's
// default so that the four windows queued below are four by construction.
const stuckWindow = 64 << 10

// closedChannelHoldingBytes returns the creator's end of a loopback pair whose
// answerer has left with bytes still unacknowledged: the channel is Closed and
// its BufferedAmount is above zero, and with the answerer gone neither can
// change. It fails the test rather than skipping it when that does not hold.
// A copy of the helper in cli/engine/transfer/flush_test.go, which says how
// the state is built; a change to one belongs in both.
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
