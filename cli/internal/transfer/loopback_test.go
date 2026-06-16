package transfer

import (
	"crypto/rand"
	"crypto/sha256"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// newConnectedPair wires two in-process pion PeerConnections together over
// loopback ICE and returns the sender's open data channel plus a channel that
// yields the receiver's data channel once it opens. Non-trickle signaling
// (gather-then-exchange) keeps the handshake free of candidate-ordering races.
func newConnectedPair(t *testing.T) (sender *webrtc.DataChannel, recvCh <-chan *webrtc.DataChannel, closeFn func()) {
	t.Helper()

	se := webrtc.SettingEngine{}
	se.SetIncludeLoopbackCandidate(true) // ensure connectivity on isolated hosts
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
	pcReceiver.OnDataChannel(func(dc *webrtc.DataChannel) {
		dc.OnOpen(func() { got <- dc })
	})

	dc, err := pcSender.CreateDataChannel("floe", nil)
	if err != nil {
		t.Fatalf("create data channel: %v", err)
	}
	senderOpen := make(chan struct{})
	dc.OnOpen(func() { close(senderOpen) })

	// Offer (sender) → fully gather → receiver.
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

	// Answer (receiver) → fully gather → sender.
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

	return dc, got, func() {
		pcSender.Close()
		pcReceiver.Close()
	}
}

// runTransfer sends srcPaths over a connected pair into a fresh output dir and
// returns it. The receiver's OnMessage handler (registered inside ReceiveFiles)
// must be set before the first byte is sent; since the test controls when
// SendFiles runs, a short delay after starting the receiver guarantees that.
func runTransfer(t *testing.T, srcPaths []string) string {
	t.Helper()

	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	outDir := t.TempDir()
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFiles(dc, outDir, true)
	}()

	// Let the receiver register its OnMessage handler before any data is sent.
	time.Sleep(300 * time.Millisecond)

	if err := SendFiles(sender, srcPaths); err != nil {
		t.Fatalf("SendFiles: %v", err)
	}

	select {
	case err := <-recvErr:
		if err != nil {
			t.Fatalf("ReceiveFiles: %v", err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("ReceiveFiles did not complete")
	}
	return outDir
}

// TestLoopbackLargeFile is the end-to-end regression guard for the backpressure
// and flush fixes: a 20 MB file exceeds the 8 MB high-water mark, so it exercises
// multiple drain cycles. The received bytes must match the source exactly.
func TestLoopbackLargeFile(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}

	srcDir := t.TempDir()
	srcPath := filepath.Join(srcDir, "blob.bin")
	data := make([]byte, 20*1024*1024)
	if _, err := rand.Read(data); err != nil {
		t.Fatalf("generate random data: %v", err)
	}
	if err := os.WriteFile(srcPath, data, 0644); err != nil {
		t.Fatalf("write source: %v", err)
	}
	want := sha256.Sum256(data)

	outDir := runTransfer(t, []string{srcPath})

	got, err := os.ReadFile(filepath.Join(outDir, "blob.bin"))
	if err != nil {
		t.Fatalf("read received file: %v", err)
	}
	if len(got) != len(data) {
		t.Fatalf("size mismatch: got %d bytes, want %d", len(got), len(data))
	}
	if sha256.Sum256(got) != want {
		t.Fatal("content hash mismatch: received file is corrupt")
	}
}

// TestLoopbackImmediateReceiverClose reproduces the CLI-to-CLI race where the
// receiver closes its PeerConnection immediately after ReceiveFiles returns.
// Before the fix the sender's SCTP buffer stalled at a non-zero value because
// the final SACKs never arrived, causing "timed out flushing" errors even
// though the file was fully received.
func TestLoopbackImmediateReceiverClose(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}

	srcDir := t.TempDir()
	srcPath := filepath.Join(srcDir, "blob.bin")
	data := make([]byte, 5*1024*1024) // 5 MB — enough to exercise backpressure
	if _, err := rand.Read(data); err != nil {
		t.Fatalf("generate random data: %v", err)
	}
	if err := os.WriteFile(srcPath, data, 0644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	senderDC, recvCh, closeFn := newConnectedPair(t)
	// Do NOT defer closeFn — we close the receiver PC ourselves immediately
	// after ReceiveFiles returns to reproduce the race.

	outDir := t.TempDir()
	recvDone := make(chan error, 1)

	go func() {
		dc := <-recvCh
		err := ReceiveFiles(dc, outDir, true)
		// Close receiver immediately — this is what `defer conn.Close()` does
		// in `runReceive`. The SCTP teardown races the final SACK to the sender.
		dc.Close()
		recvDone <- err
	}()

	time.Sleep(300 * time.Millisecond)

	sendErr := SendFiles(senderDC, []string{srcPath})
	closeFn() // clean up sender PC after SendFiles returns

	if sendErr != nil {
		t.Fatalf("SendFiles returned error after receiver closed immediately: %v", sendErr)
	}

	select {
	case err := <-recvDone:
		if err != nil {
			t.Fatalf("ReceiveFiles: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("ReceiveFiles did not complete")
	}
}

// TestLoopbackSmallJSONFile guards the framing fix end to end: a file whose
// bytes are a sub-1 KB JSON object must arrive byte-identical, not be mistaken
// for a control message and dropped.
func TestLoopbackSmallJSONFile(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}

	srcDir := t.TempDir()
	srcPath := filepath.Join(srcDir, "config.json")
	data := []byte(`{"name":"floe","type":"settings","values":[1,2,3],"nested":{"k":"v"}}`)
	if err := os.WriteFile(srcPath, data, 0644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	outDir := runTransfer(t, []string{srcPath})

	got, err := os.ReadFile(filepath.Join(outDir, "config.json"))
	if err != nil {
		t.Fatalf("read received file: %v", err)
	}
	if string(got) != string(data) {
		t.Fatalf("JSON file corrupted in transit:\n got: %q\nwant: %q", got, data)
	}
}
