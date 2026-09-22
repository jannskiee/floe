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

// The twelve codes. client/lib/transfer/protocol.ts REFUSAL_CODES mirrors this
// list and must stay in sync; RefusalCodes below is the list in wire order.
const (
	// CodeDeclined: the person at the receiver said no before any file was
	// created. Nothing is on disk.
	CodeDeclined RefusalCode = "declined"
	// CodeDiskFull: a write or flush on this side's own file handle failed
	// because the drive is full. The in-flight .part is removed.
	CodeDiskFull RefusalCode = "disk-full"
	// CodeExpired: the receiver's decision window closed before anyone
	// answered. Nothing is on disk.
	CodeExpired RefusalCode = "expired"
	// CodeFileTooLargeForFolder: a single file is larger than the drive the
	// receiver saves to can hold.
	CodeFileTooLargeForFolder RefusalCode = "file-too-large-for-folder"
	// CodeHashMismatch: a file's bytes did not match the SHA-256 the sender
	// computed, or the hash it sent was malformed. The .part is removed before
	// it ever gets a final name.
	CodeHashMismatch RefusalCode = "hash-mismatch"
	// CodeOverApproved: more data arrived than the receiver agreed to take.
	CodeOverApproved RefusalCode = "over-approved"
	// CodePathTooLong: a file path the receiver cannot store under its save
	// folder (too deep, too long, or not relative to it).
	CodePathTooLong RefusalCode = "path-too-long"
	// CodeRelayCap: the receiver's relayed connection is capped at 2 GB.
	CodeRelayCap RefusalCode = "relay-cap"
	// CodeSaveBlocked: a finished file could not be moved into place.
	CodeSaveBlocked RefusalCode = "save-blocked"
	// CodeStopped: the person at the receiver stopped the transfer.
	CodeStopped RefusalCode = "stopped"
	// CodeTimeLimit: the receiver's 24-hour per-transfer limit was reached.
	CodeTimeLimit RefusalCode = "time-limit"
	// CodeWriteFailed: a flush, close, create or write failed on this side's
	// own file handle for a reason other than a full drive. The in-flight
	// .part is removed.
	CodeWriteFailed RefusalCode = "write-failed"
)

// RefusalCodes is the closed set in byte order of the wire values, which is
// the order the browser twin pins its literal in. TestRefusalCodeListMatchesTS
// pins the literal here.
var RefusalCodes = [...]RefusalCode{
	CodeDeclined,
	CodeDiskFull,
	CodeExpired,
	CodeFileTooLargeForFolder,
	CodeHashMismatch,
	CodeOverApproved,
	CodePathTooLong,
	CodeRelayCap,
	CodeSaveBlocked,
	CodeStopped,
	CodeTimeLimit,
	CodeWriteFailed,
}

// ParseRefusalCode reports whether s is exactly one of RefusalCodes. Exact and
// case-sensitive, as the browser's REFUSAL_CODES.has is: "WRITE-FAILED", "" and
// "write-failed " all fail. It is the one allowlist a peer's code passes
// through before anything acts on it.
func ParseRefusalCode(s string) (RefusalCode, bool) {
	for _, c := range RefusalCodes {
		if string(c) == s {
			return c, true
		}
	}
	return "", false
}

// WireReason is the surface-neutral reason a caller passes to AbortWithCode
// for this code, so no caller invents prose. Peers that predate code print it
// verbatim, so it names no path, no file and no surface, and it is written
// from the receiver's point of view like the two sentences that shipped first.
// A caller with a more exact cause for the same code may still pass its own
// sentence of the same shape.
func (c RefusalCode) WireReason() string {
	switch c {
	case CodeDeclined:
		return "receiver declined the transfer"
	case CodeDiskFull:
		return "receiver ran out of disk space"
	case CodeExpired:
		return "receiver did not answer in time"
	case CodeFileTooLargeForFolder:
		return "receiver cannot store a file this large on its drive"
	case CodeHashMismatch:
		return "receiver discarded a file because its SHA-256 did not match"
	case CodeOverApproved:
		return "receiver got more data than it approved"
	case CodePathTooLong:
		return "receiver cannot store a file path this deep or long"
	case CodeRelayCap:
		return "receiver's relay connection is capped at 2 GB"
	case CodeSaveBlocked:
		return "receiver could not move a finished file into place"
	case CodeStopped:
		return "receiver stopped the transfer"
	case CodeTimeLimit:
		return "receiver stopped the transfer at the 24-hour limit"
	case CodeWriteFailed:
		return "receiver could not finish writing a file"
	}
	return "receiver stopped the transfer"
}

// The two ways a file fails its SHA-256, carried in RefusedError.Err so that
// Error() can word them apart without ever reading the peer's text. Both refuse
// with CodeHashMismatch: a digest that cannot be read cannot vouch for the
// file either, and a second code would widen the closed set for no reader.
var (
	errSHA256Mismatch   = errors.New("sha256 did not match the bytes written")
	errSHA256Unreadable = errors.New("sha256 is not 64 lowercase hex characters")
)

// ErrDeclined is the receive-side sentinel for a transfer the person at the
// receiver turned down. Its text is the sentence the accept prompt has always
// returned, so a caller that matched the string keeps matching.
var ErrDeclined = errors.New("transfer declined")

// AbortWithCode is abortReason for a receiver that knows WHY it stopped: the
// same overlapping-range incompatible frame, plus a code and, when saved is
// not negative, the number of files this side committed under final names
// before stopping.
//
// Receiver to sender only, so the frame is BINARY (abortReason explains why
// binary is safe in that direction and never in the other). reason is shown
// verbatim by peers that predate code, so write it surface-neutral and name no
// path; code.WireReason() is the stock sentence.
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

// refuseWrite is the receive loop's one way out when its OWN disk fails after
// the sender was accepted: it tells the sender with a code, then hands the
// caller the typed error. The code is disk-full when the OS said the drive is
// full and write-failed otherwise; the wire reason is that code's stock
// sentence, except that a failure to create the file at all says so, because
// that is what a peer without code will print. Nothing here removes the
// .part: the arm that owns the handle does, or the deferred discard does.
func refuseWrite(dc *webrtc.DataChannel, localVer string, saved int, creating bool, err error) error {
	code := CodeWriteFailed
	reason := CodeWriteFailed.WireReason()
	switch {
	case isDiskFull(err):
		code = CodeDiskFull
		reason = CodeDiskFull.WireReason()
	case creating:
		reason = "receiver could not create a file"
	}
	AbortWithCode(dc, localVer, code, reason, saved)
	return &RefusedError{Code: code, Saved: saved, Err: err}
}

// RefusedError is returned by a receive that stopped on purpose and told the
// sender why with AbortWithCode. Code says why and Saved how many files were
// committed before it stopped.
//
// Error() is fixed local wording chosen by Code: never the peer's text, and
// never Err, whose message can carry a local path built from the sender's file
// name. Err keeps the cause for errors.Is and errors.As. Code is always a
// constant this side chose, never a value from the wire; the peer's code
// becomes a PeerStoppedError instead.
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
	case CodeDiskFull:
		// The same prefix, for the same reason: that sentence tells the person
		// to check free space, which is exactly right here.
		return "write error: the drive ran out of space, so the file was not kept"
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

// PeerStoppedError is what a sender gets back when the receiver stopped the
// transfer on purpose and named a code this build knows. Code is the peer's
// code after ParseRefusalCode and Saved its count of committed files clamped
// to [0, total]; there is no Reason field, and there never will be one: the
// peer's prose stops at the wire.
//
// Error() is one fixed sentence per code, written for the person who is
// sending: no peer text, and no count (the caller that wants "N of M files
// were saved" builds it from Saved).
type PeerStoppedError struct {
	Code  RefusalCode
	Saved int
}

func (e *PeerStoppedError) Error() string {
	switch e.Code {
	case CodeDeclined:
		return "They declined. Nothing was sent."
	case CodeDiskFull:
		return "Their computer ran out of space."
	case CodeExpired:
		return "They did not answer in time. Nothing was sent."
	case CodeFileTooLargeForFolder:
		return "A file is too large for the drive they save to."
	case CodeHashMismatch:
		return "A file changed or was damaged on the way, so their Floe deleted it."
	case CodeOverApproved:
		return "More data arrived than they accepted. If files changed after you chose them, ask them for a new link."
	case CodePathTooLong:
		return "A folder path is too long for their computer. Zip deeply nested folders first."
	case CodeRelayCap:
		return "Relayed drops are capped at 2 GB."
	case CodeSaveBlocked:
		return "A file arrived but their computer blocked saving it."
	case CodeStopped:
		return "They stopped this drop."
	case CodeTimeLimit:
		return "This drop reached the 24-hour limit, so their Floe stopped it."
	case CodeWriteFailed:
		return "Their computer could not save a file."
	}
	// Unreachable through abortFromPeer, which only builds this for a parsed
	// code; kept fixed so a hand-built value can never print its Code.
	return "The drop stopped on their computer."
}

// CommitError is the receive-side error for a file that arrived in full and
// verified but could not be moved from its .part to its final name. The
// staging file is left in place on purpose (deleting complete bytes over a
// transient lock would be data loss), and the fields say where it is so a
// caller can retry the move or point at it.
//
// Nothing returns it yet; the commit failure still returns its plain wrapped
// error. Error()'s text is provisional until a caller exists, and it prints
// no path and no cause either way: PartPath, Dest and Base carry the sender's
// file name after sanitizing, and Err can carry the OS's own words.
type CommitError struct {
	PartPath string // the .part still on disk, complete and verified
	Dest     string // the final name this receive had claimed
	Base     string // the sanitized path the claim started from
	Err      error
}

func (e *CommitError) Error() string {
	return "received a file in full but could not finish saving it"
}

func (e *CommitError) Unwrap() error { return e.Err }
