package signaling

import (
	"fmt"

	"github.com/gorilla/websocket"
)

// HandshakeError is a /ws upgrade that something answered with an HTTP
// status instead of switching protocols. Connect returns it inside its own
// "cannot connect to signaling server at ..." error, so a caller reaches it
// with errors.As and picks its words by Status, never by matching text.
//
// The status is the whole of what is kept. The response's body and headers
// are a server's text, or a proxy's, and none of it leaves Connect.
//
// What each answer usually means:
//
//	403  the server's Origin check refused the request (isAllowedOrigin in
//	     server/server.js). These clients send the server's own address as
//	     Origin, so this is a reverse proxy that does not pass the original
//	     Host header through.
//	404  a reverse proxy that does not forward /ws to the server, or an
//	     address that is not a Floe server at all.
//	502, 503  a reverse proxy with no server answering behind it.
type HandshakeError struct {
	Status int
}

// Error keeps the words this failure has always printed, "websocket: bad
// handshake", which the docs quote and people search for, and adds the status
// after them.
func (e *HandshakeError) Error() string {
	return fmt.Sprintf("%s (HTTP %d)", websocket.ErrBadHandshake.Error(), e.Status)
}

// Unwrap keeps errors.Is(err, websocket.ErrBadHandshake) true.
func (e *HandshakeError) Unwrap() error { return websocket.ErrBadHandshake }
