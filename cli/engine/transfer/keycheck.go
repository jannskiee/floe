package transfer

// The link-key check: what a side holding a link's key computes, reads and waits
// for. After DTLS opens, each side proves it holds the key with an HMAC bound to
// the two certificates DTLS actually used, so a signaling server that swapped
// fingerprints to sit between the peers cannot produce a tag either end accepts.
//
// SendFilesWithOptions and ReceiveFilesWithOptions hold the order of the check;
// the wait and the judging live here. client/lib/transfer/keyCheck.ts and
// keySession.ts are the browser twins; the shared vectors in
// testdata/keycheck-vectors.json and the keyCheck parity rows hold the two to the
// same bytes.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jannskiee/floe/cli/engine/linkkey"
	"github.com/pion/webrtc/v4"
)

// KeyCheck is what a side that holds a link's key hands a send or a receive.
// RoomID is used exactly as the link holds it, letter case included. Enforce is a
// sender's choice to wait for the receiver's proof before naming any file; a
// receiver holding a key always requires the sender's.
//
// Key is an exported field on purpose: fmt calls Key's redacting methods only on
// a field it can reach, so a printed KeyCheck shows no key. A struct that keeps
// one keeps it by pointer: held by value in an unexported field, %v prints the
// bytes, because fmt reaches no method there, and go vet allows that call.
type KeyCheck struct {
	Key     linkkey.Key
	RoomID  string
	Enforce bool
}

// The check's outcomes. Fixed text, with no value from the peer and nothing of
// the key in any of them.
var (
	// ErrReceiverNotConfirmed: the receiver's proof arrived and was wrong.
	ErrReceiverNotConfirmed = errors.New("the receiver could not prove it holds this link's key, so nothing was sent")
	// ErrReceiverSilent: an enforcing sender's wait ended with no proof at all.
	ErrReceiverSilent = errors.New("the receiver sent no proof of this link's key in time, so nothing was sent")
	// ErrSenderNotConfirmed: a keyed receive refused its sender. It is RX-11 of
	// the approved CLI copy, and what RefusedError prints for CodeUnverified.
	ErrSenderNotConfirmed = errors.New("receive stopped: the sender could not be confirmed, so nothing was saved")
	// ErrKeyCheckUnavailable: this side cannot compute a proof on this
	// connection (certHashes). It says nothing about the other side.
	ErrKeyCheckUnavailable = errors.New("this connection's certificates could not be read to check the link's key")
)

var errKeyCheckRoomID = errors.New("this link's room id cannot be used in a key check")

// errSenderStoppedUnproven is the stop of a sender that has not proved the key, for
// a receive that holds it. The words are the ones this receive already uses for a stop
// it cannot read.
var errSenderStoppedUnproven = errors.New("the sender stopped the transfer")

// errKeyCheckNeedsPump refuses a keyed send with no pump, before anything goes
// out. The fallback OnMessage registers late and can lose a kc the receiver sent
// when its receive began, which an enforcing send would then read as silence.
var errKeyCheckNeedsPump = errors.New("a send with a link key needs the connection's message pump")

// keyCheckWait is KeyCheckWait as a var, only so tests can shrink it.
var keyCheckWait = KeyCheckWait

// keyCheckProtocol is the protocol version that first speaks kc. It is the lowest
// and the highest version named in the frame a failed check stops with, which
// misses every peer that does not speak kc. Mirrored by KEY_CHECK_PROTOCOL in
// protocol.ts.
const keyCheckProtocol = 2

// The domain label and the two role bytes the message starts with: the ASCII
// letters s and r, the file sender's tag and the file receiver's. The role keeps
// one side's proof from being replayed at it as the other's.
const (
	keyCheckLabel       = "floe-kc-v1"
	kcRoleSender   byte = 0x73
	kcRoleReceiver byte = 0x72
)

// certSource is what certHashes reads off a DTLS transport, and it is the seam
// that lets a test reach the states a real pion connection never shows.
type certSource interface {
	State() webrtc.DTLSTransportState
	GetLocalParameters() (webrtc.DTLSParameters, error)
	GetRemoteCertificate() []byte
}

// certHashes returns the SHA-256 of this side's and the other side's DTLS
// certificates on dc's connection. Any way of coming up short is
// ErrKeyCheckUnavailable, with zero hashes: this side cannot prove anything, so a
// caller holding a key fails closed and never proceeds on a guess.
func certHashes(dc *webrtc.DataChannel) (local, remote [32]byte, err error) {
	if dc == nil {
		return [32]byte{}, [32]byte{}, ErrKeyCheckUnavailable
	}
	sctp := dc.Transport()
	if sctp == nil {
		return [32]byte{}, [32]byte{}, ErrKeyCheckUnavailable
	}
	dtls := sctp.Transport()
	if dtls == nil {
		return [32]byte{}, [32]byte{}, ErrKeyCheckUnavailable
	}
	return certHashesFrom(dtls)
}

// certHashesFrom is certHashes past the nil checks.
//
// Local is the one sha-256 fingerprint pion announces for this side. Floe sets no
// certificates, so pion generates one and DTLS presents certificates[0] (pion's
// dtlstransport.go), which is what the other side hashes; more than one would
// leave this side unable to say which it is, so that fails closed too. Remote is
// the hash of pion's own slice of the DER the other side presented, read and
// never kept or changed.
func certHashesFrom(t certSource) (local, remote [32]byte, err error) {
	if t.State() != webrtc.DTLSTransportStateConnected {
		return [32]byte{}, [32]byte{}, ErrKeyCheckUnavailable
	}
	params, err := t.GetLocalParameters()
	if err != nil {
		return [32]byte{}, [32]byte{}, ErrKeyCheckUnavailable
	}
	if len(params.Fingerprints) != 1 || !strings.EqualFold(params.Fingerprints[0].Algorithm, "sha-256") {
		return [32]byte{}, [32]byte{}, ErrKeyCheckUnavailable
	}
	local, ok := decodeFingerprint(params.Fingerprints[0].Value)
	if !ok {
		return [32]byte{}, [32]byte{}, ErrKeyCheckUnavailable
	}
	der := t.GetRemoteCertificate()
	if len(der) == 0 {
		return [32]byte{}, [32]byte{}, ErrKeyCheckUnavailable
	}
	return local, sha256.Sum256(der), nil
}

// decodeFingerprint reads a SHA-256 fingerprint as an SDP writes it. Colons and
// the case of the hex digits do not matter, and anything but 32 bytes is no
// fingerprint.
func decodeFingerprint(value string) ([32]byte, bool) {
	raw, err := hex.DecodeString(strings.ReplaceAll(value, ":", ""))
	if err != nil || len(raw) != 32 {
		return [32]byte{}, false
	}
	var out [32]byte
	copy(out[:], raw)
	return out, true
}

// keyCheckMessage is the bytes the MAC covers:
//
//	"floe-kc-v1" || 0x00 || role || len(roomID) as one byte || roomID || hS || hR
//
// where hS and hR are the certificate hashes of the file sender's and the file
// receiver's DTLS endpoints. The length byte is why a room id must fit in 1 to
// 255 bytes; the error never quotes it.
func keyCheckMessage(role byte, roomID string, hS, hR [32]byte) ([]byte, error) {
	if roomID == "" || len(roomID) > 255 {
		return nil, errKeyCheckRoomID
	}
	msg := make([]byte, 0, len(keyCheckLabel)+3+len(roomID)+len(hS)+len(hR))
	msg = append(msg, keyCheckLabel...)
	msg = append(msg, 0x00, role, byte(len(roomID)))
	msg = append(msg, roomID...)
	msg = append(msg, hS[:]...)
	msg = append(msg, hR[:]...)
	return msg, nil
}

// keyCheckTag is HMAC-SHA256 of keyCheckMessage under the link key.
func keyCheckTag(key linkkey.Key, role byte, roomID string, hS, hR [32]byte) ([32]byte, error) {
	msg, err := keyCheckMessage(role, roomID, hS, hR)
	if err != nil {
		return [32]byte{}, err
	}
	mac := hmac.New(sha256.New, key[:])
	mac.Write(msg)
	var tag [32]byte
	mac.Sum(tag[:0])
	return tag, nil
}

// kcFrame is the proof on the wire: type first, then the 43 canonical base64url
// characters, 65 bytes in all and byte for byte what the browser's JSON.stringify
// writes. No JSON encoder is needed because the alphabet holds nothing JSON
// escapes. A file sender sends it as TEXT and a file receiver as BINARY, the
// framing rule every other frame in that direction follows.
func kcFrame(tag [32]byte) []byte {
	return []byte(`{"type":"kc","tag":"` + base64.RawURLEncoding.EncodeToString(tag[:]) + `"}`)
}

// kcKind is what parseKC found in a frame.
type kcKind int

const (
	kcNone      kcKind = iota // not a kc frame at all
	kcTag                     // a kc frame with a canonical tag
	kcMalformed               // a kc frame with anything else, a failed check for a side holding a key
)

// parseKC reads a peer's kc frame through controlFields, as abortFromPeer reads
// an incompatible, so controlMsgMax holds and "type" and "tag" are read by their
// exact keys from raw values, with JSON escapes undone and a duplicate key keeping
// its last value. A tag that is not exactly the canonical 43 characters is
// malformed. The tag is never shown, logged or stored; kcTagMatches is the one
// thing that looks at it.
func parseKC(raw []byte) ([32]byte, kcKind) {
	fields, typ, ok := controlFields(raw)
	if !ok || typ != "kc" {
		return [32]byte{}, kcNone
	}
	lit := fields["tag"]
	if len(lit) == 0 || lit[0] != '"' {
		return [32]byte{}, kcMalformed
	}
	var s string
	if json.Unmarshal(lit, &s) != nil {
		return [32]byte{}, kcMalformed
	}
	decoded, ok := linkkey.DecodeCanonical(s, 32)
	if !ok {
		return [32]byte{}, kcMalformed
	}
	var tag [32]byte
	copy(tag[:], decoded)
	return tag, kcTag
}

// kcTagMatches reports whether raw is a kc frame holding exactly want, compared
// in constant time. A frame that is no tag at all never matches, even an all-zero
// want, because parseKC's kind is read before its value.
func kcTagMatches(raw []byte, want [32]byte) bool {
	tag, kind := parseKC(raw)
	return kind == kcTag && hmac.Equal(tag[:], want[:])
}

// LinkKeyProof builds this side's kc frame on dc's connection. fileSender says
// which side of the transfer this is, which is not the same as which side made
// the WebRTC offer: a request-link host offers and receives. It is an honest
// proof always, and that is the point of exporting it: a test harness that wants
// a failing peer passes it a different key, with no way to make this code lie.
func LinkKeyProof(dc *webrtc.DataChannel, kc KeyCheck, fileSender bool) ([]byte, error) {
	ks, err := newKeySession(dc, &kc, fileSender)
	if err != nil {
		return nil, err
	}
	return ks.own, nil
}

// keySession is one connection's check: the frame this side sends and the tag it
// must see. It holds neither the key nor the room id, so nothing that keeps it can
// print them.
type keySession struct {
	own  []byte
	want [32]byte
}

// newKeySession computes both tags from the certificates DTLS used on dc's
// connection. Its errors are fixed text: ErrKeyCheckUnavailable when this side
// cannot read them, and errKeyCheckRoomID for a room id no link can hold.
func newKeySession(dc *webrtc.DataChannel, kc *KeyCheck, fileSender bool) (*keySession, error) {
	local, remote, err := certHashes(dc)
	if err != nil {
		return nil, err
	}
	ownRole, peerRole, hS, hR := kcRoleReceiver, kcRoleSender, remote, local
	if fileSender {
		ownRole, peerRole, hS, hR = kcRoleSender, kcRoleReceiver, local, remote
	}
	own, err := keyCheckTag(kc.Key, ownRole, kc.RoomID, hS, hR)
	if err != nil {
		return nil, err
	}
	want, err := keyCheckTag(kc.Key, peerRole, kc.RoomID, hS, hR)
	if err != nil {
		return nil, err
	}
	return &keySession{own: kcFrame(own), want: want}, nil
}

// verify reports whether raw is the proof this side must see.
func (ks *keySession) verify(raw []byte) bool {
	return kcTagMatches(raw, ks.want)
}

// abortUnverified is a sender's stop for a failed check, one frame for a bad proof
// and for silence: TEXT, because this direction carries file data, with the range
// incompatibleFrame gives the code, so a released receiver misses it and prints its
// own update remedy and a current one reads the code. Nothing follows it, so a Stop
// that has closed stays silent: the caller's own abort is the one the peer reads.
func abortUnverified(dc *webrtc.DataChannel, stop <-chan struct{}, localVer string) {
	if stopRequested(stop) {
		return
	}
	sendIncompatible(dc, incompatibleFrame(localVer, CodeUnverified, senderUnverifiedReason, -1), true)
}

// detectProof is a detecting sender's look at the slot, without waiting: a proof
// that is here and wrong stops the send, and no proof at all is a receiver without
// the key, which goes on. The first file's ack is its last look, and the look there
// sees every proof sent ahead of that ack, because the pump parks a kc before it
// forwards what came behind it. A nil session is a keyless send.
func detectProof(dc *webrtc.DataChannel, ks *keySession, kcCh <-chan []byte, stop <-chan struct{}, localVer string) error {
	if ks == nil {
		return nil
	}
	select {
	case raw := <-kcCh:
		if !ks.verify(raw) {
			abortUnverified(dc, stop, localVer)
			return ErrReceiverNotConfirmed
		}
	default:
	}
	return nil
}

// waitForProof is an enforcing sender's wait for the receiver's proof, before it
// names any file. It reports whether the proof checked out, which can be true
// beside an error: a refusal that landed with a good proof still ends the send, and
// the caller says what a good proof lets it say first.
//
// A queued kc is judged before a queued refusal, a close or the clock, whichever arm
// select picks between ready ones, because each of those arms looks in its slot
// first, so a man in the middle, whose kc is always wrong, gets one line every time.
// A frame that is neither is dropped: no honest receiver has anything else to say
// before the first metadata.
//
// In this file and not sender.go, because TestSenderAckWaitArmsNothingElse reads
// that file as text: this timer is over before the ack wait begins.
func waitForProof(dc *webrtc.DataChannel, ks *keySession, r sendReplies, stop <-chan struct{}, localVer, updateHint string, total int) (bool, error) {
	judge := func(raw []byte) (bool, error) {
		if ks.verify(raw) {
			return true, nil
		}
		abortUnverified(dc, stop, localVer)
		return false, ErrReceiverNotConfirmed
	}
	deadline := time.NewTimer(keyCheckWait)
	defer deadline.Stop()
	for {
		select {
		case raw := <-r.kcCh:
			return judge(raw)
		case raw := <-r.ackCh:
			verified := false
			select {
			case proof := <-r.kcCh:
				ok, err := judge(proof)
				if err != nil {
					return false, err
				}
				verified = ok
			default:
			}
			if err := abortFromPeer(raw, localVer, updateHint, total); err != nil {
				if !verified {
					return false, unprovenStop(err)
				}
				return true, err
			}
			if verified {
				return true, nil
			}
		case <-r.done:
			// The frames that arrived before the close are moved by the flush.
			waitFlushed(r.flushed)
			select {
			case raw := <-r.kcCh:
				return judge(raw)
			default:
			}
			if err := stopBeforeClose(r.ackCh, r.flushed, localVer, updateHint, total); err != nil {
				return false, unprovenStop(err)
			}
			return false, errClosedAwaitingReceiver
		case <-deadline.C:
			select {
			case raw := <-r.kcCh:
				return judge(raw)
			default:
			}
			abortUnverified(dc, stop, localVer)
			return false, ErrReceiverSilent
		case <-stop:
			return false, ErrSendStopped
		}
	}
}

// unprovenStop is what a stop from a receiver that has proved nothing may say to a
// sender holding the key. A code keeps its fixed sentence and loses its count, or a
// man in the middle could make a visitor read "2 of 3 files were saved" with nothing
// sent. A frame's own words go too: the sentence is the one for no proof. A range miss
// stays, because those lines are Floe's own.
func unprovenStop(err error) error {
	var stopped *PeerStoppedError
	if errors.As(err, &stopped) {
		return &PeerStoppedError{Code: stopped.Code}
	}
	var ended *PeerEndedError
	if errors.As(err, &ended) {
		return ErrReceiverSilent
	}
	return err
}

// keyCheckEnded reports whether err is the check's own ending inside the file loop,
// which is about the receiver and names no file.
func keyCheckEnded(err error) bool {
	return errors.Is(err, ErrReceiverNotConfirmed)
}

// refuseUnverified is a keyed receiver's stop for a sender that did not prove it
// holds the link: the coded frame, then the typed error. Nothing is on disk, because
// the check comes before the first metadata is even parsed.
func refuseUnverified(dc *webrtc.DataChannel, localVer string) error {
	AbortWithCode(dc, localVer, CodeUnverified, CodeUnverified.WireReason(), 0)
	return &RefusedError{Code: CodeUnverified, Err: ErrSenderNotConfirmed}
}

// senderSaysUnverified reports whether an incompatible frame is a sender's stop for
// a failed check, its code read by exact key as every other reader of a code does.
func senderSaysUnverified(raw []byte) bool {
	fields, _, ok := controlFields(raw)
	if !ok {
		return false
	}
	code, known := refusalCodeIn(fields)
	return known && code == CodeUnverified
}
