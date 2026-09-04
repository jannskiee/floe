package transfer

// Control-frame classification and the metadata parser: everything that decides
// what an inbound frame IS, before the receive loop acts on it.

import (
	"encoding/json"
	"fmt"
	"math"

	"github.com/pion/webrtc/v4"
)

// rejectDescription tells the sender why its file description was refused, in
// the one frame every sender already knows how to display: an "incompatible"
// whose pv range overlaps ours. The Go sender prints its Reason through
// compatErrorFromIncompatible (display-safe and capped there) and the browser
// hands it to the error banner, so the person at the sending end reads the
// actual reason instead of the "connection closed while waiting for the
// receiver" that the close alone would produce. Best effort: a failed send
// changes nothing, because the caller's deferred Close reaches the sender
// either way.
func rejectDescription(dc *webrtc.DataChannel, localVer, detail string) {
	msg, _ := json.Marshal(incompatibleMsg{
		Type:   "incompatible",
		Reason: "receiver rejected the file description: " + detail,
		Pv:     ProtocolVersion,
		PvMin:  MinProtocolVersion,
		Ver:    localVer,
	})
	_ = dc.Send(msg)
}

// controlMsgMax is the largest message probed as a control message, string or
// binary, matching the browser's CONTROL_MSG_MAX. A real control message is a
// few hundred bytes at most, so anything past this is either file data or a
// peer sending prose where a control message belongs.
const controlMsgMax = 1000

// classifyControl reports whether a data channel message is a Floe control
// message and, if so, its type.
//
// Control messages are JSON objects. The browser (SimplePeer) sends them as
// strings, but depending on SCTP framing they can also arrive as small binary
// messages, so binary payloads are probed too. The size probe applies to
// string and binary alike (matching the browser's `data.byteLength <= 1000`
// guard, which never asks about framing): the Floe sender uses SendText for
// its metadata, so the old binary-only gate left strings bounded by nothing
// but pion's 1 GB default and let a hostile peer hand parseMetadata a file
// name of any length. The message loop rejects an over-cap STRING with an
// error before this runs; an over-cap BINARY lands here and is file data.
// Crucially, a message is treated as control ONLY when it parses as a JSON
// object whose "type" is a known control type. Anything else, including a
// small file whose bytes happen to be a JSON object, is file data and must be
// written, not dropped.
//
// The receiver only acts on "metadata" and "end". The other recognized types
// ("ack", "received", "incompatible") flow in the opposite direction; they are
// classified as control so they are never mistakenly written as file data if
// they somehow arrive on this side.
func classifyControl(data []byte) (msgType string, isControl bool) {
	if len(data) > controlMsgMax {
		return "", false
	}
	if !looksLikeJSONObject(data) {
		return "", false
	}
	var base map[string]interface{}
	if err := json.Unmarshal(data, &base); err != nil {
		return "", false
	}
	t, _ := base["type"].(string)
	switch t {
	case "metadata", "end", "ack", "received", "incompatible":
		return t, true
	}
	return "", false
}

// looksLikeJSONObject reports whether data's first non-whitespace byte is '{',
// a cheap pre-check (mirroring the browser's `text.startsWith('{')`) that avoids
// a full JSON parse attempt on raw binary chunks.
func looksLikeJSONObject(data []byte) bool {
	for _, b := range data {
		switch b {
		case ' ', '\t', '\r', '\n':
			continue
		case '{':
			return true
		default:
			return false
		}
	}
	return false
}

// maxAnnouncedSize bounds fileSize and totalBytes at 2^53-1, the browser's
// Number.MAX_SAFE_INTEGER guard in normalizeFileSize: above it the JSON number
// was not exact where it was written, and above 2^63 the float64 to int64
// conversion yields MinInt64 on amd64, so 1e300 used to arrive as a negative
// size and crash formatBytes.
const maxAnnouncedSize = 1<<53 - 1

// byteCount validates one peer-supplied size. Zero is a real size and passes.
func byteCount(field string, v float64) (int64, error) {
	if v < 0 || v > maxAnnouncedSize || v != math.Trunc(v) {
		return 0, fmt.Errorf("%s %v is not a byte count", field, v)
	}
	return int64(v), nil
}

// parseMetadata extracts FileInfo from a raw metadata JSON string. The numbers
// are validated here, at the one place they enter, so no later caller has to
// wonder whether a size is negative or a position is zero.
func parseMetadata(text string) (FileInfo, error) {
	var m struct {
		Type       string  `json:"type"`
		ID         string  `json:"id"`
		FileName   string  `json:"fileName"`
		FileSize   float64 `json:"fileSize"` // JSON numbers decode as float64
		Index      int     `json:"index"`
		Total      int     `json:"total"`
		TotalBytes float64 `json:"totalBytes"` // absent from older senders → 0
		Pv         int     `json:"pv"`         // absent from older senders → 0 (treated as 1)
		PvMin      int     `json:"pvMin"`      // absent from older senders → 0 (treated as 1)
		Ver        string  `json:"ver"`        // absent from older senders → ""
	}
	if err := json.Unmarshal([]byte(text), &m); err != nil {
		return FileInfo{}, err
	}
	if m.Type != "metadata" {
		return FileInfo{}, fmt.Errorf("not a metadata message")
	}
	fileSize, err := byteCount("file size", m.FileSize)
	if err != nil {
		return FileInfo{}, err
	}
	totalBytes, err := byteCount("batch size", m.TotalBytes)
	if err != nil {
		return FileInfo{}, err
	}
	if m.Index < 1 || m.Total < 1 {
		return FileInfo{}, fmt.Errorf("file index %d of %d is not a position in a batch", m.Index, m.Total)
	}
	// Zero means "not announced" (pre-1.6.0 senders) and is fine; a batch that
	// is smaller than one of its own files is not, and the desktop preview
	// would show it as the batch size ("1 B" for a 5 GB file).
	if totalBytes > 0 && totalBytes < fileSize {
		return FileInfo{}, fmt.Errorf("batch size %d is smaller than the file size %d", totalBytes, fileSize)
	}
	return FileInfo{
		ID:         m.ID,
		FileName:   m.FileName,
		FileSize:   fileSize,
		Index:      m.Index,
		Total:      m.Total,
		TotalBytes: totalBytes,
		Pv:         m.Pv,
		PvMin:      m.PvMin,
		Ver:        m.Ver,
	}, nil
}
