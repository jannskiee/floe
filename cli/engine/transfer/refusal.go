package transfer

// The refusal vocabulary a receiver uses when it stops a transfer on purpose: the
// codes, the incompatible frame that carries them, and the error a caller reads back.

import (
	"encoding/json"
	"errors"

	"github.com/pion/webrtc/v4"
)

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

// The two ways a file fails its SHA-256, carried in RefusedError.Err so that
// Error() can word them apart without ever reading the peer's text. Both refuse
// with CodeHashMismatch: a digest that cannot be read cannot vouch for the
// file either, and a second code would widen the closed set for no reader.
var (
	errSHA256Mismatch   = errors.New("sha256 did not match the bytes written")
	errSHA256Unreadable = errors.New("sha256 is not 64 lowercase hex characters")
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
	case CodeHashMismatch:
		// Neither sentence starts with "write error": the desktop maps that to
		// save-folder advice, which is wrong for a file that failed its hash.
		if errors.Is(e.Err, errSHA256Unreadable) {
			return "the sender's SHA-256 for a file could not be read, so the file was not kept"
		}
		return "a file did not match the SHA-256 the sender computed, so it was not kept"
	case "":
		return "receive stopped"
	}
	// Only ever a constant this side chose, so it is safe to print.
	return "receive stopped: " + string(e.Code)
}

func (e *RefusedError) Unwrap() error { return e.Err }
