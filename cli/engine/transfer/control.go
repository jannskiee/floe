package transfer

// Control-frame classification and the metadata parser: everything that decides
// what an inbound frame IS, before the receive loop acts on it.

import (
	"encoding/json"
	"fmt"
	"math"
	"time"

	"github.com/pion/webrtc/v4"
)

// controlFlushTimeout bounds flushControl. Long enough for a SACK to come back
// over a relay, short enough that nobody notices it on the way out.
const controlFlushTimeout = 2 * time.Second

// abortReason tells the peer why this side is stopping on purpose, in the one
// frame every peer already knows how to display: an "incompatible" whose pv
// range OVERLAPS ours.
//
// That overlap is load-bearing, and it is why this needs no new message type
// and no ProtocolVersion bump. compatErrorFromIncompatible rebuilds the message
// from pv/pvMin only when the ranges genuinely miss; because ours overlap it
// falls through to Reason and prints it verbatim, instead of telling the reader
// to run "floe update". The browser sender does the same through
// sanitizeDisplayText. So the person at the other end reads the actual reason
// rather than the "connection closed while waiting for the receiver" a bare
// close produces.
//
// toReceiver picks the framing, and that is not a style choice. Receiver to
// sender carries no file data, so binary is safe and is what every shipped
// receiver already sends. Sender to receiver MUST be text: on that path a
// binary frame is file data by definition (see the ReceiveFiles message loop),
// and shipped Go receivers from v1.1.0 to v1.5.5 would write a binary one
// straight into somebody's file.
//
// Best effort. A failed send changes nothing, because the caller's deferred
// Close reaches the peer either way.
func abortReason(dc *webrtc.DataChannel, localVer, reason string, toReceiver bool) {
	if dc == nil {
		return // nobody to tell; the relay gate runs against a nil channel in tests
	}
	msg := incompatibleMsg{
		Type:   "incompatible",
		Reason: reason,
		Pv:     ProtocolVersion,
		PvMin:  MinProtocolVersion,
		Ver:    localVer,
	}
	// The cap is on the ENCODED FRAME, not the reason: a browser receiver stops
	// classifying a control message past controlMsgMax and would read the frame
	// as file data. Halving a rune budget terminates and never splits a
	// character, which a byte cut would.
	encoded, _ := json.Marshal(msg)
	for budget := maxDisplayReason; len(encoded) > controlMsgMax && budget > 0; budget /= 2 {
		msg.Reason = displayText(reason, budget)
		encoded, _ = json.Marshal(msg)
	}
	if len(encoded) > controlMsgMax {
		msg.Reason = ""
		encoded, _ = json.Marshal(msg)
	}
	if toReceiver {
		_ = dc.SendText(string(encoded))
	} else {
		_ = dc.Send(encoded)
	}
	flushControl(dc)
}

// rejectDescription is abortReason for the case that had it first: a file
// description this receiver will not accept.
func rejectDescription(dc *webrtc.DataChannel, localVer, detail string) {
	abortReason(dc, localVer, "receiver rejected the file description: "+detail, false)
}

// flushControl waits for the SCTP send buffer to drain before the caller's
// teardown runs.
//
// Without it the message is routinely lost (#284: lost in 6 of 6 rounds on one
// machine state and delivered on another, so it is load-dependent). pion's
// Close stops the SCTP transport and aborts the association, and
// gatherOutboundPriorityPackets then suppresses whatever DATA was still queued.
// The peer sees the drop and reports a closed connection rather than the
// reason, which is the wrong cause dressed up as a network fault.
//
// Bounded and best effort: a peer that never acknowledges must not hold the
// teardown open, and a reason lost at the deadline is no worse than today.
func flushControl(dc *webrtc.DataChannel) {
	if dc == nil {
		return
	}
	deadline := time.After(controlFlushTimeout)
	for dc.BufferedAmount() > 0 {
		select {
		case <-deadline:
			return
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// controlMsgMax is the largest message probed as a control message, string or
// binary, matching the browser's CONTROL_MSG_MAX. A real control message is a
// few hundred bytes at most, so anything past this is either file data or a
// peer sending prose where a control message belongs.
const controlMsgMax = 1000

// classifyControl reports whether a frame's BYTES are a Floe control message
// and, if so, its type. It answers a question about content only; whether a
// frame is eligible to be control at all is the caller's to answer, and on the
// receive path the answer is framing: see the ReceiveFiles message loop, which
// calls this for string frames only.
//
// Control messages are JSON objects and are capped at controlMsgMax. The cap
// applies here regardless of framing, because without it a peer could hand
// parseMetadata a file name bounded by nothing but pion's 1 GB default. The
// receive loop rejects an over-cap string with an error before this runs.
//
// A message is treated as control ONLY when it parses as a JSON object whose
// "type" is a known control type, so a JSON file whose "type" is something
// else was already safe. What was not safe, and is what the framing gate on
// the receive path fixes, is a JSON file whose "type" IS one of these.
//
// The receiver only acts on "metadata" and "end". The other recognized types
// ("ack", "received", "incompatible") flow in the opposite direction and are
// recognized here for the sender-side loops, which read this direction and
// carry no file data.
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
