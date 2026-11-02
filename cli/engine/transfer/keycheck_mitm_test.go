package transfer

// The security proof of the link-key check: a man in the middle made of real pion
// peers. A is one honest end and B the other; M is two more peers, M1 facing A and
// M2 facing B, and a forwarder between them that copies every frame across with its
// framing intact. M terminates DTLS on both legs, so it could read every byte, which
// is exactly what a signaling server that swaps fingerprints can arrange. The test
// plays that server: it hands each end the other leg's description.
//
// What each variant proves:
//
//   - Positive control: the same harness with A and B directly connected delivers
//     the file under both modes, so a failure below is the check and not the rig.
//     Variant 1c is the forwarder's own positive control: it carries a whole transfer.
//   - Variant 1, swapped fingerprints: a plain MITM. 1a, A enforcing: A stops on the
//     proof, B refuses, and no file name ever crossed M. 1b, A detecting: B still
//     refuses and no file byte ever left A, though A may name the file first, which
//     is the documented cost of detect. 1c, a keyless receiver is fooled: it pins the
//     gap the docs state (a room code carries no key), and it fails if that ever
//     changes unnoticed.
//   - Variant 2, the BUNDLE offer: the offer B answers has no session fingerprint, a
//     dummy first section holding A's honest fingerprint, and BUNDLE naming a second
//     section with M2's. A reader of the first a=fingerprint line sees A; DTLS talks
//     to M2. Its preconditions are asserted, so it cannot pass by never being built.
//     The check hashes the certificate DTLS used and never the SDP, so this ends like
//     variant 1.
//   - Variant 3, a request room: the host offers and receives, the visitor answers and
//     enforces. Decide is never called, no metadata leaves the visitor and the host's
//     folder stays empty, also with the BUNDLE offer aimed at the visitor.
//   - Variant 4, a man in the middle that swallows every kc: the check has no proof to
//     judge, so nothing proves itself, and a side holding the key still stops.
//
// Every channel is pumped from the moment it exists, on the offerer right after
// CreateDataChannel and on the answerer inside OnDataChannel, because a frame pion
// reads before a handler is in place is gone for good. pumpChannel cannot do it: it
// attaches after open, which can lose M's first forwarded frame.

import (
	"bytes"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

// mitmEnd is one peer of the rig: its connection and its channel, pumped.
type mitmEnd struct {
	pc     *webrtc.PeerConnection
	dc     *webrtc.DataChannel
	msgs   chan webrtc.DataChannelMessage
	closed chan struct{}
	open   chan struct{}
}

func newMitmEnd(t *testing.T) *mitmEnd {
	t.Helper()
	se := webrtc.SettingEngine{}
	se.SetIncludeLoopbackCandidate(true)
	pc, err := webrtc.NewAPI(webrtc.WithSettingEngine(se)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("new connection: %v", err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	return &mitmEnd{
		pc:     pc,
		msgs:   make(chan webrtc.DataChannelMessage, 4096),
		closed: make(chan struct{}),
		open:   make(chan struct{}),
	}
}

// attach pumps a channel, as peer.Connection.attach does, in the same breath as it
// comes to exist.
func (e *mitmEnd) attach(dc *webrtc.DataChannel) {
	e.dc = dc
	var closing, opening sync.Once
	dc.OnClose(func() { closing.Do(func() { close(e.closed) }) })
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		select {
		case e.msgs <- m:
		case <-e.closed:
		}
	})
	dc.OnOpen(func() { opening.Do(func() { close(e.open) }) })
}

// connectLeg plays the signaling server for one leg, non-trickle: the offerer makes
// the channel, and rewrite, when set, is what a hostile server does to the offer and
// to the answer on the way through.
func connectLeg(t *testing.T, offerer, answerer *mitmEnd, rewriteOffer, rewriteAnswer func(string) string) string {
	t.Helper()
	got := make(chan struct{})
	var once sync.Once
	answerer.pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		answerer.attach(dc)
		once.Do(func() { close(got) })
	})
	dc, err := offerer.pc.CreateDataChannel("floe", nil)
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	offerer.attach(dc)

	offer, err := offerer.pc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create offer: %v", err)
	}
	gathered := webrtc.GatheringCompletePromise(offerer.pc)
	if err := offerer.pc.SetLocalDescription(offer); err != nil {
		t.Fatalf("offerer local description: %v", err)
	}
	<-gathered
	sent := offerer.pc.LocalDescription().SDP
	if rewriteOffer != nil {
		sent = rewriteOffer(sent)
	}
	if err := answerer.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sent}); err != nil {
		t.Fatalf("answerer remote description: %v", err)
	}
	answer, err := answerer.pc.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("create answer: %v", err)
	}
	gathered = webrtc.GatheringCompletePromise(answerer.pc)
	if err := answerer.pc.SetLocalDescription(answer); err != nil {
		t.Fatalf("answerer local description: %v", err)
	}
	<-gathered
	back := answerer.pc.LocalDescription().SDP
	if rewriteAnswer != nil {
		back = rewriteAnswer(back)
	}
	if err := offerer.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: back}); err != nil {
		t.Fatalf("offerer remote description: %v", err)
	}
	for name, ch := range map[string]<-chan struct{}{"the offerer's channel": offerer.open, "the answerer's data channel event": got} {
		select {
		case <-ch:
		case <-time.After(30 * time.Second):
			t.Fatalf("%s never came", name)
		}
	}
	select {
	case <-answerer.open:
	case <-time.After(30 * time.Second):
		t.Fatal("the answerer's channel never opened")
	}
	return sent
}

// mitmFrame is what the forwarder saw go past, never its content.
type mitmFrame struct {
	toB  bool
	text bool
	typ  string
}

// forwarder copies frames between M's two channels, keeping TEXT and BINARY as they
// came, and carries a close across. drop, when set, is a frame M swallows.
type forwarder struct {
	mu     sync.Mutex
	frames []mitmFrame
	drop   func(typ string) bool
}

func (f *forwarder) carry(from, to *mitmEnd, toB bool) {
	pass := func(m webrtc.DataChannelMessage) {
		typ, _ := classifyControl(m.Data)
		f.mu.Lock()
		f.frames = append(f.frames, mitmFrame{toB: toB, text: m.IsString, typ: typ})
		f.mu.Unlock()
		if f.drop != nil && f.drop(typ) {
			return
		}
		if m.IsString {
			_ = to.dc.SendText(string(m.Data))
		} else {
			_ = to.dc.Send(m.Data)
		}
	}
	for {
		select {
		case m := <-from.msgs:
			pass(m)
		case <-from.closed:
			for {
				select {
				case m := <-from.msgs:
					pass(m)
				default:
					// What was queued has gone out; let it reach the far end before the close.
					flushControl(to.dc)
					_ = to.dc.Close()
					return
				}
			}
		}
	}
}

// seen is what crossed M in one direction: the types of the TEXT frames, and how
// many BINARY frames there were that are not control frames.
func (f *forwarder) seen(toB bool) (types []string, fileBytes int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, fr := range f.frames {
		if fr.toB != toB {
			continue
		}
		if fr.typ != "" {
			types = append(types, fr.typ)
		} else if !fr.text {
			fileBytes++
		}
	}
	return types, fileBytes
}

// wantNoName fails if a metadata frame or a file byte crossed M toward B.
func (f *forwarder) wantNoName(t *testing.T) {
	t.Helper()
	types, fileBytes := f.seen(true)
	for _, typ := range types {
		if typ == "metadata" {
			t.Errorf("a file name crossed the man in the middle; frames toward B: %v", types)
		}
	}
	if fileBytes != 0 {
		t.Errorf("%d file frames crossed the man in the middle", fileBytes)
	}
}

// fingerprintLine is the first a=fingerprint value of an SDP, what a reader that
// stops at the first line sees.
var fingerprintLine = regexp.MustCompile(`(?m)^a=fingerprint:sha-256 ([0-9A-Fa-f:]+)\r?$`)

func firstFingerprint(t *testing.T, sdpText string) string {
	t.Helper()
	m := fingerprintLine.FindStringSubmatch(sdpText)
	if m == nil {
		t.Fatalf("no a=fingerprint line in the description")
	}
	return m[1]
}

// bundleOffer is design D2's offer. From M2's real offer: the session fingerprint
// goes, M2's fingerprint moves into the m=application section (mid 0), and a dummy
// m=text section with mid x and the honest peer's fingerprint goes in front of it.
// BUNDLE still names only mid 0, so a BUNDLE-reading stack takes M2's fingerprint and
// ICE details from there, and a first-line reader takes the honest one.
func bundleOffer(t *testing.T, offer, honestFingerprint string) string {
	t.Helper()
	var parsed sdp.SessionDescription
	if err := parsed.UnmarshalString(offer); err != nil {
		t.Fatalf("parse the offer: %v", err)
	}
	own, ok := parsed.Attribute("fingerprint")
	if !ok {
		t.Fatal("pion no longer writes its fingerprint at session level; re-anchor this test")
	}
	kept := parsed.Attributes[:0:0]
	for _, a := range parsed.Attributes {
		if a.Key != "fingerprint" {
			kept = append(kept, a)
		}
	}
	parsed.Attributes = kept
	if len(parsed.MediaDescriptions) != 1 || parsed.MediaDescriptions[0].MediaName.Media != "application" {
		t.Fatalf("the offer's sections changed: %d", len(parsed.MediaDescriptions))
	}
	application := parsed.MediaDescriptions[0]
	application.WithValueAttribute("fingerprint", own)
	dummy := &sdp.MediaDescription{
		MediaName: sdp.MediaName{
			Media:   "text",
			Port:    sdp.RangedPort{Value: 9},
			Protos:  []string{"UDP", "TLS", "RTP", "SAVPF"},
			Formats: []string{"0"},
		},
		ConnectionInformation: application.ConnectionInformation,
	}
	dummy.WithValueAttribute("mid", "x")
	dummy.WithValueAttribute("fingerprint", "sha-256 "+honestFingerprint)
	parsed.MediaDescriptions = []*sdp.MediaDescription{dummy, application}
	raw, err := parsed.Marshal()
	if err != nil {
		t.Fatalf("write the offer: %v", err)
	}
	return string(raw)
}

// oneSectionAnswer is the server's other half of the BUNDLE lie: the answer to the
// two-section offer goes back to M2 with only the section M2 ever offered.
func oneSectionAnswer(t *testing.T, answer string) string {
	t.Helper()
	var parsed sdp.SessionDescription
	if err := parsed.UnmarshalString(answer); err != nil {
		t.Fatalf("parse the answer: %v", err)
	}
	var kept []*sdp.MediaDescription
	for _, m := range parsed.MediaDescriptions {
		if m.MediaName.Media == "application" {
			kept = append(kept, m)
		}
	}
	parsed.MediaDescriptions = kept
	raw, err := parsed.Marshal()
	if err != nil {
		t.Fatalf("write the answer: %v", err)
	}
	return string(raw)
}

// mitmRig is the four peers, connected and forwarding.
type mitmRig struct {
	a, m1, m2, b *mitmEnd
	fwd          *forwarder
	// offerToB is the description B answered, what a first-line reader would read.
	offerToB string
}

// newMitmRig connects A to M1 and M2 to B, with A and M2 making the offers: an
// ordinary room's sender offers, and so does a request room's host, which sits in
// A's seat. bundle aims D2's BUNDLE offer at B, the side that answers.
func newMitmRig(t *testing.T, bundle bool, drop func(string) bool) *mitmRig {
	t.Helper()
	r := &mitmRig{a: newMitmEnd(t), m1: newMitmEnd(t), m2: newMitmEnd(t), b: newMitmEnd(t), fwd: &forwarder{drop: drop}}
	connectLeg(t, r.a, r.m1, nil, nil)
	var rewriteOffer, rewriteAnswer func(string) string
	if bundle {
		honest := firstFingerprint(t, r.a.pc.LocalDescription().SDP)
		rewriteOffer = func(offer string) string { return bundleOffer(t, offer, honest) }
		rewriteAnswer = func(answer string) string { return oneSectionAnswer(t, answer) }
	}
	r.offerToB = connectLeg(t, r.m2, r.b, rewriteOffer, rewriteAnswer)

	// Both of M's channels are open, so the forwarder can start.
	go r.fwd.carry(r.m1, r.m2, true)
	go r.fwd.carry(r.m2, r.m1, false)

	// The rig's own precondition: each end's DTLS really is with M, and the two legs
	// really are two connections, whatever the descriptions said.
	aLocal, aRemote, err := certHashes(r.a.dc)
	if err != nil {
		t.Fatalf("A's certificates: %v", err)
	}
	bLocal, bRemote, err := certHashes(r.b.dc)
	if err != nil {
		t.Fatalf("B's certificates: %v", err)
	}
	m1Local, _, err := certHashes(r.m1.dc)
	if err != nil {
		t.Fatalf("M1's certificates: %v", err)
	}
	m2Local, _, err := certHashes(r.m2.dc)
	if err != nil {
		t.Fatalf("M2's certificates: %v", err)
	}
	if aRemote != m1Local || bRemote != m2Local {
		t.Fatal("an end's DTLS is not with the man in the middle")
	}
	if bRemote == aLocal || aRemote == bLocal {
		t.Fatal("an end's DTLS is with the other honest end: there is no man in the middle")
	}
	return r
}

type mitmOutcome struct {
	sendErr, recvErr error
	took             time.Duration
	incoming, decide int32
	out              string
}

// runSides runs the send on sender and the receive on receiver, the way the real
// callers do: each side closes its channel once its call has returned.
func runSides(t *testing.T, sender, receiver *mitmEnd, send *KeyCheck, recv *KeyCheck, requireReceived bool) mitmOutcome {
	t.Helper()
	src := filepath.Join(t.TempDir(), "named-after-the-secret-plan.bin")
	data := make([]byte, 128*1024)
	if _, err := rand.Read(data); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(src, data, 0o600); err != nil {
		t.Fatal(err)
	}
	out := t.TempDir()
	var incoming, decided atomic.Int32
	sendDone, recvDone := make(chan error, 1), make(chan error, 1)
	started := time.Now()
	var took atomic.Int64
	go func() {
		err := SendFilesWithOptions(sender.dc, []string{src}, "test", SendOptions{
			OnProgress:      func(Progress) {},
			Messages:        sender.msgs,
			Closed:          sender.closed,
			KeyCheck:        send,
			RequireReceived: requireReceived,
			NoSummary:       true,
		})
		took.Store(int64(time.Since(started)))
		_ = sender.dc.Close()
		sendDone <- err
	}()
	go func() {
		err := ReceiveFilesWithOptions(receiver.dc, out, false, "test", "", ReceiveOptions{
			OnProgress: func(Progress) {},
			OnIncoming: func(IncomingInfo) { incoming.Add(1) },
			Decide: func(IncomingInfo) Decision {
				decided.Add(1)
				return Decision{Kind: DecisionAccept}
			},
			Messages: receiver.msgs,
			Closed:   receiver.closed,
			KeyCheck: recv,
		})
		_ = receiver.dc.Close()
		recvDone <- err
	}()
	res := mitmOutcome{out: out}
	res.sendErr = waitErr(t, sendDone, "the send")
	res.recvErr = waitErr(t, recvDone, "the receive")
	res.took = time.Duration(took.Load())
	res.incoming, res.decide = incoming.Load(), decided.Load()
	if res.sendErr == nil && res.recvErr == nil {
		got, err := os.ReadFile(filepath.Join(out, filepath.Base(src)))
		if err != nil {
			t.Fatalf("read the saved file: %v", err)
		}
		if !bytes.Equal(got, data) {
			t.Fatal("the saved file differs from what was sent")
		}
	}
	return res
}

// wantReceiverRefused holds the receiver's half of every variant: the typed refusal,
// no callback, no question, and nothing on disk, not even a .part.
func wantReceiverRefused(t *testing.T, res mitmOutcome) {
	t.Helper()
	if !errors.Is(res.recvErr, ErrSenderNotConfirmed) {
		t.Errorf("the receive ended on %T %v, want ErrSenderNotConfirmed", res.recvErr, res.recvErr)
	}
	if res.incoming != 0 || res.decide != 0 {
		t.Errorf("a person was asked: OnIncoming %d, Decide %d", res.incoming, res.decide)
	}
	wantEmptyDir(t, res.out)
}

func wantStoppedByProof(t *testing.T, res mitmOutcome) {
	t.Helper()
	if res.sendErr != ErrReceiverNotConfirmed {
		t.Errorf("the send ended on %T %v, want exactly ErrReceiverNotConfirmed", res.sendErr, res.sendErr)
	}
	if res.took >= keyCheckWait {
		t.Errorf("the send took %v, not inside KeyCheckWait", res.took)
	}
}

// TestMITMPositiveControl: nothing in this rig stops an honest pair. A and B connect
// directly with the same pump and the same options as the variants below.
func TestMITMPositiveControl(t *testing.T) {
	for name, enforce := range map[string]bool{"detect": false, "enforce": true} {
		t.Run(name, func(t *testing.T) {
			a, b := newMitmEnd(t), newMitmEnd(t)
			connectLeg(t, a, b, nil, nil)
			kc := newKeyCheck(t, enforce)
			recv := KeyCheck{Key: kc.Key, RoomID: kc.RoomID}
			res := runSides(t, a, b, &kc, &recv, false)
			if res.sendErr != nil || res.recvErr != nil {
				t.Fatalf("send: %v, receive: %v", res.sendErr, res.recvErr)
			}
			if res.decide != 1 {
				t.Fatalf("Decide ran %d times, want once", res.decide)
			}
		})
	}
}

// TestMITMSwappedFingerprintsEnforcing is variant 1a.
func TestMITMSwappedFingerprintsEnforcing(t *testing.T) {
	r := newMitmRig(t, false, nil)
	kc := newKeyCheck(t, true)
	recv := KeyCheck{Key: kc.Key, RoomID: kc.RoomID}
	res := runSides(t, r.a, r.b, &kc, &recv, false)
	wantStoppedByProof(t, res)
	wantReceiverRefused(t, res)
	r.fwd.wantNoName(t)
	types, _ := r.fwd.seen(true)
	if len(types) == 0 || types[0] != "kc" {
		t.Errorf("the frames toward B are %v, want A's kc first", types)
	}
}

// TestMITMSwappedFingerprintsDetecting is variant 1b. A detecting send has no wait, so
// it can name the file before it has heard anything: that is the documented cost of
// detect. What holds anyway: B refuses, nothing is saved, and no file byte leaves A.
func TestMITMSwappedFingerprintsDetecting(t *testing.T) {
	r := newMitmRig(t, false, nil)
	kc := newKeyCheck(t, false)
	recv := KeyCheck{Key: kc.Key, RoomID: kc.RoomID}
	res := runSides(t, r.a, r.b, &kc, &recv, false)
	var stopped *PeerStoppedError
	if res.sendErr != ErrReceiverNotConfirmed && !(errors.As(res.sendErr, &stopped) && stopped.Code == CodeUnverified) {
		t.Errorf("the send ended on %T %v, want the check's own ending", res.sendErr, res.sendErr)
	}
	wantReceiverRefused(t, res)
	if _, fileBytes := r.fwd.seen(true); fileBytes != 0 {
		t.Errorf("%d file frames left a detecting sender", fileBytes)
	}
}

// TestMITMKeylessReceiverIsFooled is variant 1c, and it pins the documented gap: a
// receiver holding no key (a room code) has nothing to check with, so M reads the
// file and both ends report success. It is also the forwarder's positive control: a
// whole transfer crosses it, TEXT and BINARY intact.
func TestMITMKeylessReceiverIsFooled(t *testing.T) {
	r := newMitmRig(t, false, nil)
	kc := newKeyCheck(t, false)
	res := runSides(t, r.a, r.b, &kc, nil, false)
	if res.sendErr != nil || res.recvErr != nil {
		t.Fatalf("the documented gap closed, or the rig broke: send %v, receive %v", res.sendErr, res.recvErr)
	}
	types, fileBytes := r.fwd.seen(true)
	if fileBytes == 0 {
		t.Fatal("no file frame crossed the man in the middle, so this proved nothing")
	}
	if len(types) < 3 || types[0] != "kc" || types[1] != "metadata" || types[len(types)-1] != "end" {
		t.Fatalf("the frames toward B are %v", types)
	}
	if back, _ := r.fwd.seen(false); len(back) == 0 || back[0] != "ack" {
		t.Fatalf("the frames toward A are %v, want no proof from a keyless receiver", back)
	}
}

// TestMITMBundleOfferEnforcing is variant 2: the offer says A and DTLS talks to M2.
func TestMITMBundleOfferEnforcing(t *testing.T) {
	r := newMitmRig(t, true, nil)

	// The preconditions. Without them this test could pass without ever making the
	// lie: a reader of the first a=fingerprint line sees A, the channel opened, and
	// the certificate B's DTLS actually got is M2's.
	honest := firstFingerprint(t, r.a.pc.LocalDescription().SDP)
	if got := firstFingerprint(t, r.offerToB); !strings.EqualFold(got, honest) {
		t.Fatalf("a first-line reader sees %s, want A's %s", got, honest)
	}
	if strings.Count(r.offerToB, "a=fingerprint:") != 2 || strings.Count(r.offerToB, "\nm=") != 2 {
		t.Fatalf("the offer is not the two-section shape:\n%s", r.offerToB)
	}
	if !strings.Contains(r.offerToB, "a=group:BUNDLE 0") {
		t.Fatal("the offer's BUNDLE no longer names the second section")
	}
	head, _, ok := strings.Cut(r.offerToB, "\nm=")
	if !ok || strings.Contains(head, "a=fingerprint") {
		t.Fatal("the offer still has a session-level fingerprint")
	}
	_, bRemote, err := certHashes(r.b.dc)
	if err != nil {
		t.Fatal(err)
	}
	m2Fingerprint := firstFingerprint(t, r.m2.pc.LocalDescription().SDP)
	m2Hash, ok := decodeFingerprint(m2Fingerprint)
	if !ok || bRemote != m2Hash {
		t.Fatal("B's remote certificate is not M2's")
	}
	aLocal, ok := decodeFingerprint(honest)
	if !ok || bRemote == aLocal {
		t.Fatal("B's remote certificate is A's: the lie did not hold")
	}

	kc := newKeyCheck(t, true)
	recv := KeyCheck{Key: kc.Key, RoomID: kc.RoomID}
	res := runSides(t, r.a, r.b, &kc, &recv, false)
	wantStoppedByProof(t, res)
	wantReceiverRefused(t, res)
	r.fwd.wantNoName(t)
}

// TestMITMRequestRoom is variant 3, both directions in one run, and then with the
// BUNDLE offer aimed at the visitor. The host sits in A's seat because it offers, as
// Floe Desktop does, and receives; the visitor sits in B's and sends, enforcing.
func TestMITMRequestRoom(t *testing.T) {
	for name, bundle := range map[string]bool{"swapped fingerprints": false, "BUNDLE offer at the visitor": true} {
		t.Run(name, func(t *testing.T) {
			r := newMitmRig(t, bundle, nil)
			host, visitor := r.a, r.b
			kc := newKeyCheck(t, true)
			hostKC := KeyCheck{Key: kc.Key, RoomID: kc.RoomID}
			res := runSides(t, visitor, host, &kc, &hostKC, true)
			wantStoppedByProof(t, res)
			wantReceiverRefused(t, res)
			// The visitor's frames travel toward A here, so it is that direction
			// that must hold no name and no file byte.
			types, fileBytes := r.fwd.seen(false)
			for _, typ := range types {
				if typ == "metadata" {
					t.Errorf("a file name crossed the man in the middle: %v", types)
				}
			}
			if fileBytes != 0 {
				t.Errorf("%d file frames crossed the man in the middle", fileBytes)
			}
		})
	}
}

// TestMITMThatSwallowsEveryProof is variant 4. Without a proof to judge, nothing is
// proven: an enforcing send times out on silence and a keyed receive refuses what it
// gets instead. A detecting send cannot tell this from a keyless receiver and names
// the file, and its receiver still refuses before a byte is saved.
func TestMITMThatSwallowsEveryProof(t *testing.T) {
	swallow := func(typ string) bool { return typ == "kc" }
	t.Run("enforce", func(t *testing.T) {
		shrinkKeyCheckWait(t, time.Second)
		r := newMitmRig(t, false, swallow)
		kc := newKeyCheck(t, true)
		recv := KeyCheck{Key: kc.Key, RoomID: kc.RoomID}
		res := runSides(t, r.a, r.b, &kc, &recv, false)
		if res.sendErr != ErrReceiverSilent {
			t.Errorf("the send ended on %T %v, want exactly ErrReceiverSilent", res.sendErr, res.sendErr)
		}
		wantReceiverRefused(t, res)
		r.fwd.wantNoName(t)
	})
	t.Run("detect", func(t *testing.T) {
		r := newMitmRig(t, false, swallow)
		kc := newKeyCheck(t, false)
		recv := KeyCheck{Key: kc.Key, RoomID: kc.RoomID}
		res := runSides(t, r.a, r.b, &kc, &recv, false)
		var stopped *PeerStoppedError
		if !errors.As(res.sendErr, &stopped) || stopped.Code != CodeUnverified {
			t.Errorf("the send ended on %T %v, want the receiver's refusal", res.sendErr, res.sendErr)
		}
		wantReceiverRefused(t, res)
		if _, fileBytes := r.fwd.seen(true); fileBytes != 0 {
			t.Errorf("%d file frames left the sender", fileBytes)
		}
	})
}

// TestMITMThatHoldsTheKeyGoesUnnoticed is the rig's other positive control. A middle
// that swallows each end's kc and proves the key on each leg carries the whole file, and
// neither end can tell. So it is the key, and nothing else in this rig, that stops every
// variant above, which is why the key must stay out of everything a server can read.
func TestMITMThatHoldsTheKeyGoesUnnoticed(t *testing.T) {
	r := newMitmRig(t, false, func(typ string) bool { return typ == "kc" })
	kc := newKeyCheck(t, true)
	recv := KeyCheck{Key: kc.Key, RoomID: kc.RoomID}
	towardA, err := LinkKeyProof(r.m1.dc, kc, false)
	if err != nil {
		t.Fatal(err)
	}
	towardB, err := LinkKeyProof(r.m2.dc, kc, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.m1.dc.Send(towardA); err != nil {
		t.Fatal(err)
	}
	if err := r.m2.dc.SendText(string(towardB)); err != nil {
		t.Fatal(err)
	}
	res := runSides(t, r.a, r.b, &kc, &recv, false)
	if res.sendErr != nil || res.recvErr != nil {
		t.Fatalf("send: %v, receive: %v", res.sendErr, res.recvErr)
	}
	if res.decide != 1 {
		t.Fatalf("Decide ran %d times, want once", res.decide)
	}
	if _, fileBytes := r.fwd.seen(true); fileBytes == 0 {
		t.Fatal("no file frame crossed the middle")
	}
}
