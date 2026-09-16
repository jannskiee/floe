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
	sendIncompatible(dc, incompatibleFrame(localVer, "", reason, -1), toReceiver)
}

// RefusalCode names why a receiver stopped a transfer on purpose. It rides the
// incompatible frame as the optional "code", so a reader can pick its own
// fixed copy instead of showing the peer's prose. The set is closed: a reader
// maps anything it does not know to its generic stopped copy.
type RefusalCode string

// The Phase 0 codes. Stage 1 adds the rest of the table (declined, expired,
// disk-full and so on); client/lib/transfer/protocol.ts REFUSAL_CODES mirrors
// this list and must stay in sync.
const (
	// CodeWriteFailed: a flush, close or write failed on this side's own file
	// handle. The in-flight .part is removed.
	CodeWriteFailed RefusalCode = "write-failed"
	// CodeHashMismatch: a file's bytes did not match the SHA-256 the sender
	// computed, or the hash it sent was malformed. The .part is removed before
	// it ever gets a final name.
	CodeHashMismatch RefusalCode = "hash-mismatch"
)

// AbortWithCode is abortReason for a receiver that knows WHY it stopped: the
// same overlapping-range incompatible frame, plus a code and, when saved is
// not negative, the number of files this side committed under final names
// before stopping.
//
// Receiver to sender only, so the frame is BINARY (abortReason explains why
// binary is safe in that direction and never in the other). reason is shown
// verbatim by peers that predate code, so write it surface-neutral and name no
// path.
// Flushes for up to controlFlushTimeout before returning, so call it before
// the caller's Close.
func AbortWithCode(dc *webrtc.DataChannel, localVer string, code RefusalCode, reason string, saved int) {
	sendIncompatible(dc, incompatibleFrame(localVer, code, reason, saved), false)
}

// incompatibleFrame encodes an overlapping-range incompatible frame that fits
// controlMsgMax. A negative saved omits the field, and an empty code omits
// code, which is exactly the frame abortReason has always sent.
//
// The cap is on the ENCODED FRAME, not the reason: a browser receiver stops
// classifying a control message past controlMsgMax and would read the frame
// as file data. Only the reason shrinks. Code and saved are what a current
// reader acts on and cost at most about 45 bytes, so they are never dropped to
// make room. Halving a rune budget terminates and never splits a character,
// which a byte cut would.
func incompatibleFrame(localVer string, code RefusalCode, reason string, saved int) []byte {
	msg := incompatibleMsg{
		Type:   "incompatible",
		Reason: reason,
		Pv:     ProtocolVersion,
		PvMin:  MinProtocolVersion,
		Ver:    localVer,
		Code:   string(code),
	}
	if saved >= 0 {
		msg.Saved = &saved
	}
	encoded, _ := json.Marshal(msg)
	for budget := maxDisplayReason; len(encoded) > controlMsgMax && budget > 0; budget /= 2 {
		msg.Reason = displayText(reason, budget)
		encoded, _ = json.Marshal(msg)
	}
	if len(encoded) > controlMsgMax {
		msg.Reason = ""
		encoded, _ = json.Marshal(msg)
	}
	return encoded
}

// sendIncompatible puts an encoded frame on the wire with the framing its
// direction requires, then flushes.
func sendIncompatible(dc *webrtc.DataChannel, encoded []byte, toReceiver bool) {
	if dc == nil {
		return // nobody to tell; the relay gate runs against a nil channel in tests
	}
	if toReceiver {
		_ = dc.SendText(string(encoded))
	} else {
		_ = dc.Send(encoded)
	}
	flushControl(dc)
}

// RefusedError is returned by a receive that stopped on purpose and told the
// sender why with AbortWithCode. Code says why and Saved how many files were
// committed before it stopped.
//
// Error() is fixed local wording chosen by Code: never the peer's text, and
// never Err, whose message can carry a local path built from the sender's file
// name. Err keeps the cause for errors.Is and errors.As.
type RefusedError struct {
	Code  RefusalCode
	Saved int
	Err   error
}

func (e *RefusedError) Error() string {
	switch e.Code {
	case CodeWriteFailed:
		// Starts with "write error" on purpose: the desktop's friendlyError
		// already maps that to its save-folder sentence.
		return "write error: could not finish writing a file, so it was not kept"
	case "":
		return "receive stopped"
	}
	// Only ever a constant this side chose, so it is safe to print.
	return "receive stopped: " + string(e.Code)
}

func (e *RefusedError) Unwrap() error { return e.Err }

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
// The receive loop is the only caller, and it acts on "metadata", "end" and
// "incompatible" (a sender's abort). "ack" and "received" flow the other way
// and never come through here: the sender decodes the receiver's frames on its
// own (the ack wait in sendFile, abortFromPeer and isReceived) under the same
// controlMsgMax bound. A stray "ack" or "received" that does reach the receive
// loop matches no arm of its switch and is dropped.
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
