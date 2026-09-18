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
		if ok, _, _ := parseReceived(m.Data, 0); !m.IsString && ok {
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

	// peer.TestLoopbackOffererHoldsAckLong holds the first ack for 75 s on the
	// real watchdogs, which it cannot read from its external test package, so
	// the check that the hold still outlasts both lives here, before they shrink.
	const longHold = 75 * time.Second
	if longHold <= receiveIdleTimeout || longHold <= receiveStallTimeout {
		t.Fatalf("the 75 s hold in peer.TestLoopbackOffererHoldsAckLong no longer outlasts the receive watchdogs (%s idle, %s stall)",
			receiveIdleTimeout, receiveStallTimeout)
	}

	oldIdle, oldStall := receiveIdleTimeout, receiveStallTimeout
	receiveIdleTimeout = 200 * time.Millisecond
	receiveStallTimeout = 200 * time.Millisecond
	t.Cleanup(func() { receiveIdleTimeout = oldIdle; receiveStallTimeout = oldStall })

	runOffererHold(t, 2*time.Second)
}
