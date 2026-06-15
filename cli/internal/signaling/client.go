// Package signaling manages the WebSocket connection to the Floe signaling server.
// The CLI communicates with the server over a plain WebSocket (not Socket.IO).
// The server routes WebRTC signals between peers regardless of whether they
// are browsers (Socket.IO) or CLI clients (WebSocket).
package signaling

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// Message is the JSON structure used for all WebSocket messages.
// The server sends the same fields; only relevant ones are populated per event.
type Message struct {
	Type   string          `json:"type"`
	Role   string          `json:"role,omitempty"`
	ID     string          `json:"id,omitempty"`
	Signal json.RawMessage `json:"signal,omitempty"`
	Sender string          `json:"sender,omitempty"`
	Msg    string          `json:"message,omitempty"`
}

// Client holds the WebSocket connection and event channels.
// After Connect, read from these channels to react to server events.
type Client struct {
	conn   *websocket.Conn
	roomId string

	// Role receives "sender" or "receiver" after joining a room.
	Role chan string

	// PeerConnected receives the remote peer's ID when they join the room.
	// The sender waits on this before starting WebRTC negotiation.
	PeerConnected chan string

	// Signal receives raw JSON signal payloads (SDP or ICE) from the remote peer.
	Signal chan json.RawMessage

	// PeerLeft is closed/sent when the remote peer disconnects.
	PeerLeft chan struct{}

	// RoomFull is sent when the room already has two peers.
	RoomFull chan struct{}

	// Errors receives error messages from the server.
	Errors chan string
}

// Connect opens a WebSocket connection to serverURL/ws.
// serverURL may start with http://, https://, ws://, or wss://.
func Connect(serverURL string) (*Client, error) {
	wsURL := toWSScheme(serverURL) + "/ws"

	header := http.Header{}
	header.Set("Origin", originFromServer(serverURL))
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		return nil, fmt.Errorf("cannot connect to signaling server at %s: %w", wsURL, err)
	}

	c := &Client{
		conn:          conn,
		Role:          make(chan string, 1),
		PeerConnected: make(chan string, 1),
		Signal:        make(chan json.RawMessage, 128),
		PeerLeft:      make(chan struct{}, 1),
		RoomFull:      make(chan struct{}, 1),
		Errors:        make(chan string, 4),
	}

	// The read loop runs in the background and dispatches messages to channels.
	go c.readLoop()
	return c, nil
}

// JoinRoom sends a join-room message with the given UUID room ID.
func (c *Client) JoinRoom(roomId string) error {
	c.roomId = roomId
	return c.writeJSON(map[string]string{
		"type":   "join-room",
		"roomId": roomId,
	})
}

// SendSignal sends a WebRTC signal (SDP offer/answer or ICE candidate) to the
// other peer. The signal is routed by the server via the shared room ID.
func (c *Client) SendSignal(signal interface{}) error {
	return c.writeJSON(map[string]interface{}{
		"type":   "signal",
		"roomId": c.roomId,
		"signal": signal,
	})
}

// Close gracefully closes the WebSocket connection.
func (c *Client) Close() {
	c.conn.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
		time.Now().Add(time.Second),
	)
	c.conn.Close()
}

// writeJSON marshals v to JSON and writes it to the WebSocket.
func (c *Client) writeJSON(v interface{}) error {
	c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.conn.WriteJSON(v)
}

// readLoop continuously reads messages from the WebSocket and dispatches them
// to the appropriate channels. Runs as a goroutine until the connection closes.
func (c *Client) readLoop() {
	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			// Connection closed — signal PeerLeft so callers don't block forever
			select {
			case c.PeerLeft <- struct{}{}:
			default:
			}
			return
		}

		var msg Message
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "room-joined":
			c.Role <- msg.Role

		case "user-connected":
			c.PeerConnected <- msg.ID

		case "signal":
			if len(msg.Signal) > 0 {
				select {
				case c.Signal <- msg.Signal:
				default:
					// Buffer full — drop; shouldn't happen in normal flow
				}
			}

		case "peer-disconnected":
			select {
			case c.PeerLeft <- struct{}{}:
			default:
			}

		case "room-full":
			select {
			case c.RoomFull <- struct{}{}:
			default:
			}

		case "error":
			select {
			case c.Errors <- msg.Msg:
			default:
			}
		}
	}
}

// originFromServer derives a browser-style Origin header from the signaling
// server URL so self-hosted deployments aren't misrepresented as floe.one.
func originFromServer(serverURL string) string {
	switch serverURL {
	case "https://api.floe.one":
		return "https://floe.one"
	case "http://localhost:3001":
		return "http://localhost:3000"
	}
	u := strings.TrimSuffix(serverURL, "/")
	i := strings.Index(u, "://")
	if i == -1 {
		return u
	}
	host := u[i+3:]
	if j := strings.IndexByte(host, '/'); j != -1 {
		host = host[:j]
	}
	return u[:i+3] + host
}

// toWSScheme converts http(s) URLs to ws(s) URLs.
func toWSScheme(u string) string {
	if strings.HasPrefix(u, "https://") {
		return "wss://" + u[8:]
	}
	if strings.HasPrefix(u, "http://") {
		return "ws://" + u[7:]
	}
	return u // already ws:// or wss://
}
