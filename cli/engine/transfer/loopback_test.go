package transfer

import (
	"crypto/rand"
	"crypto/sha256"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
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
		recvErr <- ReceiveFiles(dc, outDir, true, "", "")
	}()

	// Let the receiver register its OnMessage handler before any data is sent.
	time.Sleep(300 * time.Millisecond)

	if err := SendFiles(sender, srcPaths, ""); err != nil {
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

// listDir returns the recursive file names under dir, for "nothing left
// behind" assertions that also catch de-collided names and stray subfiles.
func listDir(t *testing.T, dir string) []string {
	t.Helper()
	var names []string
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			rel, _ := filepath.Rel(dir, path)
			names = append(names, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", dir, err)
	}
	return names
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
		err := ReceiveFiles(dc, outDir, true, "", "")
		// Close receiver immediately — this is what `defer conn.Close()` does
		// in `runReceive`. The SCTP teardown races the final SACK to the sender.
		dc.Close()
		recvDone <- err
	}()

	time.Sleep(300 * time.Millisecond)

	sendErr := SendFiles(senderDC, []string{srcPath}, "")
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

// TestLoopbackControlShapedFiles is the #316 repro, end to end over a real pion
// pair. TestLoopbackSmallJSONFile above only ever covered a JSON object whose
// "type" was NOT a control type, so it passed for the wrong reason: content
// probing declined it because of the type value, not because of the framing.
//
// A file whose whole content IS a control frame is what content probing could
// not survive. Each of these arrived as a 0-byte file before #311 and as a hard
// error afterwards; both are the same lost bytes. The receiver now decides from
// the SCTP framing, so a binary chunk is file data whatever it spells.
func TestLoopbackControlShapedFiles(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}

	cases := []struct {
		name    string
		content string
	}{
		// The issue's own repro: 14 bytes, and a one-click send from desktop's
		// Send text box.
		{"end.json", `{"type":"end"}`},
		{"received.json", `{"type":"received"}`},
		{"ack.json", `{"type":"ack","id":"x","offset":0}`},
		{"incompatible.json", `{"type":"incompatible","reason":"nope"}`},
		// A whole metadata frame saved to a file, which is what anyone
		// debugging the protocol ends up with on disk.
		{"metadata.json", `{"type":"metadata","id":"a","fileName":"x","fileSize":1,"index":1,"total":1}`},
		// Leading whitespace still reaches looksLikeJSONObject.
		{"padded.json", "   " + `{"type":"end"}`},
	}

	srcDir := t.TempDir()
	var paths []string
	for _, tc := range cases {
		srcPath := filepath.Join(srcDir, tc.name)
		if err := os.WriteFile(srcPath, []byte(tc.content), 0644); err != nil {
			t.Fatalf("write %s: %v", tc.name, err)
		}
		paths = append(paths, srcPath)
	}

	// One batch, not one transfer each: a frame eaten mid-batch also derails
	// every file queued behind it, and that is the failure people actually hit.
	outDir := runTransfer(t, paths)

	for _, tc := range cases {
		got, err := os.ReadFile(filepath.Join(outDir, tc.name))
		if err != nil {
			t.Fatalf("read %s: %v", tc.name, err)
		}
		if string(got) != tc.content {
			t.Fatalf("%s corrupted in transit:\n got: %q\nwant: %q", tc.name, got, tc.content)
		}
	}
}

// TestLoopbackDuplicateNames is the end-to-end guard for the receiver's
// never-overwrite rule: two files with the same base name (two pasted
// screenshots, or a repeat send) must both survive, the second de-collided to
// "name (1).ext", rather than one clobbering the other.
func TestLoopbackDuplicateNames(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}

	dirA, dirB := t.TempDir(), t.TempDir()
	pathA := filepath.Join(dirA, "shot.png")
	pathB := filepath.Join(dirB, "shot.png")
	if err := os.WriteFile(pathA, []byte("AAA"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pathB, []byte("BBBB"), 0644); err != nil {
		t.Fatal(err)
	}

	outDir := runTransfer(t, []string{pathA, pathB})

	first, err := os.ReadFile(filepath.Join(outDir, "shot.png"))
	if err != nil {
		t.Fatalf("read first file: %v", err)
	}
	second, err := os.ReadFile(filepath.Join(outDir, "shot (1).png"))
	if err != nil {
		t.Fatalf("read de-collided file: %v", err)
	}
	if string(first) != "AAA" || string(second) != "BBBB" {
		t.Fatalf("contents = %q / %q, want AAA / BBBB (a same-name file was overwritten)", first, second)
	}
}

// TestLoopbackProgressSavedName pins the contract GUIs depend on to open the
// right file: progress events carry the on-disk name (SavedName), which matches
// the sender's name normally and the de-collided "name (1).ext" after a
// collision. Also the only test driving ReceiveFilesWithProgress with a real
// callback rather than the CLI's nil.
func TestLoopbackProgressSavedName(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}

	dirA, dirB := t.TempDir(), t.TempDir()
	pathA := filepath.Join(dirA, "shot.png")
	pathB := filepath.Join(dirB, "shot.png")
	if err := os.WriteFile(pathA, []byte("AAA"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pathB, []byte("BBBB"), 0644); err != nil {
		t.Fatal(err)
	}

	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	outDir := t.TempDir()
	var events []Progress
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFilesWithProgress(dc, outDir, true, "", "", func(p Progress) {
			events = append(events, p)
		})
	}()

	// Let the receiver register its OnMessage handler before any data is sent.
	time.Sleep(300 * time.Millisecond)

	if err := SendFiles(sender, []string{pathA, pathB}, ""); err != nil {
		t.Fatalf("SendFiles: %v", err)
	}
	select {
	case err := <-recvErr:
		if err != nil {
			t.Fatalf("ReceiveFilesWithProgress: %v", err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("ReceiveFilesWithProgress did not complete")
	}

	// The last event per file is the one a UI acts on.
	final := map[int]Progress{}
	for _, p := range events {
		final[p.FileIndex] = p
	}
	if len(final) != 2 {
		t.Fatalf("progress covered %d files, want 2 (events: %d)", len(final), len(events))
	}
	if p := final[1]; p.FileName != "shot.png" || p.SavedName != "shot.png" {
		t.Fatalf("first file: FileName %q SavedName %q, want shot.png for both", p.FileName, p.SavedName)
	}
	if p := final[2]; p.FileName != "shot.png" || p.SavedName != "shot (1).png" {
		t.Fatalf("second file: FileName %q SavedName %q, want shot.png / shot (1).png", p.FileName, p.SavedName)
	}
	if _, err := os.Stat(filepath.Join(outDir, final[2].SavedName)); err != nil {
		t.Fatalf("SavedName does not point at a real file: %v", err)
	}
}

// TestLoopbackCloseBeforeFirstFile: a sender that connects and then closes
// without sending anything (it was cancelled, or its relay gate blocked the
// transfer) must surface an error on the receiver instead of reporting a
// successful zero-file transfer.
func TestLoopbackCloseBeforeFirstFile(t *testing.T) {
	sender, recvCh, closeFn := newConnectedPair(t)
	defer closeFn()

	outDir := t.TempDir()
	recvErr := make(chan error, 1)
	go func() {
		dc := <-recvCh
		recvErr <- ReceiveFiles(dc, outDir, true, "", "")
	}()

	// Let the receiver wire its handlers, then walk away without sending.
	time.Sleep(300 * time.Millisecond)
	if err := sender.Close(); err != nil {
		t.Fatalf("sender close: %v", err)
	}

	select {
	case err := <-recvErr:
		if err == nil {
			t.Fatal("ReceiveFiles reported success for a session with no files; want an error")
		}
		if !strings.Contains(err.Error(), "before any file") {
			t.Fatalf("expected a no-files close error, got: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("ReceiveFiles did not return after the data channel closed")
	}
}

// The tests below run the pairing the Request link's Stage 1 depends on, which
// no other test in this package runs: the peer that created the data channel
// and made the offer (the host) RECEIVES, and the peer that got the channel
// from OnDataChannel and answered (the visitor) SENDS. Every test above has the
// offerer send. peer/hostreceive_test.go runs the same direction through
// peer.New and a signaling relay.

// pumpChannel installs the only OnMessage and OnClose handlers dc will have and
// returns the stream to pass as Messages and Closed, the way
// peer.Connection.attach wires a channel. Call it before the far side can send
// anything on dc. tap, when set, sees every message first, on pion's goroutine.
func pumpChannel(dc *webrtc.DataChannel, tap func(webrtc.DataChannelMessage)) (<-chan webrtc.DataChannelMessage, <-chan struct{}) {
	msgs := make(chan webrtc.DataChannelMessage, 256)
	closed := make(chan struct{})
	var once sync.Once
	dc.OnClose(func() { once.Do(func() { close(closed) }) })
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if tap != nil {
			tap(m)
		}
		select {
		case msgs <- m:
		case <-closed:
		}
	})
	return msgs, closed
}

// offererPair is newConnectedPair with the roles swapped. Both ends are pumped
// before either can send, so nothing here sleeps hoping a handler is in place.
type offererPair struct {
	host, visitor             *webrtc.DataChannel
	hostMsgs, visitorMsgs     <-chan webrtc.DataChannelMessage
	hostClosed, visitorClosed <-chan struct{}
	// received is closed when the host's "received" frame reaches the visitor,
	// which the host sends only after committing every file.
	received <-chan struct{}
}

func newOffererPair(t *testing.T, hostTap func(webrtc.DataChannelMessage)) *offererPair {
	t.Helper()

	offerer, answererCh, closeFn := newConnectedPair(t)
	t.Cleanup(closeFn)

	var answerer *webrtc.DataChannel
	select {
	case answerer = <-answererCh:
	case <-time.After(20 * time.Second):
		t.Fatal("answerer data channel never opened")
	}

	received := make(chan struct{})
	var receivedOnce sync.Once
	p := &offererPair{host: offerer, visitor: answerer, received: received}
	p.hostMsgs, p.hostClosed = pumpChannel(offerer, hostTap)
	p.visitorMsgs, p.visitorClosed = pumpChannel(answerer, func(m webrtc.DataChannelMessage) {
		if !m.IsString && isReceived(m.Data) {
			receivedOnce.Do(func() { close(received) })
		}
	})
	return p
}

// finish waits for the visitor's send, then for the host's "received" frame,
// then closes the visitor's channel as the CLI's deferred close would, and
// returns once the host's receive has returned nil.
func (p *offererPair) finish(t *testing.T, sendErr, recvErr <-chan error, bound time.Duration) {
	t.Helper()
	select {
	case err := <-sendErr:
		if err != nil {
			t.Fatalf("visitor SendFilesWithOptions: %v", err)
		}
	case err := <-recvErr:
		// A receive that fails leaves the visitor waiting out its ack deadline,
		// so report it now rather than after the bound.
		t.Fatalf("host receive returned before the visitor's send did: %v", err)
	case <-time.After(bound):
		t.Fatalf("visitor send did not return within %s", bound)
	}
	select {
	case <-p.received:
	case err := <-recvErr:
		t.Fatalf("host receive returned before its received frame reached the visitor: %v", err)
	case <-time.After(20 * time.Second):
		t.Fatal("the host's received frame never reached the visitor")
	}
	if err := p.visitor.Close(); err != nil {
		t.Fatalf("visitor close: %v", err)
	}
	select {
	case err := <-recvErr:
		if err != nil {
			t.Fatalf("host ReceiveFilesWithOptions: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("host receive did not return after the visitor closed")
	}
}

// waitQueued blocks until msgs holds at least one message, polling every 2 ms
// for at most 20 s, the staging early_test.go uses.
func waitQueued(t *testing.T, msgs <-chan webrtc.DataChannelMessage) {
	t.Helper()
	deadline := time.After(20 * time.Second)
	for len(msgs) == 0 {
		select {
		case <-deadline:
			t.Fatal("the visitor's first message never reached the host's pump")
		default:
			time.Sleep(2 * time.Millisecond)
		}
	}
}

// writeRandom writes size random bytes to dir/rel, creating parent folders,
// and returns their SHA-256.
func writeRandom(t *testing.T, dir, rel string, size int) [sha256.Size]byte {
	t.Helper()
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		t.Fatalf("generate %s: %v", rel, err)
	}
	path := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir for %s: %v", rel, err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write %s: %v", rel, err)
	}
	return sha256.Sum256(data)
}

// TestLoopbackOffererReceives: the host receives a batch holding a nested
// folder, a 20 MiB file (several backpressure cycles) and a file spanning
// three full 256 KiB chunks plus a tail. Every file must land byte-identical
// under its relative path, the host's "received" frame must reach the visitor,
// and no .part staging file may remain.
func TestLoopbackOffererReceives(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}

	srcDir := t.TempDir()
	want := map[string][sha256.Size]byte{
		"album/cover.txt":             writeRandom(t, srcDir, "album/cover.txt", 1500),
		"album/disc1/track01.bin":     writeRandom(t, srcDir, "album/disc1/track01.bin", 40*1024),
		"album/disc1/notes/liner.txt": writeRandom(t, srcDir, "album/disc1/notes/liner.txt", 700),
		"big.bin":                     writeRandom(t, srcDir, "big.bin", 20*1024*1024),
		"span.bin":                    writeRandom(t, srcDir, "span.bin", 3*maxChunkSize+12345),
	}

	var fullChunks atomic.Int64
	p := newOffererPair(t, func(m webrtc.DataChannelMessage) {
		if !m.IsString && len(m.Data) == maxChunkSize {
			fullChunks.Add(1)
		}
	})

	// pion v4.2.19 offers a=max-message-size:1073741823, so the answering side
	// sends full-size chunks. A smaller negotiated ceiling would leave the
	// "over 256 KiB" file proving nothing about full chunks in this direction.
	tr := p.visitor.Transport()
	if tr == nil {
		t.Fatal("visitor data channel has no SCTP transport")
	}
	if got := chunkSizeFor(tr.GetCapabilities().MaxMessageSize); got != maxChunkSize {
		t.Fatalf("visitor chunk size %d, want %d (negotiated max-message-size %d)",
			got, maxChunkSize, tr.GetCapabilities().MaxMessageSize)
	}

	outDir := t.TempDir()
	recvErr := make(chan error, 1)
	go func() {
		recvErr <- ReceiveFilesWithOptions(p.host, outDir, true, "", "", ReceiveOptions{
			OnProgress: func(Progress) {},
			Messages:   p.hostMsgs,
			Closed:     p.hostClosed,
		})
	}()

	sendErr := make(chan error, 1)
	go func() {
		paths := []string{
			filepath.Join(srcDir, "album"),
			filepath.Join(srcDir, "big.bin"),
			filepath.Join(srcDir, "span.bin"),
		}
		sendErr <- SendFilesWithOptions(p.visitor, paths, "", SendOptions{
			OnProgress: func(Progress) {},
			Messages:   p.visitorMsgs,
			Closed:     p.visitorClosed,
		})
	}()

	p.finish(t, sendErr, recvErr, 60*time.Second)

	got := listDir(t, outDir)
	var wantNames []string
	for name := range want {
		wantNames = append(wantNames, name)
	}
	sort.Strings(got)
	sort.Strings(wantNames)
	if strings.Join(got, "\n") != strings.Join(wantNames, "\n") {
		t.Fatalf("output tree:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(wantNames, "\n"))
	}
	for _, name := range got {
		if strings.HasSuffix(name, ".part") {
			t.Fatalf("staging file left behind: %s", name)
		}
	}
	for name, sum := range want {
		data, err := os.ReadFile(filepath.Join(outDir, filepath.FromSlash(name)))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if sha256.Sum256(data) != sum {
			t.Fatalf("%s: SHA-256 differs from the source", name)
		}
	}
	if fullChunks.Load() == 0 {
		t.Fatalf("no %d-byte chunk reached the host", maxChunkSize)
	}
}

// runOffererHold stages the visitor's metadata in the host's pump, then runs
// the host's receive with an OnIncoming that blocks for hold, the way a person
// deciding at an Accept prompt does, and requires the transfer to complete.
// Staging first means a shrunk idle timer cannot fire on the few milliseconds
// the sender needs to produce its metadata.
func runOffererHold(t *testing.T, hold time.Duration) {
	t.Helper()

	p := newOffererPair(t, nil)

	srcDir := t.TempDir()
	sum := writeRandom(t, srcDir, "held.bin", 64*1024)

	sendErr := make(chan error, 1)
	go func() {
		sendErr <- SendFilesWithOptions(p.visitor, []string{filepath.Join(srcDir, "held.bin")}, "", SendOptions{
			OnProgress: func(Progress) {},
			Messages:   p.visitorMsgs,
			Closed:     p.visitorClosed,
		})
	}()
	waitQueued(t, p.hostMsgs)

	outDir := t.TempDir()
	calls := 0
	var held time.Duration
	recvErr := make(chan error, 1)
	go func() {
		recvErr <- ReceiveFilesWithOptions(p.host, outDir, true, "", "", ReceiveOptions{
			OnProgress: func(Progress) {},
			OnIncoming: func(IncomingInfo) {
				calls++
				start := time.Now()
				time.Sleep(hold)
				held = time.Since(start)
			},
			Messages: p.hostMsgs,
			Closed:   p.hostClosed,
		})
	}()

	// The visitor sits in its ack wait for the whole hold, under the sender's
	// hardcoded 120 s ack deadline.
	p.finish(t, sendErr, recvErr, hold+60*time.Second)

	if calls != 1 {
		t.Fatalf("OnIncoming ran %d times, want 1", calls)
	}
	if held < hold {
		t.Fatalf("OnIncoming held %s, want at least %s", held, hold)
	}
	data, err := os.ReadFile(filepath.Join(outDir, "held.bin"))
	if err != nil {
		t.Fatalf("read held.bin: %v", err)
	}
	if sha256.Sum256(data) != sum {
		t.Fatal("held.bin: SHA-256 differs from the source")
	}
	if got := listDir(t, outDir); len(got) != 1 {
		t.Fatalf("output tree %v, want only held.bin", got)
	}
}

// TestLoopbackOffererHoldsAck: with both receive watchdogs shrunk to 200 ms,
// an OnIncoming that blocks for 2 s must not trip either of them. They are not
// armed while the synchronous callback runs (see the stall watchdog comment in
// ReceiveFilesWithOptions), which is what lets the host hold the first ack
// while a person decides.
func TestLoopbackOffererHoldsAck(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}

	oldIdle, oldStall := receiveIdleTimeout, receiveStallTimeout
	receiveIdleTimeout = 200 * time.Millisecond
	receiveStallTimeout = 200 * time.Millisecond
	t.Cleanup(func() { receiveIdleTimeout = oldIdle; receiveStallTimeout = oldStall })

	runOffererHold(t, 2*time.Second)
}

// TestLoopbackOffererHoldsAckLong holds the first ack for 75 s on real timers:
// longer than the 30 s idle and 60 s stall watchdogs, and under the Go
// sender's hardcoded 120 s ack deadline, which the baseline spike measured
// firing at 120.006 s with "error sending <name>: timed out waiting for ack".
// Never raise the hold to 120 s or more here; a longer wait needs
// SendOptions.AckTimeout (S1-ENG-08).
func TestLoopbackOffererHoldsAckLong(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping the 75 s held-ack loopback transfer in -short mode")
	}

	const hold = 75 * time.Second
	if hold <= receiveIdleTimeout || hold <= receiveStallTimeout {
		t.Fatalf("hold %s no longer outlasts the receive watchdogs (%s idle, %s stall)",
			hold, receiveIdleTimeout, receiveStallTimeout)
	}

	runOffererHold(t, hold)
}
