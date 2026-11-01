package transfer

// The link-key check's primitives (keycheck.go): the vectors both suites read,
// the fail-closed certificate read, the tag, the frame and its parser, and a
// real pion pair proving the two ends agree on what they hash.

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jannskiee/floe/cli/engine/linkkey"
	"github.com/pion/webrtc/v4"
)

const testRoomID = "6f207790-92a6-4662-bb68-4c4059f75139"

// keyCheckVectors is cli/engine/transfer/testdata/keycheck-vectors.json. Its tag
// rows come from Node's own crypto, written from the formula alone, and its
// certificate rows from a real pion pair and real browsers, so neither this code
// nor the browser's grades itself.
type keyCheckVectors struct {
	TagRows []struct {
		Name   string `json:"name"`
		Key    string `json:"key"`
		RoomID string `json:"roomId"`
		Role   string `json:"role"`
		HS     string `json:"hS"`
		HR     string `json:"hR"`
		Tag    string `json:"tag"`
	} `json:"tagRows"`
	CertRows []struct {
		Name        string `json:"name"`
		Source      string `json:"source"`
		DER         string `json:"der"`
		Fingerprint string `json:"fingerprint"`
		Algorithm   string `json:"algorithm"`
	} `json:"certRows"`
}

func loadKeyCheckVectors(t *testing.T) keyCheckVectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "keycheck-vectors.json"))
	if err != nil {
		t.Fatalf("read the vector file: %v", err)
	}
	var v keyCheckVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse the vector file: %v", err)
	}
	return v
}

func hex32(t *testing.T, s string) [32]byte {
	t.Helper()
	raw, err := hex.DecodeString(s)
	if err != nil || len(raw) != 32 {
		t.Fatalf("%q is not 32 bytes of hex", s)
	}
	var out [32]byte
	copy(out[:], raw)
	return out
}

// TestKeyCheckTagRows: every tag row equals what keyCheckTag computes, and the
// frame built around it parses back to the same 32 bytes.
func TestKeyCheckTagRows(t *testing.T) {
	v := loadKeyCheckVectors(t)
	if len(v.TagRows) < 8 {
		t.Fatalf("the vector file has %d tag rows, want at least the 8 it shipped with", len(v.TagRows))
	}
	for _, row := range v.TagRows {
		t.Run(row.Name, func(t *testing.T) {
			key, err := linkkey.Parse(row.Key)
			if err != nil {
				t.Fatalf("the row's key does not parse: %v", err)
			}
			role := kcRoleReceiver
			if row.Role == "s" {
				role = kcRoleSender
			}
			tag, err := keyCheckTag(key, role, row.RoomID, hex32(t, row.HS), hex32(t, row.HR))
			if err != nil {
				t.Fatalf("keyCheckTag: %v", err)
			}
			if got := base64.RawURLEncoding.EncodeToString(tag[:]); got != row.Tag {
				t.Fatalf("tag = %s, the vector says %s", got, row.Tag)
			}
			back, kind := parseKC(kcFrame(tag))
			if kind != kcTag || back != tag {
				t.Fatalf("the frame parsed back as (%x, %v)", back, kind)
			}
		})
	}
}

// TestKeyCheckCertRows: for every certificate row, from any stack, the SHA-256
// of the DER that stack presented equals the fingerprint it announced in its
// own SDP. That equality is what lets one end hash the bytes it received and the
// other hash the bytes it sent and get the same answer. Any number of rows
// passes; the two from pion are required, so a merge of the file cannot lose them.
func TestKeyCheckCertRows(t *testing.T) {
	v := loadKeyCheckVectors(t)
	pion := 0
	for _, row := range v.CertRows {
		t.Run(row.Name, func(t *testing.T) {
			if row.Algorithm != "sha-256" {
				t.Fatalf("algorithm = %q, want sha-256", row.Algorithm)
			}
			der, err := base64.StdEncoding.DecodeString(row.DER)
			if err != nil || len(der) == 0 {
				t.Fatalf("der is not standard base64: %v", err)
			}
			announced, ok := decodeFingerprint(row.Fingerprint)
			if !ok {
				t.Fatalf("fingerprint %q does not decode", row.Fingerprint)
			}
			if sha256.Sum256(der) != announced {
				t.Fatalf("SHA-256 of the DER is not the announced fingerprint %q", row.Fingerprint)
			}
		})
		if strings.HasPrefix(row.Source, "pion ") {
			pion++
		}
	}
	if pion < 2 {
		t.Fatalf("the vector file has %d pion certificate rows, want one per end of a pair", pion)
	}
}

// TestKeyCheckMessageLayout pins the bytes the MAC covers, field by field,
// separately from the vectors, so a failure says which field moved.
func TestKeyCheckMessageLayout(t *testing.T) {
	var hS, hR [32]byte
	for i := range hS {
		hS[i] = byte(i)
		hR[i] = byte(0xff - i)
	}
	msg, err := keyCheckMessage(kcRoleSender, "Ab", hS, hR)
	if err != nil {
		t.Fatalf("keyCheckMessage: %v", err)
	}
	var want bytes.Buffer
	want.WriteString("floe-kc-v1")
	want.WriteByte(0x00)
	want.WriteByte('s')
	want.WriteByte(2)
	want.WriteString("Ab")
	want.Write(hS[:])
	want.Write(hR[:])
	if !bytes.Equal(msg, want.Bytes()) {
		t.Fatalf("message = %x, want %x", msg, want.Bytes())
	}
	if kcRoleSender != 0x73 || kcRoleReceiver != 0x72 {
		t.Fatalf("role bytes = %#x and %#x, want 0x73 and 0x72", kcRoleSender, kcRoleReceiver)
	}

	long := strings.Repeat("r", 255)
	if msg, err := keyCheckMessage(kcRoleReceiver, long, hS, hR); err != nil {
		t.Fatalf("a 255-byte room id was refused: %v", err)
	} else if msg[12] != 255 || string(msg[13:13+255]) != long {
		t.Fatalf("a 255-byte room id is not carried whole: length byte %d", msg[12])
	}
	for name, room := range map[string]string{"empty": "", "256 bytes": strings.Repeat("r", 256)} {
		if msg, err := keyCheckMessage(kcRoleSender, room, hS, hR); err == nil || msg != nil {
			t.Errorf("%s room id: message %x, error %v; want no message and an error", name, msg, err)
		} else if room != "" && strings.Contains(err.Error(), room) {
			t.Errorf("%s room id: the error quotes it: %q", name, err)
		}
	}
	key, err := linkkey.New()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := keyCheckTag(key, kcRoleSender, "", hS, hR); err == nil {
		t.Error("keyCheckTag took an empty room id")
	}
	// The room id is used exactly as held: a link's letter case is part of it.
	lower, _ := keyCheckTag(key, kcRoleSender, "abc", hS, hR)
	upper, _ := keyCheckTag(key, kcRoleSender, "ABC", hS, hR)
	if lower == upper {
		t.Error("the tag ignores the room id's letter case")
	}
}

// TestKCFrameBytes: type first, the 43 characters, and byte for byte what the
// browser's JSON.stringify({type:'kc',tag}) writes, which a struct with the
// keys in the same order also writes. 65 bytes, comfortably under the control
// cap, and control-shaped to every reader.
func TestKCFrameBytes(t *testing.T) {
	var tag [32]byte
	for i := range tag {
		tag[i] = byte(i * 7)
	}
	got := kcFrame(tag)
	text := base64.RawURLEncoding.EncodeToString(tag[:])
	if want := `{"type":"kc","tag":"` + text + `"}`; string(got) != want {
		t.Fatalf("kcFrame = %s, want %s", got, want)
	}
	if len(got) != 65 {
		t.Fatalf("kcFrame is %d bytes, want 65", len(got))
	}
	marshaled, err := json.Marshal(struct {
		Type string `json:"type"`
		Tag  string `json:"tag"`
	}{"kc", text})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, marshaled) {
		t.Fatalf("kcFrame = %s, encoding/json writes %s", got, marshaled)
	}
	if typ, ok := classifyControl(got); !ok || typ != "kc" {
		t.Fatalf("classifyControl(kcFrame) = %q, %v", typ, ok)
	}
}

// TestParseKC: the value a canonical tag decodes to, and the zero value beside
// every other answer. The parity table (keyCheck rows) and FuzzParseKC hold the
// three kinds across every shape; this pins what comes back with each.
func TestParseKC(t *testing.T) {
	var want [32]byte
	if _, err := rand.Read(want[:]); err != nil {
		t.Fatal(err)
	}
	if got, kind := parseKC(kcFrame(want)); kind != kcTag || got != want {
		t.Fatalf("parseKC(kcFrame) = (%x, %v), want (%x, kcTag)", got, kind, want)
	}
	for name, c := range map[string]struct {
		raw  string
		kind kcKind
	}{
		"not json":        {`{"type":"kc"`, kcNone},
		"ack":             {`{"type":"ack","tag":"` + strings.Repeat("A", 43) + `"}`, kcNone},
		"no tag":          {`{"type":"kc"}`, kcMalformed},
		"short tag":       {`{"type":"kc","tag":"AAAA"}`, kcMalformed},
		"last char bits":  {`{"type":"kc","tag":"` + strings.Repeat("A", 42) + `B"}`, kcMalformed},
		"line break":      {`{"type":"kc","tag":"AAAAAAAAAAAAAAAAAAAAA\r\nAAAAAAAAAAAAAAAAAAAA"}`, kcMalformed},
		"invalid utf-8":   {"{\"type\":\"kc\",\"tag\":\"\xff" + strings.Repeat("A", 42) + "\"}", kcMalformed},
		"lone surrogate":  {`{"type":"kc","tag":"\ud800` + strings.Repeat("A", 42) + `"}`, kcMalformed},
		"over the cap":    {`{"type":"kc","pad":"` + strings.Repeat("x", controlMsgMax) + `"}`, kcNone},
		"json null":       {`null`, kcNone},
		"tag bool":        {`{"type":"kc","tag":false}`, kcMalformed},
		"type is not kc":  {`{"type":["kc"],"tag":"x"}`, kcNone},
		"binary-looking":  {"\x00\xff\x01", kcNone},
		"empty":           {``, kcNone},
		"whitespace only": {"  \n", kcNone},
	} {
		got, kind := parseKC([]byte(c.raw))
		if kind != c.kind {
			t.Errorf("%s: kind = %v, want %v", name, kind, c.kind)
		}
		if got != ([32]byte{}) {
			t.Errorf("%s: a frame that is no tag still returned bytes %x", name, got)
		}
	}
}

// TestKCTagMatches: a frame holding the expected tag matches, and nothing else
// does, a malformed tag or a frame of another type included.
func TestKCTagMatches(t *testing.T) {
	var want [32]byte
	if _, err := rand.Read(want[:]); err != nil {
		t.Fatal(err)
	}
	if !kcTagMatches(kcFrame(want), want) {
		t.Fatal("the right tag did not match")
	}
	other := want
	other[31] ^= 0x10
	if kcTagMatches(kcFrame(other), want) {
		t.Error("a tag one bit away matched")
	}
	for name, raw := range map[string]string{
		"no tag":    `{"type":"kc"}`,
		"malformed": `{"type":"kc","tag":"x"}`,
		"other":     `{"type":"ack","tag":"` + base64.RawURLEncoding.EncodeToString(want[:]) + `"}`,
		"not json":  `garbage`,
	} {
		if kcTagMatches([]byte(raw), want) {
			t.Errorf("%s matched", name)
		}
	}
	// The zero tag is not a way in: a malformed frame parses to the zero value,
	// and an all-zero expected value must still refuse it.
	if kcTagMatches([]byte(`{"type":"kc","tag":"x"}`), [32]byte{}) {
		t.Error("a malformed frame matched an all-zero expected tag")
	}
}

// fakeCerts is what a test hands certHashesFrom in place of a DTLS transport,
// to reach the states a real pion connection never shows.
type fakeCerts struct {
	state     webrtc.DTLSTransportState
	params    webrtc.DTLSParameters
	paramsErr error
	remote    []byte
}

func (f fakeCerts) State() webrtc.DTLSTransportState { return f.state }
func (f fakeCerts) GetLocalParameters() (webrtc.DTLSParameters, error) {
	return f.params, f.paramsErr
}
func (f fakeCerts) GetRemoteCertificate() []byte { return f.remote }

func oneFingerprint(alg, value string) webrtc.DTLSParameters {
	return webrtc.DTLSParameters{Fingerprints: []webrtc.DTLSFingerprint{{Algorithm: alg, Value: value}}}
}

// TestCertHashesFailsClosed walks every way the read can come up short. Each one
// is ErrKeyCheckUnavailable with zero hashes, so a caller holding a key cannot
// proceed on a hash it does not have.
func TestCertHashesFailsClosed(t *testing.T) {
	good := strings.Repeat("ab:", 31) + "ab"
	der := []byte("the remote certificate")
	base := func() fakeCerts {
		return fakeCerts{state: webrtc.DTLSTransportStateConnected, params: oneFingerprint("sha-256", good), remote: der}
	}
	with := func(change func(*fakeCerts)) fakeCerts {
		f := base()
		change(&f)
		return f
	}
	cases := map[string]fakeCerts{
		"new":            with(func(f *fakeCerts) { f.state = webrtc.DTLSTransportStateNew }),
		"connecting":     with(func(f *fakeCerts) { f.state = webrtc.DTLSTransportStateConnecting }),
		"closed":         with(func(f *fakeCerts) { f.state = webrtc.DTLSTransportStateClosed }),
		"failed":         with(func(f *fakeCerts) { f.state = webrtc.DTLSTransportStateFailed }),
		"unknown state":  with(func(f *fakeCerts) { f.state = webrtc.DTLSTransportState(0) }),
		"params error":   with(func(f *fakeCerts) { f.paramsErr = errors.New("no parameters") }),
		"no fingerprint": with(func(f *fakeCerts) { f.params = webrtc.DTLSParameters{} }),
		"two certificates": with(func(f *fakeCerts) {
			f.params.Fingerprints = append(f.params.Fingerprints, webrtc.DTLSFingerprint{Algorithm: "sha-256", Value: good})
		}),
		"sha-1":          with(func(f *fakeCerts) { f.params = oneFingerprint("sha-1", good) }),
		"sha-512":        with(func(f *fakeCerts) { f.params = oneFingerprint("sha-512", good) }),
		"no algorithm":   with(func(f *fakeCerts) { f.params = oneFingerprint("", good) }),
		"not hex":        with(func(f *fakeCerts) { f.params = oneFingerprint("sha-256", strings.Repeat("zz:", 31)+"zz") }),
		"31 bytes":       with(func(f *fakeCerts) { f.params = oneFingerprint("sha-256", strings.Repeat("ab:", 30)+"ab") }),
		"33 bytes":       with(func(f *fakeCerts) { f.params = oneFingerprint("sha-256", strings.Repeat("ab:", 32)+"ab") }),
		"empty value":    with(func(f *fakeCerts) { f.params = oneFingerprint("sha-256", "") }),
		"nil remote":     with(func(f *fakeCerts) { f.remote = nil }),
		"empty remote":   with(func(f *fakeCerts) { f.remote = []byte{} }),
		"zero transport": {},
	}
	for name, f := range cases {
		t.Run(name, func(t *testing.T) {
			local, remote, err := certHashesFrom(f)
			if !errors.Is(err, ErrKeyCheckUnavailable) {
				t.Fatalf("err = %v, want ErrKeyCheckUnavailable", err)
			}
			if local != ([32]byte{}) || remote != ([32]byte{}) {
				t.Fatalf("a failed read returned hashes %x and %x", local, remote)
			}
		})
	}

	// Case and colons do not matter to the fingerprint, in either field, and the
	// DER is only read.
	wantLocal := hex32(t, strings.Repeat("ab", 32))
	for _, f := range []fakeCerts{
		base(),
		with(func(f *fakeCerts) { f.params = oneFingerprint("SHA-256", strings.ToUpper(good)) }),
		with(func(f *fakeCerts) { f.params = oneFingerprint("Sha-256", strings.Repeat("ab", 32)) }),
	} {
		before := bytes.Clone(der)
		local, remote, err := certHashesFrom(f)
		if err != nil {
			t.Fatalf("%v: %v", f.params, err)
		}
		if local != wantLocal {
			t.Errorf("%v: local = %x", f.params, local)
		}
		if remote != sha256.Sum256(der) {
			t.Errorf("%v: remote = %x", f.params, remote)
		}
		if !bytes.Equal(der, before) {
			t.Fatal("the read changed the remote certificate's bytes")
		}
	}
}

// TestCertHashesOfChannelsWithNoConnection: the channel-level cases, with real
// pion objects: nothing at all, a bare value, a channel made on a connection
// that never started, and a real DTLS transport that never started.
func TestCertHashesOfChannelsWithNoConnection(t *testing.T) {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("new connection: %v", err)
	}
	defer pc.Close()
	unstarted, err := pc.CreateDataChannel("floe", nil)
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	for name, dc := range map[string]*webrtc.DataChannel{
		"nil":       nil,
		"bare":      {},
		"unstarted": unstarted,
	} {
		local, remote, err := certHashes(dc)
		if !errors.Is(err, ErrKeyCheckUnavailable) {
			t.Errorf("%s: err = %v, want ErrKeyCheckUnavailable", name, err)
		}
		if local != ([32]byte{}) || remote != ([32]byte{}) {
			t.Errorf("%s: a failed read returned hashes", name)
		}
	}
	transport, err := webrtc.NewAPI().NewDTLSTransport(nil, nil)
	if err != nil {
		t.Fatalf("new DTLS transport: %v", err)
	}
	if _, _, err := certHashesFrom(transport); !errors.Is(err, ErrKeyCheckUnavailable) {
		t.Errorf("an unstarted DTLS transport: err = %v", err)
	}
	if frame, err := LinkKeyProof(unstarted, KeyCheck{RoomID: testRoomID}, true); !errors.Is(err, ErrKeyCheckUnavailable) || frame != nil {
		t.Errorf("LinkKeyProof on an unstarted channel = %q, %v", frame, err)
	}
	if frame, err := LinkKeyProof(nil, KeyCheck{RoomID: testRoomID}, false); !errors.Is(err, ErrKeyCheckUnavailable) || frame != nil {
		t.Errorf("LinkKeyProof on no channel = %q, %v", frame, err)
	}
}

// waitChannel takes the receiver's channel from a pumped pair.
func waitChannel(t *testing.T, recvCh <-chan *webrtc.DataChannel) *webrtc.DataChannel {
	t.Helper()
	select {
	case dc := <-recvCh:
		return dc
	case <-time.After(20 * time.Second):
		t.Fatal("receiver data channel never opened")
		return nil
	}
}

// TestCertHashesAgreeAcrossARealConnection is what the whole check stands on: on
// a real pion connection, what one end hashes as its own certificate is what the
// other end hashes as the remote one, and the reverse, so the two compute hS and
// hR alike. Then a proof built on one end, carried across the channel with the
// framing its direction uses, verifies on the other: TEXT from the file sender,
// BINARY from the file receiver.
func TestCertHashesAgreeAcrossARealConnection(t *testing.T) {
	sender, recvCh, msgs, _, closeFn := newPumpedPair(t)
	defer closeFn()
	receiver := waitChannel(t, recvCh)

	sLocal, sRemote, err := certHashes(sender)
	if err != nil {
		t.Fatalf("certHashes on the sender: %v", err)
	}
	rLocal, rRemote, err := certHashes(receiver)
	if err != nil {
		t.Fatalf("certHashes on the receiver: %v", err)
	}
	if sLocal != rRemote {
		t.Errorf("the sender's own hash %x is not what the receiver read %x", sLocal, rRemote)
	}
	if rLocal != sRemote {
		t.Errorf("the receiver's own hash %x is not what the sender read %x", rLocal, sRemote)
	}
	if sLocal == rLocal {
		t.Error("the two ends have the same certificate, so this test proves nothing")
	}

	key, err := linkkey.New()
	if err != nil {
		t.Fatal(err)
	}
	kc := KeyCheck{Key: key, RoomID: testRoomID}

	// What the receiver expects of the sender, from its own two hashes.
	hS, hR := rRemote, rLocal
	wantSender, err := keyCheckTag(key, kcRoleSender, testRoomID, hS, hR)
	if err != nil {
		t.Fatal(err)
	}
	senderProof, err := LinkKeyProof(sender, kc, true)
	if err != nil {
		t.Fatalf("the sender's proof: %v", err)
	}
	if err := sender.SendText(string(senderProof)); err != nil {
		t.Fatalf("send the sender's proof: %v", err)
	}
	select {
	case m := <-msgs:
		if !m.IsString {
			t.Error("the sender's proof did not arrive as TEXT")
		}
		if typ, ok := classifyControl(m.Data); !ok || typ != "kc" {
			t.Errorf("the sender's proof classified as %q, %v", typ, ok)
		}
		if !kcTagMatches(m.Data, wantSender) {
			t.Error("the sender's proof does not verify on the receiver")
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the sender's proof never arrived")
	}

	// What the sender expects of the receiver, from its own two hashes.
	hS, hR = sLocal, sRemote
	wantReceiver, err := keyCheckTag(key, kcRoleReceiver, testRoomID, hS, hR)
	if err != nil {
		t.Fatal(err)
	}
	replies := watchReplies(sender)
	receiverProof, err := LinkKeyProof(receiver, kc, false)
	if err != nil {
		t.Fatalf("the receiver's proof: %v", err)
	}
	if err := receiver.Send(receiverProof); err != nil {
		t.Fatalf("send the receiver's proof: %v", err)
	}
	select {
	case raw := <-replies:
		if !kcTagMatches(raw, wantReceiver) {
			t.Error("the receiver's proof does not verify on the sender")
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the receiver's proof never arrived")
	}

	// A proof binds all of it. A different key, a different room, or the other
	// side's role each gives a different tag, so a server that relays one side's
	// proof back at it (a reflection) gets nowhere.
	if kcTagMatches(receiverProof, wantSender) {
		t.Error("the receiver's proof verified as the sender's")
	}
	if kcTagMatches(senderProof, wantReceiver) {
		t.Error("the sender's proof verified as the receiver's")
	}
	otherKey, err := linkkey.New()
	if err != nil {
		t.Fatal(err)
	}
	bad, err := LinkKeyProof(sender, KeyCheck{Key: otherKey, RoomID: testRoomID}, true)
	if err != nil {
		t.Fatal(err)
	}
	if kcTagMatches(bad, wantSender) {
		t.Error("a proof under another key verified")
	}
	otherRoom, err := LinkKeyProof(sender, KeyCheck{Key: key, RoomID: strings.ToUpper(testRoomID)}, true)
	if err != nil {
		t.Fatal(err)
	}
	if kcTagMatches(otherRoom, wantSender) {
		t.Error("a proof for another room verified")
	}
	if frame, err := LinkKeyProof(sender, KeyCheck{Key: key}, true); err == nil || frame != nil {
		t.Errorf("a proof with no room id = %q, %v", frame, err)
	}
}

// TestKeyCheckErrorsAreFixedText pins the four sentences a caller matches on,
// and that the receive-side refusal says the same thing the bare error does. A
// fixed sentence carries nothing the peer sent and nothing about the key.
// The stop for a failed check narrows its range to the one rule both languages hold,
// so a released peer misses it and prints its own update remedy, and a current one
// overlaps it and reads the code. These literals are the ones protocol.test.ts pins.
func TestUnverifiedFrameCarriesTheKeyCheckRange(t *testing.T) {
	if got := string(incompatibleFrame("", CodeUnverified, senderUnverifiedReason, -1)); got != `{"type":"incompatible","reason":"sender could not confirm the receiver holds this link","pv":2,"pvMin":2,"code":"unverified"}` {
		t.Errorf("sender's frame: %s", got)
	}
	if got := string(incompatibleFrame("", CodeUnverified, CodeUnverified.WireReason(), 0)); got != `{"type":"incompatible","reason":"receiver could not confirm the sender holds this link","pv":2,"pvMin":2,"code":"unverified","saved":0}` {
		t.Errorf("receiver's frame: %s", got)
	}

	// Through the reader a current peer uses: the range overlaps and the code survives.
	var stop *PeerStoppedError
	if err := abortFromPeer(incompatibleFrame("", CodeUnverified, CodeUnverified.WireReason(), 0), "", "", 1); !errors.As(err, &stop) || stop.Code != CodeUnverified {
		t.Errorf("a current peer reads %v (%T), want a PeerStoppedError with the code", err, err)
	}

	// Every other code keeps the full range.
	var other incompatibleMsg
	if err := json.Unmarshal(incompatibleFrame("", CodeDeclined, CodeDeclined.WireReason(), 0), &other); err != nil {
		t.Fatal(err)
	}
	if other.Pv != ProtocolVersion || other.PvMin != MinProtocolVersion {
		t.Errorf("declined carries [%d,%d], want the full range", other.PvMin, other.Pv)
	}
}

// hmac.Equal, not ==: comparing the arrays would behave the same in every test here
// and leak where the first wrong byte is. TS pins its loop by counting reads.
func TestKCTagCompareIsConstantTime(t *testing.T) {
	src, err := os.ReadFile("keycheck.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(src), "hmac.Equal(tag[:], want[:])") {
		t.Error("kcTagMatches no longer compares through hmac.Equal")
	}
}

func TestKeyCheckErrorsAreFixedText(t *testing.T) {
	for _, c := range []struct {
		err  error
		want string
	}{
		{ErrReceiverNotConfirmed, "the receiver could not prove it holds this link's key, so nothing was sent"},
		{ErrReceiverSilent, "the receiver sent no proof of this link's key in time, so nothing was sent"},
		{ErrSenderNotConfirmed, "receive stopped: the sender could not be confirmed, so nothing was saved"},
		{ErrKeyCheckUnavailable, "this connection's certificates could not be read to check the link's key"},
	} {
		if c.err.Error() != c.want {
			t.Errorf("error text = %q, want %q", c.err, c.want)
		}
	}
	refused := &RefusedError{Code: CodeUnverified, Err: ErrSenderNotConfirmed}
	if refused.Error() != ErrSenderNotConfirmed.Error() {
		t.Errorf("RefusedError = %q, want the ErrSenderNotConfirmed sentence", refused)
	}
	if !errors.Is(refused, ErrSenderNotConfirmed) {
		t.Error("errors.Is cannot find ErrSenderNotConfirmed in the refusal")
	}
}

// TestKeyCheckNeverPrintsItsKey: the struct a caller passes around is safe to
// print and refuses to marshal, so a log line or a stored copy of it cannot carry
// the key, and neither can any error this file returns.
func TestKeyCheckNeverPrintsItsKey(t *testing.T) {
	key, err := linkkey.New()
	if err != nil {
		t.Fatal(err)
	}
	text := key.Encode()
	kc := KeyCheck{Key: key, RoomID: testRoomID, Enforce: true}
	for _, verb := range []string{"%v", "%+v", "%#v", "%s", "%d", "%x", "%q"} {
		got := fmt.Sprintf(verb, kc)
		if strings.Contains(got, text) || strings.Contains(got, hex.EncodeToString(key[:])) {
			t.Errorf("Sprintf(%q, KeyCheck) shows the key: %s", verb, got)
		}
		if strings.Contains(got, fmt.Sprint(int(key[0]), " ", int(key[1]), " ", int(key[2]))) {
			t.Errorf("Sprintf(%q, KeyCheck) shows the key's bytes: %s", verb, got)
		}
	}
	if b, err := json.Marshal(kc); err == nil {
		t.Errorf("json.Marshal(KeyCheck) = %s, want an error", b)
	}
	// A failure on any path names no key.
	if _, err := LinkKeyProof(nil, kc, true); err == nil || strings.Contains(err.Error(), text) {
		t.Errorf("LinkKeyProof(nil) = %v", err)
	}
	var hS, hR [32]byte
	if _, err := keyCheckTag(key, kcRoleSender, "", hS, hR); err == nil || strings.Contains(err.Error(), text) {
		t.Errorf("keyCheckTag with no room = %v", err)
	}
}

// TestKeylessReceiverDropsKC is the receiver half of "a receiver without k
// ignores an incoming kc": a real receive with no key, handed a keyed sender's
// TEXT kc before the metadata, a second one between the frames, and even a
// malformed one, saves the file exactly as it always did.
func TestKeylessReceiverDropsKC(t *testing.T) {
	sender, recvCh, msgs, closed, closeFn := newPumpedPair(t)
	defer closeFn()
	receiver := waitChannel(t, recvCh)

	src := filepath.Join(t.TempDir(), "keyed.bin")
	payload := make([]byte, 64*1024)
	if _, err := rand.Read(payload); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(src, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, frame := range []string{string(kcFrame([32]byte{1})), `{"type":"kc"}`, string(kcFrame([32]byte{2}))} {
		if err := sender.SendText(frame); err != nil {
			t.Fatalf("send a kc frame: %v", err)
		}
	}

	sendErr := make(chan error, 1)
	go func() {
		err := SendFiles(sender, []string{src}, "test-ver")
		_ = sender.Close()
		sendErr <- err
	}()
	outDir := t.TempDir()
	recvErr := make(chan error, 1)
	go func() {
		recvErr <- ReceiveFilesWithOptions(receiver, outDir, true, "", "", ReceiveOptions{Messages: msgs, Closed: closed})
	}()
	for name, ch := range map[string]chan error{"receive": recvErr, "send": sendErr} {
		select {
		case err := <-ch:
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
		case <-time.After(60 * time.Second):
			t.Fatalf("%s did not finish", name)
		}
	}
	got, err := os.ReadFile(filepath.Join(outDir, "keyed.bin"))
	if err != nil {
		t.Fatalf("read the saved file: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatal("the saved bytes differ from what was sent")
	}
	// The kc frames went nowhere near the file: nothing else is in the folder.
	entries, err := os.ReadDir(outDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("the save folder holds %d entries, want the one file", len(entries))
	}
}

// TestSenderWithoutTheCheckIgnoresKC is the sender half: a send that is not
// checking anything, which is what every released sender and an unwired build
// are, reads a receiver's BINARY kc as one more frame that is not its ack.
func TestSenderWithoutTheCheckIgnoresKC(t *testing.T) {
	sender, recvCh, msgs, closed, closeFn := newPumpedPair(t)
	defer closeFn()
	receiver := waitChannel(t, recvCh)
	senderMsgs, senderClosed := pumpChannel(sender, nil)

	src := filepath.Join(t.TempDir(), "keyed.bin")
	payload := make([]byte, 32*1024)
	if _, err := rand.Read(payload); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(src, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := receiver.Send(kcFrame([32]byte{3})); err != nil {
		t.Fatalf("send the receiver's kc: %v", err)
	}

	sendErr := make(chan error, 1)
	go func() {
		err := SendFilesWithOptions(sender, []string{src}, "test-ver", SendOptions{Messages: senderMsgs, Closed: senderClosed})
		_ = sender.Close()
		sendErr <- err
	}()
	outDir := t.TempDir()
	if err := ReceiveFilesWithOptions(receiver, outDir, true, "", "", ReceiveOptions{Messages: msgs, Closed: closed}); err != nil {
		t.Fatalf("receive: %v", err)
	}
	select {
	case err := <-sendErr:
		if err != nil {
			t.Fatalf("send: %v", err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("send did not finish")
	}
	got, err := os.ReadFile(filepath.Join(outDir, "keyed.bin"))
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("the saved file differs: %v", err)
	}
}
