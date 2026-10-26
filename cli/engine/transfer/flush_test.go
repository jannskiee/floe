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

import (
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestFlushControlReturnsOnceTheChannelHasClosed(t *testing.T) {
	se := webrtc.SettingEngine{}
	se.SetIncludeLoopbackCandidate(true)
	api := webrtc.NewAPI(webrtc.WithSettingEngine(se))
	pcCreator, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("create creator PC: %v", err)
	}
	pcAnswerer, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("create answerer PC: %v", err)
	}
	t.Cleanup(func() {
		pcCreator.Close()
		pcAnswerer.Close()
	})

	answered := make(chan *webrtc.DataChannel, 1)
	pcAnswerer.OnDataChannel(func(dc *webrtc.DataChannel) {
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

	// Leave the way a closing page does (the desktop test's leave): close the
	// channel and wait for that close, then the connection.
	remoteClosed := make(chan struct{})
	remote.OnClose(func() { close(remoteClosed) })
	_ = remote.Close()
	select {
	case <-remoteClosed:
	case <-time.After(10 * time.Second):
	}
	pcAnswerer.Close()
	select {
	case <-closed:
	case <-time.After(10 * time.Second):
		t.Fatal("the creator never heard the channel close")
	}
	if dc.BufferedAmount() == 0 {
		t.Skip("the answerer acknowledged the DCEP OPEN before it left, so there is nothing to flush")
	}

	start := time.Now()
	sendIncompatible(dc, incompatibleFrame("test", "", "stopped", -1), false)
	if d := time.Since(start); d > controlFlushTimeout/4 {
		t.Fatalf("the flush of a closed channel took %v, want under %v", d, controlFlushTimeout/4)
	}
}
