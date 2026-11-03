package signaling

import (
	"errors"
	"fmt"
)

// ErrServerFrame is an error frame on a join whose words this build does not
// know. Fixed, so none of the server's text reaches a status line or a terminal.
var ErrServerFrame = errors.New("the server answered with an error this version of Floe does not know")

// ServerFrameError is the error for an error frame the server answered a join
// with. The frame's message is the signaling server's own text, unbounded, and
// whatever that server chooses to send, ahead of any proof of a link's key, so it
// is kept only when it is the one text a Floe server sends here, for a room id
// that is not a UUID (server.js isValidRoomId). Every other frame becomes
// ErrServerFrame.
func ServerFrameError(msg string) error {
	if msg == "Invalid room ID" {
		return fmt.Errorf("server error: %s", msg)
	}
	return ErrServerFrame
}
