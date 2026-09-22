package transfer

// The receive side's accept decision: the answer a caller gives when the
// sender's first metadata has arrived and nothing is on disk yet, and the one
// error that answer can arrive too late for.
//
// ReceiveFilesWithOptions consults ReceiveOptions.Decide once, at the point
// OnIncoming fires, and acts on what comes back inline. The shapes live here
// rather than beside the loop so the loop reads as one pass.

import "errors"

// DecisionKind is which of the three answers a Decide returned. The zero value
// is none of them on purpose: a Decide that returns an unset Decision is a
// local programming mistake, and the receive loop treats it like a decline,
// which is the direction that creates nothing.
type DecisionKind int

const (
	// DecisionAccept takes the transfer: the loop claims its first file and
	// acks from here on, into Decision.OutputDir when that field is set.
	DecisionAccept DecisionKind = iota + 1
	// DecisionDecline turns it down for a person who said no. It sends
	// CodeDeclined and the receive returns ErrDeclined.
	DecisionDecline
	// DecisionRefuse turns it down for a reason the caller names in
	// Decision.Code, and the receive returns a *RefusedError carrying it.
	DecisionRefuse
)

// Decision is what a Decide hands back. Every field is chosen by this side:
// nothing here comes from the peer.
type Decision struct {
	// Kind is the answer. Anything other than DecisionAccept stops the
	// transfer before a directory, a staging file or an ack exists.
	Kind DecisionKind
	// Code is the refusal code sent for DecisionRefuse, and ignored for the
	// other two. A DecisionRefuse that names none sends CodeStopped rather
	// than an uncoded frame, which peers show as generic closed-connection
	// text.
	Code RefusalCode
	// OutputDir, when non-empty on DecisionAccept, replaces the outputDir the
	// caller passed, for every claim, every SavedName and the summary. It
	// exists so a caller can create the folder it drops into only once the
	// person has accepted: nothing resolves a path against it earlier.
	OutputDir string
}

// ErrSenderLeft is what a receive returns when the sender's channel closed
// while Decide was still deciding. It is the fixed sentence for a window that
// used to be reported as a mid-transfer close: before this check existed, a
// decision that arrived after the sender gave up claimed a staging file and
// acked a channel nobody was reading.
//
// Nothing was created and nothing was sent when this is returned.
var ErrSenderLeft = errors.New("the sender left before the transfer was accepted")
