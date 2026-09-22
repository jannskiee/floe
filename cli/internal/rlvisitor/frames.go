package main

// The frames a hostile request-link visitor puts on the wire, as pure
// builders so each shape is a unit test (WP-Q, the S1-DSK-08a CELL-07 and
// CELL-13 cells). The names, sizes and paths here are the D-033 hostile
// fixtures S1-ENG-03 defines (the baseline pairing spike's F2, F4b, F5, F6),
// plus the junk flood, the abort reason and the hostile display name.
//
// Nothing here reads a file or the network; the wiring that sends them is in
// run.go. Every builder produces bytes only, so no secret, token or room
// fragment can pass through it.

import (
	"encoding/json"

	"github.com/google/uuid"
)

// The wire is the engine's, unchanged: metadata is one JSON object with these
// fields (transfer/sender.go metadataMsg). protocol version 1, both.
const (
	protocolVersion    = 1
	minProtocolVersion = 1
)

// maxAnnouncedSize mirrors transfer.maxAnnouncedSize (Number.MAX_SAFE_INTEGER):
// the receiver refuses a byte count above it. F5 announces exactly it, the
// largest value the receiver still accepts as a number.
const maxAnnouncedSize int64 = 1<<53 - 1

// metaFields is the metadata frame, matching transfer/sender.go's metadataMsg
// tags so the real receiver parses it.
type metaFields struct {
	Type       string `json:"type"`
	ID         string `json:"id"`
	FileName   string `json:"fileName"`
	FileSize   int64  `json:"fileSize"`
	Index      int    `json:"index"`
	Total      int    `json:"total"`
	TotalBytes int64  `json:"totalBytes"`
	Pv         int    `json:"pv"`
	PvMin      int    `json:"pvMin"`
}

// metaFrame builds one metadata frame. id is passed in so a test can pin it;
// runtime callers pass a fresh uuid. totalBytes is the announced batch size
// and is set to fileSize for a one-file drop.
func metaFrame(id, name string, size int64, index, total int, totalBytes int64) []byte {
	m := metaFields{
		Type: "metadata", ID: id, FileName: name, FileSize: size,
		Index: index, Total: total, TotalBytes: totalBytes,
		Pv: protocolVersion, PvMin: minProtocolVersion,
	}
	b, _ := json.Marshal(m)
	return b
}

// oneFileMeta is metaFrame for a single announced file: index 1 of 1, the
// batch size equal to the file size.
func oneFileMeta(name string, size int64) []byte {
	return metaFrame(uuid.NewString(), name, size, 1, 1, size)
}

// The hostile metadata shapes, the D-033 fixtures. Each is one metadata frame
// the receiver must refuse before it prompts the owner or creates anything.
const (
	// F2: a 40-level relative path (the spike created 40 nested directories).
	f2Depth = 40
	// F4b: an absolute Windows path (the spike wrote Windows/System32 under
	// the save folder).
	f4bPath = `C:\Windows\System32\evil.dll`
	// F6: a 704-byte single-component name, over the 240 UTF-16 path unit
	// limit but under the 1000-byte control-frame cap.
	f6NameLen = 704
)

// f2Name is the 40-level path fixture: "d/" forty times then "deep.txt".
func f2Name() string {
	name := ""
	for i := 0; i < f2Depth; i++ {
		name += "d/"
	}
	return name + "deep.txt"
}

// f6Name is the 704-byte single-component name fixture.
func f6Name() string {
	b := make([]byte, f6NameLen)
	for i := range b {
		b[i] = 'a'
	}
	return string(b)
}

// hostileMetaFrame builds the crafted metadata frame for one fixture kind, or
// reports an unknown kind so a typo fails at start. A tiny real size is used
// where the fixture is about the name or the path, and the announced-size
// fixtures (F5) use a one-byte name so only the size is hostile.
func hostileMetaFrame(kind string) ([]byte, bool) {
	switch kind {
	case "f2":
		return oneFileMeta(f2Name(), 4), true
	case "f4b":
		return oneFileMeta(f4bPath, 4), true
	case "f5":
		return oneFileMeta("a.bin", maxAnnouncedSize), true
	case "f6":
		return oneFileMeta(f6Name(), 4), true
	}
	return nil, false
}

// hostileMetaKinds are the fixture kinds -hostile-meta accepts.
var hostileMetaKinds = map[string]bool{"f2": true, "f4b": true, "f5": true, "f6": true}

// hostileDisplayName is the -hostile-name file name: markup, a shell
// substitution and a right-to-left override, so the owner's UI must render a
// cleaned name and never execute or reorder it. It is a real, sanitizable
// name (no path separator), the CELL-07 "cleaned names after Accept" case.
const rlo = "\u202e"

func hostileDisplayName() string {
	return "<img src=x onerror=alert(1)> $(calc)" + rlo + "safe.txt"
}

// oversizeRelayMeta is the metadata a -skip-relay-gate visitor announces to
// force the host's relay-cap refusal: one file just over the 2 GiB relay cap
// (RelaySizeLimit is 2 GiB; strictly greater is blocked), so the host refuses
// on a relay path before any byte moves.
const relaySizeLimit int64 = 2 * 1024 * 1024 * 1024

func oversizeRelayMeta() []byte {
	return oneFileMeta("relay-cap.bin", relaySizeLimit+1)
}

// abortFrame is the visitor's own abort: an incompatible frame carrying a
// chosen reason, the shape transfer/control.go's abortReason writes. The host
// must show only fixed copy and never the reason text.
func abortFrame(reason string) []byte {
	b, _ := json.Marshal(map[string]interface{}{
		"type":   "incompatible",
		"reason": reason,
		"pv":     protocolVersion,
		"pvMin":  minProtocolVersion,
	})
	return b
}

// junkFrames is a flood of control-shaped junk: JSON objects the receiver
// classifies and drops. A hostile visitor sends these to see whether the host
// stays bounded; the receiver's junk-frame deadline (S1-ENG-06) ends it.
func junkFrames(n int) [][]byte {
	frames := make([][]byte, 0, n)
	for i := 0; i < n; i++ {
		b, _ := json.Marshal(map[string]interface{}{
			"type": "junk",
			"n":    i,
			"pad":  "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
		})
		frames = append(frames, b)
	}
	return frames
}

// badSDPSignal is the malformed answer a -bad-sdp visitor sends in place of a
// real SDP answer: a well-formed signal envelope whose sdp is not an SDP, so
// the host's SetRemoteDescription refuses it and the host reports a fixed
// setup error, never the text.
func badSDPSignal() map[string]interface{} {
	return map[string]interface{}{"type": "answer", "sdp": "not-an-sdp\r\n"}
}
