package peer

// A setup failure with the stage it failed at, so a caller can choose fixed
// copy by type and stage instead of matching on text, and with the text made
// safe to show.

import "github.com/jannskiee/floe/cli/engine/transfer"

// The stages a SetupError names, in the order a session goes through them.
const (
	StageOffer             = "offer"              // building or sending the offer, or waiting for the peer's
	StageAnswer            = "answer"             // building or sending the answer, or waiting for the peer's
	StageRemoteDescription = "remote-description" // applying the peer's SDP
	StageConnect           = "connect"            // ICE and DTLS
	StageChannel           = "channel"            // the data channel after the connection
)

// maxSetupErrorRunes caps SetupError's text. The one site whose text embeds
// peer bytes is the remote description, where pion quotes the offending SDP
// token, and 300 is the cap every other peer string on an error path respects
// (maxDisplayReason in the transfer package).
const maxSetupErrorRunes = 300

// SetupError is what SetupAsSender and SetupAsReceiver return when the
// session cannot be set up. Stage says where, for errors.As; Err is the error
// the site built, its text unchanged from before the type existed.
//
// Error() is Err's text through transfer.DisplayText, with no prefix and no
// stage: the CLI and the desktop key their sentences on these texts byte for
// byte, and a caller that wants fixed copy matches the type instead and never
// shows the string. Every text is short and local except the remote
// description's; DisplayText replaces control and bidi runes and caps the
// whole string, so nothing a peer put in its SDP can paint a terminal or
// reorder a line, and the local texts pass through untouched.
type SetupError struct {
	Stage string
	Err   error
}

func (e *SetupError) Error() string {
	return transfer.DisplayText(e.Err.Error(), maxSetupErrorRunes)
}

func (e *SetupError) Unwrap() error { return e.Err }
