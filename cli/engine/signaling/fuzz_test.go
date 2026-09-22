package signaling

// Fuzz targets for the two decoders this package owns (DV-FUZZ):
// FuzzDecodeServerMessage drives dispatch, the decoder of every frame the
// signaling server sends, and FuzzRoomIDFromToken the host-token
// derivation. Both are pure: no socket and no disk. The seeds are added with
// f.Add and the same values are committed under testdata/fuzz/Fuzz<Name>/
// so the corpus directories exist in git; FLOE_WRITE_FUZZ_SEEDS=1
// go test -run '^Fuzz' . rewrites those files, and nothing else here writes.

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// writeSeed writes one corpus file in the go test fuzz v1 encoding when
// FLOE_WRITE_FUZZ_SEEDS=1.
func writeSeed(f *testing.F, target, name, line string) {
	f.Helper()
	if os.Getenv("FLOE_WRITE_FUZZ_SEEDS") != "1" {
		return
	}
	dir := filepath.Join("testdata", "fuzz", target)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		f.Fatalf("seed dir: %v", err)
	}
	body := "go test fuzz v1\n" + line + "\n"
	if err := os.WriteFile(filepath.Join(dir, "seed-"+name), []byte(body), 0o644); err != nil {
		f.Fatalf("seed %s: %v", name, err)
	}
}

// seedName turns a description into a file-name-safe seed name.
func seedName(s string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
			return r
		case r >= 'A' && r <= 'Z':
			return r + ('a' - 'A')
		}
		return '-'
	}, s)
}

// drainOne takes at most one value from each of c's channels and returns
// what it found, keyed by channel name.
func drainOne(c *Client) map[string]string {
	got := map[string]string{}
	select {
	case v := <-c.Role:
		got["Role"] = v
	default:
	}
	select {
	case v := <-c.PeerConnected:
		got["PeerConnected"] = v
	default:
	}
	select {
	case v := <-c.Signal:
		got["Signal"] = string(v)
	default:
	}
	select {
	case <-c.PeerLeft:
		got["PeerLeft"] = ""
	default:
	}
	select {
	case <-c.RoomFull:
		got["RoomFull"] = ""
	default:
	}
	select {
	case v := <-c.Errors:
		got["Errors"] = v
	default:
	}
	select {
	case v := <-c.Refused:
		got["Refused"] = v
	default:
	}
	select {
	case <-c.HostAbsent:
		got["HostAbsent"] = ""
	default:
	}
	select {
	case <-c.Disabled:
		got["Disabled"] = ""
	default:
	}
	return got
}

// FuzzDecodeServerMessage: dispatch never panics, never closes Down, moves
// at most one channel per frame, ignores unknown types and every frame that
// does not decode, and routes each known type to its own channel with the
// field it carries (a role passed through as a string, never interpreted).
func FuzzDecodeServerMessage(f *testing.F) {
	seeds := map[string][]byte{
		"room-joined host":        []byte(`{"type":"room-joined","role":"host"}`),
		"room-joined sender":      []byte(`{"type":"room-joined","role":"sender"}`),
		"request-joined visitor":  []byte(`{"type":"request-joined","role":"visitor"}`),
		"refused disabled":        []byte(`{"type":"refused","code":"disabled"}`),
		"refused limited":         []byte(`{"type":"refused","code":"limited"}`),
		"refused future":          []byte(`{"type":"refused","code":"future-code"}`),
		"refused null code":       []byte(`{"type":"refused","code":null}`),
		"host-absent":             []byte(`{"type":"host-absent"}`),
		"disabled":                []byte(`{"type":"disabled"}`),
		"room-full":               []byte(`{"type":"room-full"}`),
		"peer-disconnected":       []byte(`{"type":"peer-disconnected"}`),
		"user-connected":          []byte(`{"type":"user-connected","id":"p1"}`),
		"signal offer":            []byte(`{"type":"signal","signal":{"type":"offer","sdp":"v=0"}}`),
		"signal empty":            []byte(`{"type":"signal"}`),
		"error host token":        []byte(`{"type":"error","message":"Invalid host token"}`),
		"pong":                    []byte(`{"type":"pong"}`),
		"key case":                []byte(`{"TYPE":"refused","CODE":"disabled"}`),
		"duplicate type":          []byte(`{"type":"pong","type":"refused","code":"x"}`),
		"8 KB unknown":            []byte(`{"type":"x","pad":"` + strings.Repeat("p", 8<<10) + `"}`),
		"deep nesting in a field": []byte(`{"type":"refused","code":` + strings.Repeat("[", 12000) + `}`),
	}
	// The hostile frames small enough to commit; the 1 MB and 100 K-deep ones
	// run in TestMalformedServerFramesDoNotPanic instead.
	for name, raw := range hostileFrames() {
		if len(raw) <= 16<<10 {
			seeds["hostile "+name] = raw
		}
	}
	names := make([]string, 0, len(seeds))
	for name := range seeds {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		f.Add(seeds[name])
		writeSeed(f, "FuzzDecodeServerMessage", seedName(name), "[]byte("+strconv.Quote(string(seeds[name]))+")")
	}

	route := map[string]string{
		"room-joined":       "Role",
		"request-joined":    "Role",
		"user-connected":    "PeerConnected",
		"signal":            "Signal",
		"peer-disconnected": "PeerLeft",
		"room-full":         "RoomFull",
		"error":             "Errors",
		"refused":           "Refused",
		"host-absent":       "HostAbsent",
		"disabled":          "Disabled",
	}

	f.Fuzz(func(t *testing.T, raw []byte) {
		c := newClient(nil, config{})
		c.dispatch(raw)

		select {
		case <-c.Down:
			t.Fatal("dispatch closed Down")
		default:
		}
		got := drainOne(c)
		if len(got) > 1 {
			t.Fatalf("one frame moved %d channels: %v", len(got), got)
		}

		var m Message
		if err := json.Unmarshal(raw, &m); err != nil {
			if len(got) != 0 {
				t.Fatalf("a frame that does not decode moved %v", got)
			}
			return
		}
		want, known := route[m.Type]
		if !known || (m.Type == "signal" && len(m.Signal) == 0) {
			if len(got) != 0 {
				t.Fatalf("type %q moved %v", m.Type, got)
			}
			return
		}
		v, ok := got[want]
		if !ok {
			t.Fatalf("type %q moved %v, want %s", m.Type, got, want)
		}
		var field string
		switch want {
		case "Role":
			field = m.Role
		case "PeerConnected":
			field = m.ID
		case "Signal":
			field = string(m.Signal)
		case "Errors":
			field = m.Msg
		case "Refused":
			field = m.Code
		}
		if v != field {
			t.Fatalf("%s carried %d bytes, want the frame's %d", want, len(v), len(field))
		}
	})
}

// roomIDSprintf is a second formulation of the derivation for the fuzz
// property: the same formula written with Sprintf over byte slices, so a
// slicing or nibble mistake in one of the two shows as a disagreement.
func roomIDSprintf(hostToken string) string {
	sum := sha256.Sum256([]byte("floe-request-room-v1:" + hostToken))
	b := sum[:16]
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// FuzzRoomIDFromToken: never panics; a token that is not 43 base64url
// characters derives ""; any other token derives a lowercase v4 UUID, the
// same one twice, the same one the second formulation gives; and the three
// server vectors hold.
func FuzzRoomIDFromToken(f *testing.F) {
	v := loadDerivationVectors(f)
	good := strings.Repeat("A", 43)
	seeds := map[string]string{
		"vector 0":          v.Vectors[0].HostToken,
		"vector 1":          v.Vectors[1].HostToken,
		"vector 2":          v.Vectors[2].HostToken,
		"42 characters":     good[:42],
		"44 characters":     good + "A",
		"non-base64url":     good[:41] + "+/",
		"padding":           good[:42] + "=",
		"empty":             "",
		"trailing newline":  good + "\n",
		"non-ASCII":         good[:42] + "é",
		"uuid-shaped input": "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f",
	}
	names := make([]string, 0, len(seeds))
	for name := range seeds {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		f.Add(seeds[name])
		writeSeed(f, "FuzzRoomIDFromToken", seedName(name), "string("+strconv.Quote(seeds[name])+")")
	}
	vectors := map[[32]byte]string{}
	for _, vec := range v.Vectors {
		vectors[sha256.Sum256([]byte(vec.HostToken))] = vec.RoomID
	}

	f.Fuzz(func(t *testing.T, tok string) {
		got := RoomIDFromToken(tok)
		if !HostTokenRegexp.MatchString(tok) {
			if got != "" {
				t.Fatalf("a malformed token derived %q", got)
			}
			return
		}
		if !uuidV4Shape.MatchString(got) {
			t.Fatalf("derived %q, not a lowercase v4 UUID", got)
		}
		if again := RoomIDFromToken(tok); again != got {
			t.Fatalf("not deterministic: %q then %q", got, again)
		}
		if other := roomIDSprintf(tok); other != got {
			t.Fatalf("the second formulation gives %q, RoomIDFromToken %q", other, got)
		}
		if want, ok := vectors[sha256.Sum256([]byte(tok))]; ok && got != want {
			t.Fatalf("a server vector derived %q, want %q", got, want)
		}
	})
}
