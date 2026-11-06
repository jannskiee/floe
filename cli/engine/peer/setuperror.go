package peer

// A setup failure with the stage it failed at, so a caller can choose fixed
// copy by type and stage instead of matching on text, and with the text made
// safe to show.

import (
	"errors"

	"github.com/jannskiee/floe/cli/engine/transfer"
)

// The stages a SetupError names, in the order a session goes through them.
const (
	StageOffer             = "offer"              // building or sending the offer, or waiting for the peer's
	StageAnswer            = "answer"             // building or sending the answer, or waiting for the peer's
	StageRemoteDescription = "remote-description" // applying the peer's SDP
	StageConnect           = "connect"            // ICE and DTLS
	StageChannel           = "channel"            // the data channel after the connection
)

// The stages of a setup that stopped early, at any of its waits, because
// something ended it rather than because it failed. Each comes with the
// sentinel below of the same name.
const (
	StagePeerLeft      = "peer-left"      // the server reported the other side gone
	StageSignalingLost = "signaling-lost" // the socket to the server closed
	StageClosed        = "closed"         // Close was called on this Connection
)

// The sentinels a setup that stopped early wraps in its SetupError, for
// errors.Is. Their texts are fixed and local: no peer or server text is ever
// in them.
var (
	// ErrPeerLeft: the signaling server reported the other side gone
	// (peer-disconnected) while setup was waiting on it.
	ErrPeerLeft = errors.New("the other side left before the connection was established")
	// ErrSignalingLost: the socket to the signaling server closed while setup
	// was waiting, so no signal could arrive any more.
	ErrSignalingLost = errors.New("the connection to the server was lost before the peer connected")
	// ErrClosed: Close was called while setup was waiting.
	ErrClosed = errors.New("closed before the connection was established")
)

// maxSetupErrorRunes caps SetupError's text, 300 being the cap every peer string
// on an error path respects (maxDisplayReason in the transfer package). No text
// holds peer bytes since ownWords, so this and DisplayText are the last stop.
const maxSetupErrorRunes = 300

// ownWords is a setup failure whose cause can quote what the other side wrote:
// pion/sdp puts the offending SDP token in its error, up to the 1 MB a signal can
// carry, and that side has proved nothing yet (final audit, reports 27 F3 and 29
// F2). The text is the site's own and the cause stays for errors.As.
type ownWords struct {
	text  string
	cause error
}

func (e *ownWords) Error() string { return e.text }
func (e *ownWords) Unwrap() error { return e.cause }

// SetupError is what SetupAsSender and SetupAsReceiver return when the
// session cannot be set up. Stage says where, for errors.As; Err is the error
// the site built, its text unchanged from before the type existed.
//
// Error() is Err's text through transfer.DisplayText, with no prefix and no
// stage: the CLI and the desktop key their sentences on these texts byte for
// byte, and a caller that wants fixed copy matches the type instead and never
// shows the string. Every text is short and local; DisplayText replaces control
// and bidi runes and caps the whole string, should one ever not be.
type SetupError struct {
	Stage string
	Err   error
}

func (e *SetupError) Error() string {
	if e.Err == nil {
		return ""
	}
	return transfer.DisplayText(e.Err.Error(), maxSetupErrorRunes)
}

func (e *SetupError) Unwrap() error { return e.Err }
