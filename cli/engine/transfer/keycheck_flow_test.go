package transfer

// The link-key check wired into a real send and a real receive: the order of the
// frames on the wire, what ends the wait, and what a side holding the key refuses
// before any file is named. keycheck_test.go holds the primitives and
// keycheck_mitm_test.go the man in the middle.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jannskiee/floe/cli/engine/linkkey"
	"github.com/pion/webrtc/v4"
)

const (
	senderAbortFrame   = `{"type":"incompatible","reason":"sender could not confirm the receiver holds this link","pv":2,"pvMin":2,"ver":"test","code":"unverified"}`
	receiverAbortFrame = `{"type":"incompatible","reason":"receiver could not confirm the sender holds this link","pv":2,"pvMin":2,"ver":"test","code":"unverified","saved":0}`
)

func newKeyCheck(t *testing.T, enforce bool) KeyCheck {
	t.Helper()
	key, err := linkkey.New()
	if err != nil {
		t.Fatal(err)
	}
	return KeyCheck{Key: key, RoomID: testRoomID, Enforce: enforce}
}

// otherKey is the same check under a different key: what an honest proof by
// anyone who does not hold this link looks like.
func otherKey(t *testing.T, kc KeyCheck) KeyCheck {
	t.Helper()
	other := newKeyCheck(t, kc.Enforce)
	other.RoomID = kc.RoomID
	return other
}

func kcTestFile(t *testing.T, size int) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "keyed.bin")
	if err := os.WriteFile(p, bytes.Repeat([]byte{0x5a}, size), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// sendOpts is what a send on p.host passes, pumped as peer.Connection pumps it.
func (p *offererPair) sendOpts(kc *KeyCheck) SendOptions {
	return SendOptions{OnProgress: func(Progress) {}, Messages: p.hostMsgs, Closed: p.hostClosed, KeyCheck: kc}
}

// recvOpts is what a receive on p.visitor passes.
func (p *offererPair) recvOpts(kc *KeyCheck) ReceiveOptions {
	return ReceiveOptions{OnProgress: func(Progress) {}, Messages: p.visitorMsgs, Closed: p.visitorClosed, KeyCheck: kc}
}

// nextFrame is the next frame off a pump, or a failure at the bound. A frame the
// pump already holds is returned before a close.
func nextFrame(t *testing.T, msgs <-chan webrtc.DataChannelMessage, closed <-chan struct{}, what string) webrtc.DataChannelMessage {
	t.Helper()
	select {
	case m := <-msgs:
		return m
	case <-closed:
		select {
		case m := <-msgs:
			return m
		default:
		}
		t.Fatalf("%s: the channel closed with nothing queued", what)
	case <-time.After(20 * time.Second):
		t.Fatalf("%s: no frame within 20 s", what)
	}
	return webrtc.DataChannelMessage{}
}

// noFrameFor fails if a frame arrives within d, the check that nothing went out.
func noFrameFor(t *testing.T, msgs <-chan webrtc.DataChannelMessage, d time.Duration, what string) {
	t.Helper()
	select {
	case m := <-msgs:
		t.Fatalf("%s: got a frame (text %v, %d bytes)", what, m.IsString, len(m.Data))
	case <-time.After(d):
	}
}

func frameType(m webrtc.DataChannelMessage) string {
	typ, _ := classifyControl(m.Data)
	return typ
}

func metadataID(t *testing.T, m webrtc.DataChannelMessage) string {
	t.Helper()
	var meta struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	}
	if err := json.Unmarshal(m.Data, &meta); err != nil || meta.Type != "metadata" || !m.IsString {
		t.Fatalf("want a TEXT metadata frame, got text %v, %d bytes", m.IsString, len(m.Data))
	}
	return meta.ID
}

func waitErr(t *testing.T, ch <-chan error, what string) error {
	t.Helper()
	select {
	case err := <-ch:
		return err
	case <-time.After(30 * time.Second):
		t.Fatalf("%s did not return within 30 s", what)
		return nil
	}
}

func proofOf(t *testing.T, dc *webrtc.DataChannel, kc KeyCheck, fileSender bool) []byte {
	t.Helper()
	frame, err := LinkKeyProof(dc, kc, fileSender)
	if err != nil {
		t.Fatalf("LinkKeyProof: %v", err)
	}
	return frame
}

func shrinkKeyCheckWait(t *testing.T, d time.Duration) {
	t.Helper()
	orig := keyCheckWait
	keyCheckWait = d
	t.Cleanup(func() { keyCheckWait = orig })
}

// ── The sender ───────────────────────────────────────────────────────────────

// A keyed send on the fallback OnMessage path can lose a kc the receiver sent at
// its start, which would read as silence, so it is refused before anything is
// sent.
func TestKeyedSendNeedsThePump(t *testing.T) {
	p := newOffererPair(t, nil)
	kc := newKeyCheck(t, false)
	err := SendFilesWithOptions(p.host, []string{kcTestFile(t, 16)}, "test", SendOptions{OnProgress: func(Progress) {}, KeyCheck: &kc})
	if !errors.Is(err, errKeyCheckNeedsPump) {
		t.Fatalf("err = %v, want errKeyCheckNeedsPump", err)
	}
	noFrameFor(t, p.visitorMsgs, 200*time.Millisecond, "a send refused for its missing pump")
	// One half of the pump is no pump.
	if err := SendFilesWithOptions(p.host, []string{kcTestFile(t, 16)}, "test", SendOptions{Messages: p.hostMsgs, KeyCheck: &kc}); !errors.Is(err, errKeyCheckNeedsPump) {
		t.Fatalf("with Messages alone, err = %v", err)
	}
	if err := SendFilesWithOptions(p.host, []string{kcTestFile(t, 16)}, "test", SendOptions{Closed: p.hostClosed, KeyCheck: &kc}); !errors.Is(err, errKeyCheckNeedsPump) {
		t.Fatalf("with Closed alone, err = %v", err)
	}
}

// A walk that fails tells the receiver why and sends no kc at all, because nothing
// follows an abort (#828). A tree with no file in it ends the same way, silently.
func TestKeyedSendWalkFailureSendsNoProof(t *testing.T) {
	p := newOffererPair(t, nil)
	kc := newKeyCheck(t, false)
	missing := filepath.Join(t.TempDir(), "gone.bin")
	if err := SendFilesWithOptions(p.host, []string{missing}, "test", p.sendOpts(&kc)); err == nil {
		t.Fatal("a send of a missing path returned nil")
	}
	m := nextFrame(t, p.visitorMsgs, p.visitorClosed, "the walk's abort")
	if !m.IsString || frameType(m) != "incompatible" || !strings.Contains(string(m.Data), UnreadableFileReason) {
		t.Fatalf("the first frame is not the walk's abort: %s", m.Data)
	}
	noFrameFor(t, p.visitorMsgs, 200*time.Millisecond, "after the walk's abort")

	empty := t.TempDir()
	if err := SendFilesWithOptions(p.host, []string{empty}, "test", p.sendOpts(&kc)); !errors.Is(err, ErrNoFiles) {
		t.Fatalf("an empty tree: %v", err)
	}
	noFrameFor(t, p.visitorMsgs, 200*time.Millisecond, "after an empty tree")
}

// A stop that came before anything went out sends nothing, the kc included: the
// caller's own abort is the one the peer reads.
func TestKeyedSendStopBeforeAnythingSendsNothing(t *testing.T) {
	p := newOffererPair(t, nil)
	kc := newKeyCheck(t, true)
	stop := make(chan struct{})
	close(stop)
	opts := p.sendOpts(&kc)
	opts.Stop = stop
	if err := SendFilesWithOptions(p.host, []string{kcTestFile(t, 16)}, "test", opts); !errors.Is(err, ErrSendStopped) {
		t.Fatalf("err = %v, want ErrSendStopped", err)
	}
	noFrameFor(t, p.visitorMsgs, 200*time.Millisecond, "a send stopped before it began")
}

// A sender that cannot read its connection's certificates cannot compute a proof:
// it stops with the fixed error and sends nothing, and says nothing of the other
// side.
func TestKeyedSendWithoutCertificatesSendsNothing(t *testing.T) {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	unstarted, err := pc.CreateDataChannel("floe", nil)
	if err != nil {
		t.Fatal(err)
	}
	msgs, closed := pumpChannel(unstarted, nil)
	kc := newKeyCheck(t, true)
	err = SendFilesWithOptions(unstarted, []string{kcTestFile(t, 16)}, "test", SendOptions{Messages: msgs, Closed: closed, KeyCheck: &kc})
	if !errors.Is(err, ErrKeyCheckUnavailable) {
		t.Fatalf("err = %v, want ErrKeyCheckUnavailable", err)
	}
}

// detect: own kc first, as TEXT, then the metadata with no wait, and a receiver
// that shows no proof (a room code's, an old one's) gets the file as it always did.
func TestDetectSendProofLeadsAndNoProofIsFine(t *testing.T) {
	p := newOffererPair(t, nil)
	kc := newKeyCheck(t, false)
	var verified atomic.Int32
	opts := p.sendOpts(&kc)
	opts.OnKeyVerified = func() { verified.Add(1) }
	sendErr := make(chan error, 1)
	go func() { sendErr <- SendFilesWithOptions(p.host, []string{kcTestFile(t, 1024)}, "test", opts) }()

	first := nextFrame(t, p.visitorMsgs, p.visitorClosed, "the first frame")
	if !first.IsString || frameType(first) != "kc" {
		t.Fatalf("the first frame is not a TEXT kc: text %v %s", first.IsString, first.Data)
	}
	if !bytes.Equal(first.Data, proofOf(t, p.host, kc, true)) {
		t.Fatal("the first frame is not this sender's honest proof")
	}
	id := metadataID(t, nextFrame(t, p.visitorMsgs, p.visitorClosed, "the metadata"))
	if err := p.visitor.Send([]byte(`{"type":"ack","id":"` + id + `","offset":0,"pv":1,"pvMin":1}`)); err != nil {
		t.Fatal(err)
	}
	for {
		m := nextFrame(t, p.visitorMsgs, p.visitorClosed, "the file")
		if m.IsString && frameType(m) == "end" {
			break
		}
	}
	if err := waitErr(t, sendErr, "the send"); err != nil {
		t.Fatalf("send: %v", err)
	}
	if verified.Load() != 0 {
		t.Fatal("OnKeyVerified fired on a detecting send")
	}
}

// detect: a bad or malformed proof that came with the ack stops the send at that
// ack, before OnAck and before any file byte, with the bare sentinel: a key-check
// error never takes the "error sending <name>:" wrap.
func TestDetectSendBadProofStopsAtTheFirstAck(t *testing.T) {
	for name, bad := range map[string]func(t *testing.T, p *offererPair, kc KeyCheck) []byte{
		"another key": func(t *testing.T, p *offererPair, kc KeyCheck) []byte {
			return proofOf(t, p.visitor, otherKey(t, kc), false)
		},
		"a malformed tag": func(*testing.T, *offererPair, KeyCheck) []byte { return []byte(`{"type":"kc","tag":"x"}`) },
		"no tag":          func(*testing.T, *offererPair, KeyCheck) []byte { return []byte(`{"type":"kc"}`) },
		"its own proof reflected": func(t *testing.T, p *offererPair, kc KeyCheck) []byte {
			return proofOf(t, p.host, kc, true)
		},
	} {
		t.Run(name, func(t *testing.T) {
			p := newOffererPair(t, nil)
			kc := newKeyCheck(t, false)
			var acked atomic.Int32
			opts := p.sendOpts(&kc)
			opts.OnAck = func(int) { acked.Add(1) }
			sendErr := make(chan error, 1)
			go func() { sendErr <- SendFilesWithOptions(p.host, []string{kcTestFile(t, 1024)}, "test", opts) }()

			nextFrame(t, p.visitorMsgs, p.visitorClosed, "the sender's kc")
			id := metadataID(t, nextFrame(t, p.visitorMsgs, p.visitorClosed, "the metadata"))
			if err := p.visitor.Send(bad(t, p, kc)); err != nil {
				t.Fatal(err)
			}
			if err := p.visitor.Send([]byte(`{"type":"ack","id":"` + id + `","offset":0,"pv":1,"pvMin":1,"confirms":true}`)); err != nil {
				t.Fatal(err)
			}
			err := waitErr(t, sendErr, "the send")
			if err != ErrReceiverNotConfirmed {
				t.Fatalf("err = %v, want exactly ErrReceiverNotConfirmed", err)
			}
			if acked.Load() != 0 {
				t.Fatal("OnAck fired for a receiver that failed the check")
			}
			abort := nextFrame(t, p.visitorMsgs, p.visitorClosed, "the abort")
			if !abort.IsString || string(abort.Data) != senderAbortFrame {
				t.Fatalf("the abort is text %v %s, want %s", abort.IsString, abort.Data, senderAbortFrame)
			}
			noFrameFor(t, p.visitorMsgs, 200*time.Millisecond, "after the abort, no file byte and no end")
		})
	}
}

// detect: a bad proof that is already here is judged before the first metadata, so
// that side never learns a file's name at all. The open of the file is held until
// the proof is in the pump's slot.
func TestDetectSendBadProofAlreadyHereStopsBeforeTheMetadata(t *testing.T) {
	p := newOffererPair(t, nil)
	kc := newKeyCheck(t, false)
	if err := p.visitor.Send(proofOf(t, p.visitor, otherKey(t, kc), false)); err != nil {
		t.Fatal(err)
	}
	waitQueued(t, p.hostMsgs)

	origOpen := openForSend
	t.Cleanup(func() { openForSend = origOpen })
	openForSend = func(name string) (*os.File, error) {
		deadline := time.Now().Add(5 * time.Second)
		for len(p.hostMsgs) > 0 && time.Now().Before(deadline) {
			time.Sleep(time.Millisecond)
		}
		time.Sleep(50 * time.Millisecond) // the pump took it from the queue; let it land in the slot
		return origOpen(name)
	}
	err := SendFilesWithOptions(p.host, []string{kcTestFile(t, 1024)}, "test", p.sendOpts(&kc))
	if err != ErrReceiverNotConfirmed {
		t.Fatalf("err = %v, want exactly ErrReceiverNotConfirmed", err)
	}
	if m := nextFrame(t, p.visitorMsgs, p.visitorClosed, "the sender's kc"); frameType(m) != "kc" {
		t.Fatalf("the first frame is %s", m.Data)
	}
	abort := nextFrame(t, p.visitorMsgs, p.visitorClosed, "the abort")
	if string(abort.Data) != senderAbortFrame {
		t.Fatalf("the frame after the kc is %s, want the abort and no metadata", abort.Data)
	}
	noFrameFor(t, p.visitorMsgs, 200*time.Millisecond, "after the abort")
}

// detect: a good proof, and a bad second one that the pump ignores (first wins),
// and the file goes.
func TestDetectSendFirstProofWins(t *testing.T) {
	p := newOffererPair(t, nil)
	kc := newKeyCheck(t, false)
	opts := p.sendOpts(&kc)
	sendErr := make(chan error, 1)
	go func() { sendErr <- SendFilesWithOptions(p.host, []string{kcTestFile(t, 1024)}, "test", opts) }()
	nextFrame(t, p.visitorMsgs, p.visitorClosed, "the sender's kc")
	id := metadataID(t, nextFrame(t, p.visitorMsgs, p.visitorClosed, "the metadata"))
	for _, frame := range [][]byte{proofOf(t, p.visitor, kc, false), proofOf(t, p.visitor, otherKey(t, kc), false),
		[]byte(`{"type":"ack","id":"` + id + `","offset":0,"pv":1,"pvMin":1}`)} {
		if err := p.visitor.Send(frame); err != nil {
			t.Fatal(err)
		}
	}
	for {
		m := nextFrame(t, p.visitorMsgs, p.visitorClosed, "the file")
		if m.IsString && frameType(m) == "end" {
			break
		}
	}
	if err := waitErr(t, sendErr, "the send"); err != nil {
		t.Fatalf("send: %v", err)
	}
}

// enforce: nothing but the kc leaves until the receiver's proof checks out, and
// OnKeyVerified fires then, once, before the metadata.
func TestEnforceSendWaitsForTheProof(t *testing.T) {
	p := newOffererPair(t, nil)
	kc := newKeyCheck(t, true)
	verified := make(chan struct{}, 2)
	opts := p.sendOpts(&kc)
	opts.OnKeyVerified = func() { verified <- struct{}{} }
	opts.NoSummary = true
	sendErr := make(chan error, 1)
	go func() { sendErr <- SendFilesWithOptions(p.host, []string{kcTestFile(t, 1024)}, "test", opts) }()

	first := nextFrame(t, p.visitorMsgs, p.visitorClosed, "the sender's kc")
	if !first.IsString || frameType(first) != "kc" {
		t.Fatalf("the first frame is %s", first.Data)
	}
	noFrameFor(t, p.visitorMsgs, 300*time.Millisecond, "while the sender waits for the proof")
	select {
	case <-verified:
		t.Fatal("OnKeyVerified fired before any proof")
	default:
	}
	if err := p.visitor.Send(proofOf(t, p.visitor, kc, false)); err != nil {
		t.Fatal(err)
	}
	id := metadataID(t, nextFrame(t, p.visitorMsgs, p.visitorClosed, "the metadata after the proof"))
	select {
	case <-verified:
	default:
		t.Fatal("the metadata left before OnKeyVerified fired")
	}
	if err := p.visitor.Send([]byte(`{"type":"ack","id":"` + id + `","offset":0,"pv":1,"pvMin":1}`)); err != nil {
		t.Fatal(err)
	}
	for {
		m := nextFrame(t, p.visitorMsgs, p.visitorClosed, "the file")
		if m.IsString && frameType(m) == "end" {
			break
		}
	}
	if err := waitErr(t, sendErr, "the send"); err != nil {
		t.Fatalf("send: %v", err)
	}
	if len(verified) != 0 {
		t.Fatal("OnKeyVerified fired twice")
	}
}

// enforce: a wrong proof ends the send with the fixed error and the one abort, and
// no file is named.
func TestEnforceSendRefusesABadProof(t *testing.T) {
	for name, bad := range map[string]func(t *testing.T, p *offererPair, kc KeyCheck) []byte{
		"another key": func(t *testing.T, p *offererPair, kc KeyCheck) []byte {
			return proofOf(t, p.visitor, otherKey(t, kc), false)
		},
		"a malformed tag": func(*testing.T, *offererPair, KeyCheck) []byte {
			return []byte(`{"type":"kc","tag":"` + strings.Repeat("A", 42) + `B"}`)
		},
		"no tag": func(*testing.T, *offererPair, KeyCheck) []byte { return []byte(`{"type":"kc"}`) },
		"its own proof reflected": func(t *testing.T, p *offererPair, kc KeyCheck) []byte {
			return proofOf(t, p.host, kc, true)
		},
	} {
		t.Run(name, func(t *testing.T) {
			p := newOffererPair(t, nil)
			kc := newKeyCheck(t, true)
			var verified atomic.Int32
			opts := p.sendOpts(&kc)
			opts.OnKeyVerified = func() { verified.Add(1) }
			sendErr := make(chan error, 1)
			go func() { sendErr <- SendFilesWithOptions(p.host, []string{kcTestFile(t, 1024)}, "test", opts) }()
			nextFrame(t, p.visitorMsgs, p.visitorClosed, "the sender's kc")
			if err := p.visitor.Send(bad(t, p, kc)); err != nil {
				t.Fatal(err)
			}
			err := waitErr(t, sendErr, "the send")
			if err != ErrReceiverNotConfirmed {
				t.Fatalf("err = %v, want exactly ErrReceiverNotConfirmed", err)
			}
			abort := nextFrame(t, p.visitorMsgs, p.visitorClosed, "the abort")
			if !abort.IsString || string(abort.Data) != senderAbortFrame {
				t.Fatalf("the frame after the kc is text %v %s, want the abort", abort.IsString, abort.Data)
			}
			noFrameFor(t, p.visitorMsgs, 200*time.Millisecond, "after the abort")
			if verified.Load() != 0 {
				t.Fatal("OnKeyVerified fired for a bad proof")
			}
		})
	}
}

// enforce: silence ends at KeyCheckWait with the same abort and its own error.
func TestEnforceSendSilenceEndsTheWait(t *testing.T) {
	shrinkKeyCheckWait(t, 300*time.Millisecond)
	p := newOffererPair(t, nil)
	kc := newKeyCheck(t, true)
	start := time.Now()
	err := SendFilesWithOptions(p.host, []string{kcTestFile(t, 1024)}, "test", p.sendOpts(&kc))
	if err != ErrReceiverSilent {
		t.Fatalf("err = %v, want exactly ErrReceiverSilent", err)
	}
	if took := time.Since(start); took < 250*time.Millisecond {
		t.Fatalf("the wait ended after %v, before its clock", took)
	}
	nextFrame(t, p.visitorMsgs, p.visitorClosed, "the sender's kc")
	abort := nextFrame(t, p.visitorMsgs, p.visitorClosed, "the abort")
	if !abort.IsString || string(abort.Data) != senderAbortFrame {
		t.Fatalf("the frame after the kc is text %v %s, want the abort", abort.IsString, abort.Data)
	}
	noFrameFor(t, p.visitorMsgs, 200*time.Millisecond, "after the abort")
}

// A real send and a real keyless receive under an enforcing sender: released
// receivers miss the frame's range, and a keyless current one (this one) overlaps
// it and stops on the fixed sentence.
func TestEnforceSendAgainstAKeylessReceiver(t *testing.T) {
	shrinkKeyCheckWait(t, 300*time.Millisecond)
	p := newOffererPair(t, nil)
	kc := newKeyCheck(t, true)
	out := t.TempDir()
	recvErr := make(chan error, 1)
	go func() { recvErr <- ReceiveFilesWithOptions(p.visitor, out, true, "test", "", p.recvOpts(nil)) }()
	if err := SendFilesWithOptions(p.host, []string{kcTestFile(t, 1024)}, "test", p.sendOpts(&kc)); err != ErrReceiverSilent {
		t.Fatalf("send: %v, want ErrReceiverSilent", err)
	}
	if err := waitErr(t, recvErr, "the receive"); !errors.Is(err, ErrSenderNotConfirmed) {
		t.Fatalf("receive: %v, want ErrSenderNotConfirmed", err)
	}
	wantEmptyDir(t, out)
}

// enforce: a stop in the wait ends it at once and the engine says nothing: the
// caller's abort is the last frame.
func TestEnforceSendStopInTheWait(t *testing.T) {
	p := newOffererPair(t, nil)
	kc := newKeyCheck(t, true)
	stop := make(chan struct{})
	opts := p.sendOpts(&kc)
	opts.Stop = stop
	sendErr := make(chan error, 1)
	go func() { sendErr <- SendFilesWithOptions(p.host, []string{kcTestFile(t, 1024)}, "test", opts) }()
	nextFrame(t, p.visitorMsgs, p.visitorClosed, "the sender's kc")
	close(stop)
	if err := waitErr(t, sendErr, "the send"); !errors.Is(err, ErrSendStopped) {
		t.Fatalf("err = %v, want ErrSendStopped", err)
	}
	noFrameFor(t, p.visitorMsgs, 200*time.Millisecond, "after a stop")
}

// enforce: the wait reads a refusal and a close the way the ack wait does.
func TestEnforceSendRefusalAndCloseInTheWait(t *testing.T) {
	t.Run("a refusal with no proof", func(t *testing.T) {
		p := newOffererPair(t, nil)
		kc := newKeyCheck(t, true)
		var verified atomic.Int32
		opts := p.sendOpts(&kc)
		opts.OnKeyVerified = func() { verified.Add(1) }
		sendErr := make(chan error, 1)
		go func() { sendErr <- SendFilesWithOptions(p.host, []string{kcTestFile(t, 1024)}, "test", opts) }()
		nextFrame(t, p.visitorMsgs, p.visitorClosed, "the sender's kc")
		AbortWithCode(p.visitor, "test", CodeUnverified, CodeUnverified.WireReason(), 0)
		err := waitErr(t, sendErr, "the send")
		var stopped *PeerStoppedError
		if !errors.As(err, &stopped) || stopped.Code != CodeUnverified {
			t.Fatalf("err = %T %v, want a PeerStoppedError with the code", err, err)
		}
		noFrameFor(t, p.visitorMsgs, 200*time.Millisecond, "after the refusal")
		if verified.Load() != 0 {
			t.Fatal("OnKeyVerified fired with no proof")
		}
	})
	t.Run("a close with no proof", func(t *testing.T) {
		p := newOffererPair(t, nil)
		kc := newKeyCheck(t, true)
		sendErr := make(chan error, 1)
		go func() {
			sendErr <- SendFilesWithOptions(p.host, []string{kcTestFile(t, 1024)}, "test", p.sendOpts(&kc))
		}()
		nextFrame(t, p.visitorMsgs, p.visitorClosed, "the sender's kc")
		if err := p.visitor.Close(); err != nil {
			t.Fatal(err)
		}
		err := waitErr(t, sendErr, "the send")
		if err == nil || err.Error() != "connection closed while waiting for the receiver (transfer declined or receiver exited)" {
			t.Fatalf("err = %v, want the ack wait's close sentence", err)
		}
	})
}

// waitForProof over filled channels, many times, because select picks at random
// between ready arms: a queued kc is judged before a queued refusal or close, so one
// man in the middle always gets one line (design 04, K11).
func TestWaitForProofJudgesAQueuedProofFirst(t *testing.T) {
	var want, wrong [32]byte
	want[0], wrong[0] = 1, 2
	ks := &keySession{want: want}
	refusal := incompatibleFrame("", CodeUnverified, CodeUnverified.WireReason(), 0)
	stops := func() chan []byte {
		ch := make(chan []byte, 4)
		ch <- refusal
		return ch
	}
	shut := func() chan struct{} {
		ch := make(chan struct{})
		close(ch)
		return ch
	}
	parked := func(frame []byte) chan []byte {
		ch := make(chan []byte, 1)
		ch <- frame
		return ch
	}
	for i := 0; i < 300; i++ {
		// A bad proof, a refusal and a close, all queued: the bad proof.
		v, err := waitForProof(nil, ks, sendReplies{ackCh: stops(), kcCh: parked(kcFrame(wrong)), flushed: shut(), done: shut()}, nil, "", "", 1)
		if err != ErrReceiverNotConfirmed || v {
			t.Fatalf("round %d: bad proof beside a refusal and a close: %v, %v", i, v, err)
		}
		// A bad proof and a refusal, no close.
		v, err = waitForProof(nil, ks, sendReplies{ackCh: stops(), kcCh: parked(kcFrame(wrong)), flushed: make(chan struct{}), done: make(chan struct{})}, nil, "", "", 1)
		if err != ErrReceiverNotConfirmed || v {
			t.Fatalf("round %d: bad proof beside a refusal: %v, %v", i, v, err)
		}
		// A good proof and a refusal: verified, and the refusal is either the answer
		// or still queued for the ack wait that follows.
		queued := stops()
		v, err = waitForProof(nil, ks, sendReplies{ackCh: queued, kcCh: parked(kcFrame(want)), flushed: make(chan struct{}), done: make(chan struct{})}, nil, "", "", 1)
		var answered *PeerStoppedError
		if !v || (err == nil && len(queued) != 1) || (err != nil && !errors.As(err, &answered)) {
			t.Fatalf("round %d: good proof beside a refusal: %v, %v, %d queued", i, v, err, len(queued))
		}
		// No proof, a refusal and a close: the refusal.
		v, err = waitForProof(nil, ks, sendReplies{ackCh: stops(), kcCh: make(chan []byte, 1), flushed: shut(), done: shut()}, nil, "", "", 1)
		var stopped *PeerStoppedError
		if !errors.As(err, &stopped) || v {
			t.Fatalf("round %d: a refusal and a close: %v, %v", i, v, err)
		}
	}
	// A frame in the ack queue that is no refusal is dropped and the wait goes on.
	acks := make(chan []byte, 4)
	acks <- []byte(`{"type":"ack","id":"x","offset":0}`)
	acks <- bytes.Repeat([]byte("x"), controlMsgMax+1)
	kcs := make(chan []byte, 1)
	go func() {
		time.Sleep(50 * time.Millisecond)
		kcs <- kcFrame(want)
	}()
	if v, err := waitForProof(nil, ks, sendReplies{ackCh: acks, kcCh: kcs, flushed: make(chan struct{}), done: make(chan struct{})}, nil, "", "", 1); !v || err != nil {
		t.Fatalf("a stray ack before the proof: %v, %v", v, err)
	}
}

// A Stop that has closed stays silent, whatever the check finds: the caller's own
// abort is the last frame on the channel, and nothing follows an abort.
func TestKeyCheckEndingsStaySilentAfterAStop(t *testing.T) {
	var want, wrong [32]byte
	want[0], wrong[0] = 1, 2
	ks := &keySession{want: want}
	stop := make(chan struct{})
	close(stop)

	p := newOffererPair(t, nil)
	kcs := make(chan []byte, 1)
	// The stop's arm and the proof's are both ready, so select picks: either ending
	// is right, and the proof's must still say nothing.
	judged := false
	for i := 0; i < 200; i++ {
		kcs = make(chan []byte, 1)
		kcs <- kcFrame(wrong)
		v, err := waitForProof(p.host, ks, sendReplies{ackCh: make(chan []byte, 4), kcCh: kcs, flushed: make(chan struct{}), done: make(chan struct{})}, stop, "test", "", 1)
		if v || (err != ErrReceiverNotConfirmed && err != ErrSendStopped) {
			t.Fatalf("the wait: %v, %v", v, err)
		}
		judged = judged || err == ErrReceiverNotConfirmed
	}
	if !judged {
		t.Fatal("select never picked the proof, so this checked nothing")
	}
	kcs = make(chan []byte, 1)
	kcs <- kcFrame(wrong)
	if err := detectProof(p.host, ks, kcs, stop, "test"); err != ErrReceiverNotConfirmed {
		t.Fatalf("detect: %v", err)
	}
	noFrameFor(t, p.visitorMsgs, 200*time.Millisecond, "a check that ended after a stop")

	// With no stop, each ends on the one frame.
	for name, run := range map[string]func() error{
		"the wait": func() error {
			kcs <- kcFrame(wrong)
			_, err := waitForProof(p.host, ks, sendReplies{ackCh: make(chan []byte, 4), kcCh: kcs, flushed: make(chan struct{}), done: make(chan struct{})}, nil, "test", "", 1)
			return err
		},
		"detect": func() error {
			kcs <- kcFrame(wrong)
			return detectProof(p.host, ks, kcs, nil, "test")
		},
	} {
		if err := run(); err != ErrReceiverNotConfirmed {
			t.Fatalf("%s: %v", name, err)
		}
		if m := nextFrame(t, p.visitorMsgs, p.visitorClosed, name); string(m.Data) != senderAbortFrame {
			t.Fatalf("%s: the frame is %s", name, m.Data)
		}
	}
}

// The clock's last look: a proof parked as the clock runs out is still judged. A wait
// of zero has its clock ready from the first select on, on every platform, so select
// picks that arm about half the time here.
func TestWaitForProofLooksOnceMoreAtTheDeadline(t *testing.T) {
	shrinkKeyCheckWait(t, 0)
	var want [32]byte
	want[0] = 1
	ks := &keySession{want: want}
	for i := 0; i < 100; i++ {
		kcs := make(chan []byte, 1)
		kcs <- kcFrame(want)
		if v, err := waitForProof(nil, ks, sendReplies{ackCh: make(chan []byte, 4), kcCh: kcs, flushed: make(chan struct{}), done: make(chan struct{})}, nil, "", "", 1); !v || err != nil {
			t.Fatalf("round %d: %v, %v", i, v, err)
		}
	}
}

// The pump parks the first kc and forwards everything else; a later kc goes
// nowhere, so it can neither crowd the ack queue nor overwrite the first.
func TestRepliesPumpRoutesTheFirstProof(t *testing.T) {
	msgs := make(chan webrtc.DataChannelMessage, 16)
	closed := make(chan struct{})
	var a, b [32]byte
	a[0], b[0] = 1, 2
	ack := []byte(`{"type":"ack","id":"x","offset":0}`)
	msgs <- webrtc.DataChannelMessage{Data: kcFrame(a)}
	msgs <- webrtc.DataChannelMessage{Data: ack}
	for i := 0; i < 8; i++ {
		msgs <- webrtc.DataChannelMessage{Data: kcFrame(b)}
	}
	refusal := incompatibleFrame("", CodeStopped, CodeStopped.WireReason(), 0)
	msgs <- webrtc.DataChannelMessage{Data: refusal}
	r := wireReplies(nil, SendOptions{Messages: msgs, Closed: closed}, true)
	close(closed)
	waitFlushed(r.flushed)
	select {
	case got := <-r.kcCh:
		if !bytes.Equal(got, kcFrame(a)) {
			t.Fatalf("the slot holds %s, want the first kc", got)
		}
	default:
		t.Fatal("the first kc is not in its slot")
	}
	if len(r.kcCh) != 0 {
		t.Fatal("a second kc reached the slot")
	}
	if len(r.ackCh) != 2 {
		t.Fatalf("the ack queue holds %d frames, want the ack and the refusal, with no kc", len(r.ackCh))
	}
	if got := <-r.ackCh; !bytes.Equal(got, ack) {
		t.Fatalf("the first queued frame is %s", got)
	}
	if got := <-r.ackCh; !bytes.Equal(got, refusal) {
		t.Fatalf("the second queued frame is %s", got)
	}

	// Keyless, there is no slot, and a kc is one more stray frame.
	msgs = make(chan webrtc.DataChannelMessage, 4)
	closed = make(chan struct{})
	msgs <- webrtc.DataChannelMessage{Data: kcFrame(a)}
	r = wireReplies(nil, SendOptions{Messages: msgs, Closed: closed}, false)
	close(closed)
	waitFlushed(r.flushed)
	if r.kcCh != nil {
		t.Fatal("a keyless send has a kc slot")
	}
	if len(r.ackCh) != 1 {
		t.Fatalf("the ack queue holds %d frames, want the stray kc", len(r.ackCh))
	}
}

// DV5: the relay gate runs after the kc and after the enforce wait, so a relay-cap
// abort, which carries the size, never reaches a receiver that has not shown its
// proof. A detecting send has no wait, so its abort still follows the kc.
func TestKeyedSendRelayGateFollowsTheCheck(t *testing.T) {
	orig := pathTypeFn
	t.Cleanup(func() { pathTypeFn = orig })
	pathTypeFn = func(*webrtc.DataChannel) (string, error) { return "relay", nil }
	big := filepath.Join(t.TempDir(), "big.bin")
	f, err := os.Create(big)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(RelaySizeLimit + 1); err != nil {
		t.Fatal(err)
	}
	f.Close()

	t.Run("enforce, bad proof: no relay abort", func(t *testing.T) {
		p := newOffererPair(t, nil)
		kc := newKeyCheck(t, true)
		sendErr := make(chan error, 1)
		go func() { sendErr <- SendFilesWithOptions(p.host, []string{big}, "test", p.sendOpts(&kc)) }()
		nextFrame(t, p.visitorMsgs, p.visitorClosed, "the sender's kc")
		if err := p.visitor.Send(proofOf(t, p.visitor, otherKey(t, kc), false)); err != nil {
			t.Fatal(err)
		}
		if err := waitErr(t, sendErr, "the send"); err != ErrReceiverNotConfirmed {
			t.Fatalf("err = %v", err)
		}
		abort := nextFrame(t, p.visitorMsgs, p.visitorClosed, "the abort")
		if string(abort.Data) != senderAbortFrame {
			t.Fatalf("the abort is %s", abort.Data)
		}
		noFrameFor(t, p.visitorMsgs, 200*time.Millisecond, "after the abort")
	})
	t.Run("enforce, silence: no relay abort", func(t *testing.T) {
		shrinkKeyCheckWait(t, 200*time.Millisecond)
		p := newOffererPair(t, nil)
		kc := newKeyCheck(t, true)
		if err := SendFilesWithOptions(p.host, []string{big}, "test", p.sendOpts(&kc)); err != ErrReceiverSilent {
			t.Fatalf("err = %v", err)
		}
		nextFrame(t, p.visitorMsgs, p.visitorClosed, "the sender's kc")
		if abort := nextFrame(t, p.visitorMsgs, p.visitorClosed, "the abort"); string(abort.Data) != senderAbortFrame {
			t.Fatalf("the abort is %s", abort.Data)
		}
	})
	t.Run("enforce, good proof: the relay abort follows", func(t *testing.T) {
		p := newOffererPair(t, nil)
		kc := newKeyCheck(t, true)
		var verified atomic.Int32
		opts := p.sendOpts(&kc)
		opts.OnKeyVerified = func() { verified.Add(1) }
		sendErr := make(chan error, 1)
		go func() { sendErr <- SendFilesWithOptions(p.host, []string{big}, "test", opts) }()
		nextFrame(t, p.visitorMsgs, p.visitorClosed, "the sender's kc")
		noFrameFor(t, p.visitorMsgs, 200*time.Millisecond, "while the sender waits for the proof")
		if err := p.visitor.Send(proofOf(t, p.visitor, kc, false)); err != nil {
			t.Fatal(err)
		}
		if err := waitErr(t, sendErr, "the send"); !errors.Is(err, ErrRelayOverLimit) {
			t.Fatalf("err = %v", err)
		}
		if verified.Load() != 1 {
			t.Fatalf("OnKeyVerified fired %d times, want once before the gate", verified.Load())
		}
		abort := nextFrame(t, p.visitorMsgs, p.visitorClosed, "the relay abort")
		if !strings.Contains(string(abort.Data), "relay connections are capped") {
			t.Fatalf("the abort is %s", abort.Data)
		}
	})
	t.Run("detect: the kc, then the relay abort", func(t *testing.T) {
		p := newOffererPair(t, nil)
		kc := newKeyCheck(t, false)
		if err := SendFilesWithOptions(p.host, []string{big}, "test", p.sendOpts(&kc)); !errors.Is(err, ErrRelayOverLimit) {
			t.Fatalf("err = %v", err)
		}
		if m := nextFrame(t, p.visitorMsgs, p.visitorClosed, "the sender's kc"); frameType(m) != "kc" {
			t.Fatalf("the first frame is %s", m.Data)
		}
		abort := nextFrame(t, p.visitorMsgs, p.visitorClosed, "the relay abort")
		if !strings.Contains(string(abort.Data), "relay connections are capped") {
			t.Fatalf("the abort is %s", abort.Data)
		}
	})
}

// A stop that lands right after the proof checked out is the caller's to tell, so the
// relay gate's abort, which carries the size, stays home.
func TestEnforceSendStopAfterTheProofKeepsTheRelayAbortHome(t *testing.T) {
	orig := pathTypeFn
	t.Cleanup(func() { pathTypeFn = orig })
	pathTypeFn = func(*webrtc.DataChannel) (string, error) { return "relay", nil }
	big := filepath.Join(t.TempDir(), "big.bin")
	f, err := os.Create(big)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(RelaySizeLimit + 1); err != nil {
		t.Fatal(err)
	}
	f.Close()

	p := newOffererPair(t, nil)
	kc := newKeyCheck(t, true)
	stop := make(chan struct{})
	opts := p.sendOpts(&kc)
	opts.Stop = stop
	opts.OnKeyVerified = func() { close(stop) }
	sendErr := make(chan error, 1)
	go func() { sendErr <- SendFilesWithOptions(p.host, []string{big}, "test", opts) }()
	nextFrame(t, p.visitorMsgs, p.visitorClosed, "the sender's kc")
	if err := p.visitor.Send(proofOf(t, p.visitor, kc, false)); err != nil {
		t.Fatal(err)
	}
	if err := waitErr(t, sendErr, "the send"); !errors.Is(err, ErrSendStopped) {
		t.Fatalf("err = %v, want ErrSendStopped", err)
	}
	noFrameFor(t, p.visitorMsgs, 200*time.Millisecond, "after a stop")
}

// A bad proof queued when the kc itself cannot go out: the channel has closed, and
// the outcome is still the one line.
func TestKeyedSendOnAClosedChannelStillJudgesTheProof(t *testing.T) {
	p := newOffererPair(t, nil)
	kc := newKeyCheck(t, true)
	if err := p.visitor.Send(proofOf(t, p.visitor, otherKey(t, kc), false)); err != nil {
		t.Fatal(err)
	}
	AbortWithCode(p.visitor, "test", CodeStopped, CodeStopped.WireReason(), 0)
	if err := p.visitor.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.hostClosed:
	case <-time.After(20 * time.Second):
		t.Fatal("the close never reached the sender")
	}
	deadline := time.Now().Add(5 * time.Second)
	for p.host.ReadyState() != webrtc.DataChannelStateClosed && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if err := waitErrOf(t, func() error {
		return SendFilesWithOptions(p.host, []string{kcTestFile(t, 16)}, "test", p.sendOpts(&kc))
	}); err != ErrReceiverNotConfirmed {
		t.Fatalf("err = %v, want exactly ErrReceiverNotConfirmed", err)
	}
}

func waitErrOf(t *testing.T, f func() error) error {
	t.Helper()
	ch := make(chan error, 1)
	go func() { ch <- f() }()
	return waitErr(t, ch, "the call")
}

// A real keyed transfer in both shapes of connection, each with both senders:
// the offerer sends (a share link), and the answerer sends (a request link). The
// file arrives whole, on the receiver's check and, enforcing, on the sender's.
func TestKeyedTransferDelivers(t *testing.T) {
	for _, enforce := range []bool{false, true} {
		for _, visitorSends := range []bool{false, true} {
			t.Run(fmt.Sprintf("enforce=%v visitorSends=%v", enforce, visitorSends), func(t *testing.T) {
				p := newOffererPair(t, nil)
				kc := newKeyCheck(t, enforce)
				src := kcTestFile(t, 96*1024)
				out := t.TempDir()
				var verified atomic.Int32
				send := SendOptions{OnProgress: func(Progress) {}, KeyCheck: &kc, OnKeyVerified: func() { verified.Add(1) }}
				recv := ReceiveOptions{OnProgress: func(Progress) {}, KeyCheck: &kc}
				sdc, rdc := p.host, p.visitor
				send.Messages, send.Closed = p.hostMsgs, p.hostClosed
				recv.Messages, recv.Closed = p.visitorMsgs, p.visitorClosed
				if visitorSends {
					sdc, rdc = p.visitor, p.host
					send.Messages, send.Closed = p.visitorMsgs, p.visitorClosed
					recv.Messages, recv.Closed = p.hostMsgs, p.hostClosed
				}
				sendErr, recvErr := make(chan error, 1), make(chan error, 1)
				go func() {
					err := SendFilesWithOptions(sdc, []string{src}, "test", send)
					_ = sdc.Close()
					sendErr <- err
				}()
				go func() { recvErr <- ReceiveFilesWithOptions(rdc, out, true, "test", "", recv) }()
				if err := waitErr(t, recvErr, "the receive"); err != nil {
					t.Fatalf("receive: %v", err)
				}
				if err := waitErr(t, sendErr, "the send"); err != nil {
					t.Fatalf("send: %v", err)
				}
				got, err := os.ReadFile(filepath.Join(out, filepath.Base(src)))
				if err != nil {
					t.Fatal(err)
				}
				if len(got) != 96*1024 {
					t.Fatalf("saved %d bytes", len(got))
				}
				wantVerified := int32(0)
				if enforce {
					wantVerified = 1
				}
				if verified.Load() != wantVerified {
					t.Fatalf("OnKeyVerified fired %d times, want %d", verified.Load(), wantVerified)
				}
			})
		}
	}
}

// ── The receiver ─────────────────────────────────────────────────────────────

func wantEmptyDir(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("the output folder holds %v, want nothing", names)
	}
}

// A keyed receiver's first frame is its own proof, BINARY, before anything else.
func TestKeyedReceiveProofLeadsAsBinary(t *testing.T) {
	p := newOffererPair(t, nil)
	kc := newKeyCheck(t, false)
	out := t.TempDir()
	recvErr := make(chan error, 1)
	go func() { recvErr <- ReceiveFilesWithOptions(p.visitor, out, true, "test", "", p.recvOpts(&kc)) }()
	first := nextFrame(t, p.hostMsgs, p.hostClosed, "the receiver's kc")
	if first.IsString {
		t.Fatal("the receiver's kc came as TEXT")
	}
	if !bytes.Equal(first.Data, proofOf(t, p.visitor, kc, false)) {
		t.Fatalf("the first frame is not the receiver's honest proof: %s", first.Data)
	}
	if err := p.host.Close(); err != nil {
		t.Fatal(err)
	}
	if err := waitErr(t, recvErr, "the receive"); err == nil {
		t.Fatal("a receive whose sender left said nil")
	}
	wantEmptyDir(t, out)
}

// A receiver without the key sends nothing new: its first frame is the ack.
func TestKeylessReceiveSendsNoProof(t *testing.T) {
	p := newOffererPair(t, nil)
	out := t.TempDir()
	recvErr := make(chan error, 1)
	go func() { recvErr <- ReceiveFilesWithOptions(p.visitor, out, true, "test", "", p.recvOpts(nil)) }()
	noFrameFor(t, p.hostMsgs, 200*time.Millisecond, "a keyless receive before any metadata")
	meta := metadataJSON(metadataMsg{Type: "metadata", ID: "file-1", FileName: "a.bin", FileSize: 0, Index: 1, Total: 1, Pv: ProtocolVersion, PvMin: MinProtocolVersion})
	if err := p.host.SendText(string(meta)); err != nil {
		t.Fatal(err)
	}
	if first := nextFrame(t, p.hostMsgs, p.hostClosed, "the ack"); frameType(first) != "ack" {
		t.Fatalf("the first frame of a keyless receive is %s", first.Data)
	}
	if err := p.host.Close(); err != nil {
		t.Fatal(err)
	}
	waitErr(t, recvErr, "the receive")
}

// Every way of not showing the proof, from a hostile or a keyless sender: the one
// refusal, BINARY, pv 2 and saved 0, before any callback, prompt or ack and with
// nothing on disk. The error is typed and fixed.
func TestKeyedReceiveRefusesWithoutAProof(t *testing.T) {
	meta := func(name string) string {
		return string(metadataJSON(metadataMsg{Type: "metadata", ID: "file-1", FileName: name, FileSize: 64, Index: 1, Total: 1, TotalBytes: 64, Pv: ProtocolVersion, PvMin: MinProtocolVersion}))
	}
	type script func(t *testing.T, p *offererPair, kc KeyCheck)
	text := func(frame string) script {
		return func(t *testing.T, p *offererPair, _ KeyCheck) {
			if err := p.host.SendText(frame); err != nil {
				t.Fatal(err)
			}
		}
	}
	cases := map[string]script{
		"metadata first":     text(meta("secret.bin")),
		"an over-cap string": text(strings.Repeat("x", controlMsgMax+1)),
		"an over-cap metadata": text(string(metadataJSON(metadataMsg{Type: "metadata", ID: "file-1", FileName: strings.Repeat("n", controlMsgMax),
			FileSize: 64, Index: 1, Total: 1, TotalBytes: 64}))),
		"a binary frame first": func(t *testing.T, p *offererPair, _ KeyCheck) {
			if err := p.host.Send([]byte("file bytes before any metadata")); err != nil {
				t.Fatal(err)
			}
		},
		"a kc with no tag":                 text(`{"type":"kc"}`),
		"a kc with a short tag":            text(`{"type":"kc","tag":"AAAA"}`),
		"a kc whose tag is not a string":   text(`{"type":"kc","tag":42}`),
		"a kc with a loose last character": text(`{"type":"kc","tag":"` + strings.Repeat("A", 42) + `B"}`),
		"a proof under another key": func(t *testing.T, p *offererPair, kc KeyCheck) {
			if err := p.host.SendText(string(proofOf(t, p.host, otherKey(t, kc), true))); err != nil {
				t.Fatal(err)
			}
		},
		"its own proof reflected": func(t *testing.T, p *offererPair, kc KeyCheck) {
			if err := p.host.SendText(string(proofOf(t, p.visitor, kc, false))); err != nil {
				t.Fatal(err)
			}
		},
		"a proof for another room": func(t *testing.T, p *offererPair, kc KeyCheck) {
			kc.RoomID = strings.ToUpper(kc.RoomID)
			if err := p.host.SendText(string(proofOf(t, p.host, kc, true))); err != nil {
				t.Fatal(err)
			}
		},
		"a receiver's proof role, from the sender": func(t *testing.T, p *offererPair, kc KeyCheck) {
			if err := p.host.SendText(string(proofOf(t, p.host, kc, false))); err != nil {
				t.Fatal(err)
			}
		},
		"an honest proof as BINARY": func(t *testing.T, p *offererPair, kc KeyCheck) {
			if err := p.host.Send(proofOf(t, p.host, kc, true)); err != nil {
				t.Fatal(err)
			}
		},
		"an end, then metadata": func(t *testing.T, p *offererPair, _ KeyCheck) {
			if err := p.host.SendText(`{"type":"end"}`); err != nil {
				t.Fatal(err)
			}
			if err := p.host.SendText(meta("secret.bin")); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, run := range cases {
		t.Run(name, func(t *testing.T) {
			p := newOffererPair(t, nil)
			kc := newKeyCheck(t, false)
			out := t.TempDir()
			var incoming, decided, done atomic.Int32
			opts := p.recvOpts(&kc)
			opts.OnIncoming = func(IncomingInfo) { incoming.Add(1) }
			opts.Decide = func(IncomingInfo) Decision { decided.Add(1); return Decision{Kind: DecisionAccept} }
			opts.OnFileDone = func(FileDone) { done.Add(1) }
			recvErr := make(chan error, 1)
			go func() { recvErr <- ReceiveFilesWithOptions(p.visitor, out, false, "test", "", opts) }()
			if first := nextFrame(t, p.hostMsgs, p.hostClosed, "the receiver's kc"); frameType(webrtc.DataChannelMessage{Data: first.Data}) != "kc" {
				t.Fatalf("the receiver's first frame is %s", first.Data)
			}
			run(t, p, kc)
			err := waitErr(t, recvErr, "the receive")
			if !errors.Is(err, ErrSenderNotConfirmed) {
				t.Fatalf("err = %v, want ErrSenderNotConfirmed", err)
			}
			var refused *RefusedError
			if !errors.As(err, &refused) || refused.Code != CodeUnverified || refused.Saved != 0 {
				t.Fatalf("err = %T %+v, want a RefusedError with the code and saved 0", err, err)
			}
			if err.Error() != ErrSenderNotConfirmed.Error() {
				t.Fatalf("the sentence is %q", err)
			}
			abort := nextFrame(t, p.hostMsgs, p.hostClosed, "the refusal")
			if abort.IsString || string(abort.Data) != receiverAbortFrame {
				t.Fatalf("the refusal is text %v %s, want BINARY %s", abort.IsString, abort.Data, receiverAbortFrame)
			}
			noFrameFor(t, p.hostMsgs, 100*time.Millisecond, "after the refusal, no ack")
			if incoming.Load()+decided.Load()+done.Load() != 0 {
				t.Fatalf("a callback ran before the proof: OnIncoming %d, Decide %d, OnFileDone %d", incoming.Load(), decided.Load(), done.Load())
			}
			wantEmptyDir(t, out)
		})
	}
}

// The good proof opens the gate. Unknown strings before it are still skipped, and
// a second kc, good or bad, is ignored (first wins).
func TestKeyedReceiveAcceptsAProofThenTheFile(t *testing.T) {
	p := newOffererPair(t, nil)
	kc := newKeyCheck(t, false)
	out := t.TempDir()
	var decided atomic.Int32
	opts := p.recvOpts(&kc)
	opts.Decide = func(IncomingInfo) Decision { decided.Add(1); return Decision{Kind: DecisionAccept} }
	recvErr := make(chan error, 1)
	go func() { recvErr <- ReceiveFilesWithOptions(p.visitor, out, false, "test", "", opts) }()
	nextFrame(t, p.hostMsgs, p.hostClosed, "the receiver's kc")

	payload := bytes.Repeat([]byte{0x7e}, 64)
	for _, frame := range []string{
		`{"type":"hello"}`,
		`not json at all`,
		string(proofOf(t, p.host, kc, true)),
		string(proofOf(t, p.host, otherKey(t, kc), true)),
		`{"type":"kc"}`,
	} {
		if err := p.host.SendText(frame); err != nil {
			t.Fatal(err)
		}
	}
	meta := metadataJSON(metadataMsg{Type: "metadata", ID: "file-1", FileName: "a.bin", FileSize: 64, Index: 1, Total: 1, TotalBytes: 64, Pv: ProtocolVersion, PvMin: MinProtocolVersion})
	if err := p.host.SendText(string(meta)); err != nil {
		t.Fatal(err)
	}
	if ack := nextFrame(t, p.hostMsgs, p.hostClosed, "the ack"); frameType(ack) != "ack" {
		t.Fatalf("the frame after the kc is %s, want the ack", ack.Data)
	}
	if err := p.host.Send(payload); err != nil {
		t.Fatal(err)
	}
	if err := p.host.SendText(`{"type":"end"}`); err != nil {
		t.Fatal(err)
	}
	if got := nextFrame(t, p.hostMsgs, p.hostClosed, "received"); !strings.Contains(string(got.Data), `"received"`) {
		t.Fatalf("the frame after the end is %s", got.Data)
	}
	if err := p.host.Close(); err != nil {
		t.Fatal(err)
	}
	if err := waitErr(t, recvErr, "the receive"); err != nil {
		t.Fatalf("receive: %v", err)
	}
	if decided.Load() != 1 {
		t.Fatalf("Decide ran %d times", decided.Load())
	}
	if got, err := os.ReadFile(filepath.Join(out, "a.bin")); err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("saved %q, %v", got, err)
	}
}

// A sender's stop with code unverified is the fixed sentence on a receiver with or
// without the key, never the sender's words. A keyless browser receiver shows the
// sender's cleaned words instead; that difference is recorded in DV1's notes.
func TestReceiveReadsASendersUnverifiedStop(t *testing.T) {
	frame := string(incompatibleFrame("v9", CodeUnverified, "HOSTILE WORDS", -1))
	for name, keyed := range map[string]bool{"keyed": true, "keyless": false} {
		t.Run(name, func(t *testing.T) {
			p := newOffererPair(t, nil)
			kc := newKeyCheck(t, false)
			opts := p.recvOpts(nil)
			if keyed {
				opts.KeyCheck = &kc
			}
			recvErr := make(chan error, 1)
			go func() { recvErr <- ReceiveFilesWithOptions(p.visitor, t.TempDir(), true, "test", "", opts) }()
			if err := p.host.SendText(frame); err != nil {
				t.Fatal(err)
			}
			err := waitErr(t, recvErr, "the receive")
			if !errors.Is(err, ErrSenderNotConfirmed) {
				t.Fatalf("err = %T %v, want ErrSenderNotConfirmed", err, err)
			}
			if err.Error() != ErrSenderNotConfirmed.Error() || strings.Contains(err.Error(), "HOSTILE") {
				t.Fatalf("the sentence is %q", err)
			}
			var refused *RefusedError
			if errors.As(err, &refused) {
				t.Fatal("a sender's stop reads as this side's refusal")
			}
		})
	}
	// Exact key, as every other reader of a code: {"CODE":...} is no code.
	t.Run("a code in another case is not the code", func(t *testing.T) {
		p := newOffererPair(t, nil)
		recvErr := make(chan error, 1)
		go func() { recvErr <- ReceiveFilesWithOptions(p.visitor, t.TempDir(), true, "test", "", p.recvOpts(nil)) }()
		if err := p.host.SendText(`{"type":"incompatible","reason":"their words","pv":2,"pvMin":2,"CODE":"unverified"}`); err != nil {
			t.Fatal(err)
		}
		err := waitErr(t, recvErr, "the receive")
		if errors.Is(err, ErrSenderNotConfirmed) {
			t.Fatalf("err = %v, want today's reading of the frame", err)
		}
	})
}

// "Nothing was saved" must stay true: once a file is committed, a stop with this
// code reads as any other stop, in the frame's cleaned words as today.
func TestReceiveKeepsItsWordsAfterACommittedFile(t *testing.T) {
	p := newOffererPair(t, nil)
	out := t.TempDir()
	recvErr := make(chan error, 1)
	go func() { recvErr <- ReceiveFilesWithOptions(p.visitor, out, true, "test", "", p.recvOpts(nil)) }()
	meta := metadataJSON(metadataMsg{Type: "metadata", ID: "file-1", FileName: "a.bin", FileSize: 4, Index: 1, Total: 2, TotalBytes: 8, Pv: ProtocolVersion, PvMin: MinProtocolVersion})
	if err := p.host.SendText(string(meta)); err != nil {
		t.Fatal(err)
	}
	if ack := nextFrame(t, p.hostMsgs, p.hostClosed, "the ack"); frameType(ack) != "ack" {
		t.Fatalf("got %s", ack.Data)
	}
	if err := p.host.Send([]byte("abcd")); err != nil {
		t.Fatal(err)
	}
	if err := p.host.SendText(`{"type":"end"}`); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(out, "a.bin")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the first file never committed")
		}
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond) // the commit is done; let the loop count it
	if err := p.host.SendText(string(incompatibleFrame("v9", CodeUnverified, "stopped mid drop", -1))); err != nil {
		t.Fatal(err)
	}
	err := waitErr(t, recvErr, "the receive")
	if err == nil || errors.Is(err, ErrSenderNotConfirmed) {
		t.Fatalf("err = %v, want today's reading of the frame", err)
	}
}

// A receiver that cannot read its own certificates says so in its own words and
// never blames the sender: the bare error, not the RefusedError whose sentence
// names the sender (D7).
func TestKeyedReceiveWithoutCertificatesIsItsOwnFault(t *testing.T) {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	unstarted, err := pc.CreateDataChannel("floe", nil)
	if err != nil {
		t.Fatal(err)
	}
	msgs, closed := pumpChannel(unstarted, nil)
	kc := newKeyCheck(t, false)
	err = ReceiveFilesWithOptions(unstarted, t.TempDir(), true, "test", "", ReceiveOptions{Messages: msgs, Closed: closed, KeyCheck: &kc})
	if err != ErrKeyCheckUnavailable {
		t.Fatalf("err = %T %v, want exactly ErrKeyCheckUnavailable", err, err)
	}
	var refused *RefusedError
	if errors.As(err, &refused) || errors.Is(err, ErrSenderNotConfirmed) {
		t.Fatalf("err = %v blames the sender", err)
	}
}

// The kc arm leaves the idle clock alone: a proof with nothing after it still ends
// on the watchdog, not on a wait with no end.
func TestKeyedReceiveProofDoesNotStopTheIdleClock(t *testing.T) {
	orig := receiveIdleTimeout
	receiveIdleTimeout = 300 * time.Millisecond
	t.Cleanup(func() { receiveIdleTimeout = orig })
	p := newOffererPair(t, nil)
	kc := newKeyCheck(t, false)
	recvErr := make(chan error, 1)
	go func() { recvErr <- ReceiveFilesWithOptions(p.visitor, t.TempDir(), true, "test", "", p.recvOpts(&kc)) }()
	nextFrame(t, p.hostMsgs, p.hostClosed, "the receiver's kc")
	if err := p.host.SendText(string(proofOf(t, p.host, kc, true))); err != nil {
		t.Fatal(err)
	}
	err := waitErr(t, recvErr, "the receive")
	if err == nil || !strings.Contains(err.Error(), "no data arrived from the sender") {
		t.Fatalf("err = %v, want the idle watchdog", err)
	}
}

// Neither side prints the key, its tag or the room's proof anywhere a person or a
// log could read it, on success or on a refusal.
func TestKeyedTransferPrintsNoKey(t *testing.T) {
	restore := captureStdout(t)
	p := newOffererPair(t, nil)
	kc := newKeyCheck(t, true)
	src := kcTestFile(t, 2048)
	out := t.TempDir()
	sendErr, recvErr := make(chan error, 1), make(chan error, 1)
	sendTag := string(proofOf(t, p.host, kc, true))
	recvTag := string(proofOf(t, p.visitor, kc, false))
	go func() {
		err := SendFilesWithOptions(p.host, []string{src}, "test", SendOptions{Messages: p.hostMsgs, Closed: p.hostClosed, KeyCheck: &kc})
		_ = p.host.Close()
		sendErr <- err
	}()
	go func() {
		recvErr <- ReceiveFilesWithOptions(p.visitor, out, true, "test", "", ReceiveOptions{Messages: p.visitorMsgs, Closed: p.visitorClosed, KeyCheck: &kc})
	}()
	sErr := waitErr(t, sendErr, "the send")
	rErr := waitErr(t, recvErr, "the receive")
	printed := restore()
	if sErr != nil || rErr != nil {
		t.Fatalf("send: %v, receive: %v", sErr, rErr)
	}
	tagOf := func(frame string) string {
		var f struct {
			Tag string `json:"tag"`
		}
		if err := json.Unmarshal([]byte(frame), &f); err != nil || f.Tag == "" {
			t.Fatalf("no tag in %q", frame)
		}
		return f.Tag
	}
	for name, secret := range map[string]string{"the key": kc.Key.Encode(), "the sender's tag": tagOf(sendTag), "the receiver's tag": tagOf(recvTag)} {
		if strings.Contains(printed, secret) {
			t.Fatalf("%s was printed:\n%s", name, printed)
		}
	}
	if fmt.Sprintf("%v %+v %#v", kc, kc, kc) == "" || strings.Contains(fmt.Sprintf("%v %+v %#v", kc, kc, kc), kc.Key.Encode()) {
		t.Fatal("a printed KeyCheck holds the key")
	}
	for _, err := range []error{ErrReceiverNotConfirmed, ErrReceiverSilent, ErrSenderNotConfirmed, ErrKeyCheckUnavailable, errKeyCheckNeedsPump} {
		if strings.Contains(err.Error(), kc.Key.Encode()) {
			t.Fatalf("%q holds the key", err)
		}
	}
}

// A stop from a receiver that has proved nothing keeps its code's fixed sentence and
// loses its count, and a frame's own words do not come through at all (review 19, L3).
// A receiver that has proved the key keeps its count. Over filled channels, many times,
// because select picks at random between ready arms.
func TestWaitForProofGivesAnUnprovenStopNoCountAndNoWords(t *testing.T) {
	var want [32]byte
	want[0] = 1
	ks := &keySession{want: want}
	queued := func(frames ...[]byte) chan []byte {
		ch := make(chan []byte, 4)
		for _, f := range frames {
			ch <- f
		}
		return ch
	}
	shut := func() chan struct{} {
		ch := make(chan struct{})
		close(ch)
		return ch
	}
	const total = 3
	words := []byte(`{"type":"incompatible","pv":2,"pvMin":1,"saved":2,"reason":"HOSTILE WORDS"}`)
	coded := incompatibleFrame("", CodeStopped, CodeStopped.WireReason(), 2)
	unverified := []byte(`{"type":"incompatible","pv":2,"pvMin":2,"code":"unverified","saved":2}`)
	for i := 0; i < 100; i++ {
		for name, frame := range map[string][]byte{"stopped": coded, "unverified": unverified} {
			// In the wait, and at a close.
			for _, closed := range []bool{false, true} {
				done, flushed := make(chan struct{}), make(chan struct{})
				if closed {
					done, flushed = shut(), shut()
				}
				v, err := waitForProof(nil, ks, sendReplies{ackCh: queued(frame), kcCh: make(chan []byte, 1), flushed: flushed, done: done}, nil, "", "", total)
				var stopped *PeerStoppedError
				if v || !errors.As(err, &stopped) || stopped.Saved != 0 {
					t.Fatalf("%s, closed %v: verified %v, err %T %+v, want a PeerStoppedError with no count", name, closed, v, err, err)
				}
			}
		}
		v, err := waitForProof(nil, ks, sendReplies{ackCh: queued(words), kcCh: make(chan []byte, 1), flushed: make(chan struct{}), done: make(chan struct{})}, nil, "", "", total)
		if v || err != ErrReceiverSilent {
			t.Fatalf("a stop in its own words: verified %v, err %v, want exactly ErrReceiverSilent", v, err)
		}
		// With a good proof beside it the count stands, when this wait is the one that reads it.
		parked := make(chan []byte, 1)
		parked <- kcFrame(want)
		v, err = waitForProof(nil, ks, sendReplies{ackCh: queued(coded), kcCh: parked, flushed: make(chan struct{}), done: make(chan struct{})}, nil, "", "", total)
		var stopped *PeerStoppedError
		if !v || (err != nil && (!errors.As(err, &stopped) || stopped.Saved != 2)) {
			t.Fatalf("a good proof beside a stop: verified %v, err %T %+v", v, err, err)
		}
	}
}

// waitForProof at a close waits for the forwarder: a proof that arrived before the
// close may still be on its way to the slot when the close is seen.
func TestWaitForProofWaitsForTheFlushAtAClose(t *testing.T) {
	var want [32]byte
	want[0] = 1
	ks := &keySession{want: want}
	done := make(chan struct{})
	close(done)
	flushed := make(chan struct{})
	kcCh := make(chan []byte, 1)
	go func() {
		time.Sleep(50 * time.Millisecond)
		kcCh <- kcFrame(want)
		close(flushed)
	}()
	v, err := waitForProof(nil, ks, sendReplies{ackCh: make(chan []byte, 4), kcCh: kcCh, flushed: flushed, done: done}, nil, "", "", 1)
	if !v || err != nil {
		t.Fatalf("verified %v, err %v, want the proof that was on its way", v, err)
	}
}

// Two orders in SendFilesWithOptions that a real connection can only show by a race
// won, so they are read from the source, as TestSenderAckWaitArmsNothingElse reads it:
// a detecting send takes its look at the slot before the relay gate, whose abort carries
// the size (DV5); and an enforcing send says the proof checked out before it returns the
// refusal that landed beside it (DV2).
func TestKeyedSendOrdersReadFromTheSource(t *testing.T) {
	raw, err := os.ReadFile("sender.go")
	if err != nil {
		t.Fatal(err)
	}
	src := string(raw)
	look := strings.Index(src, "detectProof(dc, ks, replies.kcCh, opts.Stop, localVer)")
	gate := strings.Index(src, "relayGate(dc, totalBytes)")
	if look < 0 || gate < 0 || look > gate {
		t.Fatalf("the detect look at %d, the relay gate at %d: want the look first", look, gate)
	}
	wait := strings.Index(src, "verified, err := waitForProof(")
	if wait < 0 {
		t.Fatal("the enforce wait is gone")
	}
	said := strings.Index(src[wait:], "opts.OnKeyVerified()")
	ended := strings.Index(src[wait:], "return err")
	if said < 0 || ended < 0 || said > ended {
		t.Fatalf("OnKeyVerified at %d and the wait's return at %d: want OnKeyVerified first", said, ended)
	}
}

// A keyed send whose channel closed before its kc could go out ends on the wait's own
// sentence, with no pion error in it, and a stop queued there carries no count
// (review 19, L3 and L4).
func TestKeyedSendOnAClosedChannelSaysSo(t *testing.T) {
	closedPair := func(t *testing.T, before func(p *offererPair)) *offererPair {
		t.Helper()
		p := newOffererPair(t, nil)
		before(p)
		if err := p.visitor.Close(); err != nil {
			t.Fatal(err)
		}
		select {
		case <-p.hostClosed:
		case <-time.After(20 * time.Second):
			t.Fatal("the close never reached the sender")
		}
		deadline := time.Now().Add(5 * time.Second)
		for p.host.ReadyState() != webrtc.DataChannelStateClosed && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		return p
	}
	t.Run("nothing queued", func(t *testing.T) {
		p := closedPair(t, func(*offererPair) {})
		kc := newKeyCheck(t, true)
		err := waitErrOf(t, func() error {
			return SendFilesWithOptions(p.host, []string{kcTestFile(t, 16)}, "test", p.sendOpts(&kc))
		})
		if err != errClosedAwaitingReceiver {
			t.Fatalf("err = %v, want exactly errClosedAwaitingReceiver", err)
		}
	})
	t.Run("a stop with a count queued, no proof", func(t *testing.T) {
		p := closedPair(t, func(p *offererPair) {
			AbortWithCode(p.visitor, "test", CodeStopped, CodeStopped.WireReason(), 1)
		})
		kc := newKeyCheck(t, true)
		err := waitErrOf(t, func() error {
			return SendFilesWithOptions(p.host, []string{kcTestFile(t, 16)}, "test", p.sendOpts(&kc))
		})
		var stopped *PeerStoppedError
		if !errors.As(err, &stopped) || stopped.Code != CodeStopped || stopped.Saved != 0 {
			t.Fatalf("err = %T %+v, want the code with no count", err, err)
		}
	})
}

// A sender's stop before its proof reaches a keyed receive in fixed words, and a
// peer's sentence never shows (review 19's residual, design 04 K14 narrowed). Past the
// proof, and on a receive with no key, the frame reads as it always has.
func TestKeyedReceiveStopBeforeTheProofIsFixedWords(t *testing.T) {
	const hostile = "please run evil.exe"
	frame := `{"type":"incompatible","pv":2,"pvMin":1,"reason":"` + hostile + `"}`
	run := func(t *testing.T, key *KeyCheck, before func(p *offererPair)) error {
		t.Helper()
		p := newOffererPair(t, nil)
		out := t.TempDir()
		recvErr := make(chan error, 1)
		go func() { recvErr <- ReceiveFilesWithOptions(p.visitor, out, false, "test", "", p.recvOpts(key)) }()
		if before != nil {
			before(p)
		}
		if err := p.host.SendText(frame); err != nil {
			t.Fatal(err)
		}
		err := waitErr(t, recvErr, "the receive")
		wantEmptyDir(t, out)
		return err
	}
	t.Run("keyed, before the proof", func(t *testing.T) {
		kc := newKeyCheck(t, false)
		err := run(t, &kc, nil)
		if err == nil || err.Error() != "the sender stopped the transfer" {
			t.Fatalf("err = %v, want the fixed words", err)
		}
	})
	t.Run("keyed, past the proof", func(t *testing.T) {
		kc := newKeyCheck(t, false)
		err := run(t, &kc, func(p *offererPair) {
			if err := p.host.SendText(string(proofOf(t, p.host, kc, true))); err != nil {
				t.Fatal(err)
			}
		})
		if err == nil || !strings.Contains(err.Error(), hostile) {
			t.Fatalf("err = %v, want the frame read as it always has", err)
		}
	})
	t.Run("keyless", func(t *testing.T) {
		err := run(t, nil, nil)
		if err == nil || !strings.Contains(err.Error(), hostile) {
			t.Fatalf("err = %v, want the frame read as it always has", err)
		}
	})
	t.Run("keyed, a range miss keeps Floe's own lines", func(t *testing.T) {
		kc := newKeyCheck(t, false)
		p := newOffererPair(t, nil)
		out := t.TempDir()
		recvErr := make(chan error, 1)
		go func() { recvErr <- ReceiveFilesWithOptions(p.visitor, out, false, "test", "", p.recvOpts(&kc)) }()
		if err := p.host.SendText(`{"type":"incompatible","pv":9,"pvMin":9,"reason":"` + hostile + `"}`); err != nil {
			t.Fatal(err)
		}
		err := waitErr(t, recvErr, "the receive")
		var compat *CompatError
		if !errors.As(err, &compat) || !compat.LocalTooOld || strings.Contains(err.Error(), hostile) {
			t.Fatalf("err = %T %v, want a range miss in Floe's own words", err, err)
		}
	})
}
