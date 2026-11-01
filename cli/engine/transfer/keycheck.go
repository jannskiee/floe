package transfer

// The link-key check's primitives: what a side holding a link's key computes and
// reads. After DTLS opens, each side proves it holds the key with an HMAC bound
// to the two certificates DTLS actually used, so a signaling server that swapped
// fingerprints to sit between the peers cannot produce a tag either end accepts.
//
// Nothing here is called from SendFilesWithOptions or ReceiveFilesWithOptions
// yet. client/lib/transfer/keyCheck.ts is the browser twin; the shared vectors in
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
	local, remote, err := certHashes(dc)
	if err != nil {
		return nil, err
	}
	role, hS, hR := kcRoleReceiver, remote, local
	if fileSender {
		role, hS, hR = kcRoleSender, local, remote
	}
	tag, err := keyCheckTag(kc.Key, role, kc.RoomID, hS, hR)
	if err != nil {
		return nil, err
	}
	return kcFrame(tag), nil
}
