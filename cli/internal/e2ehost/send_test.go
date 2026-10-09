package main

// The send mode's own proof, in process: a real engine receiver on the other
// end of a real pion pair refuses the corrupt digest, keeps nothing on disk,
// and its refusal is the code the harness reports. Nothing here touches a
// signaling server, so the test is the send loop and the receiver only.

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jannskiee/floe/cli/engine/transfer"
	"github.com/pion/webrtc/v4"
)

// exitPanic turns a mode's exit into a panic a test can recover, because the
// modes end by exiting on purpose.
type exitPanic int

// newTestEvents is an events whose output is discarded and whose exit panics.
// runSend's own sequence (channel-open, route, the refusal wait and the exit
// code) is proved by the live forced-mismatch cells, not here: these tests
// drive sendOneFile, waitForRefusal and emitRoute, the pieces it is built from.
func newTestEvents() *events {
	return &events{
		enc:  json.NewEncoder(io.Discard),
		exit: func(code int) { panic(exitPanic(code)) },
	}
}

// connectedPair wires two in-process pion connections together over loopback
// and returns the sender's data channel plus the receiver's.
func connectedPair(t *testing.T) (sender *webrtc.DataChannel, recvCh <-chan *webrtc.DataChannel, closeFn func()) {
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
	pcReceiver.OnDataChannel(func(dc *webrtc.DataChannel) {
		dc.OnOpen(func() { got <- dc })
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
	case <-open:
	case <-time.After(20 * time.Second):
		t.Fatal("sender data channel never opened")
	}
	return dc, got, func() {
		_ = pcSender.Close()
		_ = pcReceiver.Close()
	}
}

// runSendOneFile drives one file through the harness's own loop against a real
// engine receiver and returns the receiver's error, the output directory and
// the refusal code the harness read.
func runSendOneFile(t *testing.T, mode hashMode, data []byte) (error, string, string) {
	t.Helper()
	sender, recvCh, closeFn := connectedPair(t)
	defer closeFn()

	// The harness sends frames itself, so the receiver's early messages are read
	// straight off the sender channel here.
	back := make(chan webrtc.DataChannelMessage, 32)
	sender.OnMessage(func(m webrtc.DataChannelMessage) {
		select {
		case back <- m:
		default:
		}
	})

	var rdc *webrtc.DataChannel
	select {
	case rdc = <-recvCh:
	case <-time.After(20 * time.Second):
		t.Fatal("receiver data channel never opened")
	}

	dir := t.TempDir()
	recvErr := make(chan error, 1)
	go func() {
		recvErr <- transfer.ReceiveFiles(rdc, dir, true, "test-ver", "")
	}()
	// The receiver registers its handler inside ReceiveFiles; the harness must
	// not send its metadata before that.
	time.Sleep(300 * time.Millisecond)

	src := filepath.Join(t.TempDir(), "payload.bin")
	if err := os.WriteFile(src, data, 0o600); err != nil {
		t.Fatalf("write source: %v", err)
	}

	ev := newTestEvents()
	done := make(chan struct{})
	go func() {
		defer func() {
			_ = recover() // a mode that exits panics through the injected exit
			close(done)
		}()
		sendOneFile(ev, sender, back, make(chan struct{}), src, int64(len(data)), 1, 1, int64(len(data)), mode)
	}()
	select {
	case <-done:
	case <-time.After(60 * time.Second):
		t.Fatal("the harness sender did not finish")
	}

	code := waitForRefusal(back, make(chan struct{}), 10*time.Second)

	var err error
	select {
	case err = <-recvErr:
	case <-time.After(30 * time.Second):
		t.Fatal("ReceiveFiles did not return")
	}
	return err, dir, code
}

// TestSendCorruptHashIsRefused: the digest with one hex digit changed must make
// a real receiver refuse with hash-mismatch and leave no file and no .part.
func TestSendCorruptHashIsRefused(t *testing.T) {
	data := make([]byte, 300000)
	if _, err := rand.Read(data); err != nil {
		t.Fatalf("rand: %v", err)
	}
	err, dir, code := runSendOneFile(t, hashCorrupt, data)
	if err == nil {
		t.Fatal("ReceiveFiles returned nil for a file whose digest did not match")
	}
	if code != "hash-mismatch" {
		t.Fatalf("refusal code = %q, want hash-mismatch", code)
	}
	assertEmptyDir(t, dir)
}

// TestSendMalformedHashIsRefused: an upper-cased digest is not the wire format,
// and a digest that cannot be read cannot vouch for the file either.
func TestSendMalformedHashIsRefused(t *testing.T) {
	data := make([]byte, 120000)
	if _, err := rand.Read(data); err != nil {
		t.Fatalf("rand: %v", err)
	}
	err, dir, code := runSendOneFile(t, hashMalformed, data)
	if err == nil {
		t.Fatal("ReceiveFiles returned nil for a malformed digest")
	}
	if code != "hash-mismatch" {
		t.Fatalf("refusal code = %q, want hash-mismatch", code)
	}
	assertEmptyDir(t, dir)
}

// TestSendRealHashIsAccepted keeps the harness honest: with the real digest the
// same loop and the same receiver finish, so a refusal above means the digest
// and not the hand-written loop.
func TestSendRealHashIsAccepted(t *testing.T) {
	data := make([]byte, 200000)
	if _, err := rand.Read(data); err != nil {
		t.Fatalf("rand: %v", err)
	}
	err, dir, _ := runSendOneFile(t, hashReal, data)
	if err != nil {
		t.Fatalf("ReceiveFiles: %v", err)
	}
	onDisk, readErr := os.ReadFile(filepath.Join(dir, "payload.bin"))
	if readErr != nil {
		t.Fatalf("read received file: %v", readErr)
	}
	if len(onDisk) != len(data) {
		t.Fatalf("received %d bytes, sent %d", len(onDisk), len(data))
	}
}

// TestEmitRoute pins what the route event may carry: the engine's two verdict
// words and nothing else, so an address can never reach the audit's records
// through this event (D-083).
func TestEmitRoute(t *testing.T) {
	cases := []struct {
		name string
		path string
		err  error
		want string
	}{
		{"direct", "direct", nil, `{"event":"route","path":"direct"}`},
		{"relay", "relay", nil, `{"event":"route","path":"relay"}`},
		{"error prints nothing", "", errors.New("no candidate pair selected"), ""},
		{"a word outside the two prints nothing", "host 192.0.2.1:50000", nil, ""},
		{"empty prints nothing", "", nil, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var buf bytes.Buffer
			ev := &events{
				enc:  json.NewEncoder(&buf),
				exit: func(code int) { t.Fatalf("emitRoute exited with %d", code) },
			}
			emitRoute(ev, func() (string, error) { return c.path, c.err })
			if got := strings.TrimSpace(buf.String()); got != c.want {
				t.Fatalf("emitRoute printed %q, want %q", got, c.want)
			}
		})
	}
}

// flipFirstHexDigit is the one piece of the corrupt digest worth pinning on its
// own: it must stay 64 lowercase hex characters, or the receiver would refuse
// it as malformed instead of as a mismatch.
func TestFlipFirstHexDigit(t *testing.T) {
	for _, in := range []string{
		"0000000000000000000000000000000000000000000000000000000000000000",
		"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
	} {
		out := flipFirstHexDigit(in)
		if len(out) != len(in) || out == in {
			t.Fatalf("flipFirstHexDigit changed length or nothing: %d to %d", len(in), len(out))
		}
		if strings.ToLower(out) != out {
			t.Fatalf("flipFirstHexDigit produced upper case")
		}
		if out[1:] != in[1:] {
			t.Fatalf("flipFirstHexDigit changed more than the first digit")
		}
	}
}

func assertEmptyDir(t *testing.T, dir string) {
	t.Helper()
	names, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read output dir: %v", err)
	}
	for _, n := range names {
		t.Fatalf("output dir still holds %q after a refusal", n.Name())
	}
}
