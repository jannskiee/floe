// Package signaling manages the WebSocket connection to the Floe signaling server.
// The CLI communicates with the server over a plain WebSocket (not Socket.IO).
// The server routes WebRTC signals between peers regardless of whether they
// are browsers (Socket.IO) or CLI clients (WebSocket).
package signaling

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
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
	Code   string          `json:"code,omitempty"`
}

// Client holds the WebSocket connection and event channels.
// After Connect, read from these channels to react to server events.
type Client struct {
	conn   *websocket.Conn
	roomId string

	// writeMu serializes all writes to the WebSocket. gorilla/websocket permits
	// only one concurrent writer; without this, an ICE candidate sent from pion's
	// OnICECandidate callback can race the offer/answer sent from the main
	// goroutine, tripping gorilla's "concurrent write" panic or corrupting a
	// frame (which silently breaks ICE and aborts the transfer).
	writeMu sync.Mutex

	// Role receives the role the server seated this socket in: "sender" or
	// "receiver" after a plain join (room-joined), "host" after a token join
	// (room-joined), "visitor" after a request-join (request-joined).
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

	// Refused receives the code of a refused frame, the server's answer to a
	// token join it would not seat (spec 04 5.5). JoinRoomWithToken reads it
	// while it waits for its answer; a seated host can read a later one, sent
	// when the server's request links are turned off under a waiting link.
	// The code is only ever compared, never shown.
	Refused chan string

	// HostAbsent receives when a request-join finds no host in the room, or
	// the host of an unsealed room left or closed it.
	HostAbsent chan struct{}

	// Disabled receives when a request-join finds the server's request links
	// turned off, or they are turned off while a visitor waits.
	Disabled chan struct{}

	// Down is closed, exactly once, when the read loop ends because the
	// socket is gone: closed by either side, a read error, or the liveness
	// read deadline. It is closed before PeerLeft gets the push the read loop
	// has always sent, so a reader woken by PeerLeft can tell a lost socket
	// (Down already closed) from a peer the server reported gone.
	Down chan struct{}

	// cfg is what the Options passed to Connect set; the zero value is a
	// plain client with no ping and no read deadline.
	cfg config

	// stop is closed by Close and ends the liveness ping loop.
	stop     chan struct{}
	stopOnce sync.Once
}

// Option configures a Client built by Connect.
type Option func(*config)

// config collects what the Options set. Its zero value is the plain client
// the CLI's send and receive have always used.
type config struct {
	ping         time.Duration // interval of the {"type":"ping"} frame; 0 sends none
	readDeadline time.Duration // longest wait for any frame; 0 waits forever
}

// WithLiveness makes the client find a dead server on its own, for a socket
// that waits a long time between frames (a request link waiting for a
// visitor): it writes {"type":"ping"} every ping interval, which the server
// answers with a pong, and a read that waits longer than readDeadline ends
// the read loop, which closes Down. The desktop passes 25 s and 60 s. A
// value of zero or less turns that half off. A plain Connect sets neither,
// so the CLI's sends and receives keep exactly their behavior.
func WithLiveness(ping, readDeadline time.Duration) Option {
	return func(c *config) {
		c.ping = ping
		c.readDeadline = readDeadline
	}
}

// Connect opens a WebSocket connection to serverURL/ws.
// serverURL may start with http://, https://, ws://, or wss://.
func Connect(serverURL string, opts ...Option) (*Client, error) {
	var cfg config
	for _, o := range opts {
		if o != nil {
			o(&cfg)
		}
	}

	wsURL := toWSScheme(serverURL) + "/ws"

	header := http.Header{}
	header.Set("Origin", originFromServer(serverURL))
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, header)
	if err != nil {
		return nil, fmt.Errorf("cannot connect to signaling server at %s: %w", wsURL, err)
	}

	c := newClient(conn, cfg)

	// The read loop runs in the background and dispatches messages to channels.
	go c.readLoop()
	if cfg.ping > 0 {
		go c.pingLoop(cfg.ping)
	}
	return c, nil
}

// newClient builds a Client around conn with every channel at its buffer
// size. Connect is its caller; the decoder tests build one with a nil conn.
func newClient(conn *websocket.Conn, cfg config) *Client {
	return &Client{
		conn:          conn,
		cfg:           cfg,
		Role:          make(chan string, 1),
		PeerConnected: make(chan string, 1),
		Signal:        make(chan json.RawMessage, 128),
		PeerLeft:      make(chan struct{}, 1),
		RoomFull:      make(chan struct{}, 1),
		Errors:        make(chan string, 4),
		Refused:       make(chan string, 1),
		HostAbsent:    make(chan struct{}, 1),
		Disabled:      make(chan struct{}, 1),
		Down:          make(chan struct{}),
		stop:          make(chan struct{}),
	}
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

// replyTimeout bounds the wait for the server's answer to JoinRoomWithToken
// and RequestJoin. A server that predates request links never answers a
// request-join at all, so the wait has to end on its own. A variable only so
// a test can shrink it.
var replyTimeout = 10 * time.Second

// ErrOldServer comes with HostOldServer: the server seated this socket by
// join order (room-joined with a role other than host), which only a server
// that predates request links does with a token join (E-59). That seat is
// not a reserved room, and the caller must never use it: Close the Client and
// never retry on this socket, because the old server still holds it as the
// first seat of an ordinary room named by the link's room id.
var ErrOldServer = errors.New("the signaling server does not support request links: it seated the host by join order")

// The errors the reserved-room calls return for a failure of the exchange
// itself. Fixed strings: no token, room id or server text is ever in them.
// The one other error, a failed write of the join frame, wraps gorilla's
// write error behind a fixed prefix; that can carry the local network's own
// text (a socket address) but never a payload, so still no token, room id or
// server text.
var (
	errHostTokenShape = errors.New("the host token is not 43 base64url characters")
	errRoomNotDerived = errors.New("the room id is not the one the host token derives")
	errUnexpectedRole = errors.New("the signaling server answered the request-join with a seat that is not the visitor's")
	errNoReply        = errors.New("the signaling server did not answer in time")
	errDown           = errors.New("the connection to the signaling server closed before it answered")
)

// typeFrame is a frame with nothing but its type: the liveness ping.
type typeFrame struct {
	Type string `json:"type"`
}

// roomFrame is a frame that names only the room: request-join and the three
// request-link control frames.
type roomFrame struct {
	Type   string `json:"type"`
	RoomID string `json:"roomId"`
}

// hostJoinFrame is the token join. It exists only for the write; nothing
// keeps it, formats it or logs it.
type hostJoinFrame struct {
	Type      string `json:"type"`
	RoomID    string `json:"roomId"`
	HostToken string `json:"hostToken"`
}

// HostJoinResult is the server's answer to JoinRoomWithToken. The zero value
// is none of the results.
type HostJoinResult int

const (
	// HostJoined: room-joined with role host. This socket holds seat 0.
	HostJoined HostJoinResult = iota + 1
	// HostRefusedDisabled: refused with code disabled. Request links are
	// turned off on this server.
	HostRefusedDisabled
	// HostRefusedLimited: refused with code limited. This network made too
	// many links today, or the server holds as many as it will.
	HostRefusedLimited
	// HostRefusedUnknown: refused with any other code, or none, or an error
	// frame with a message this build does not know. The code is parsed and
	// mapped here and never carried further, so the wire can gain codes
	// without a client showing one.
	HostRefusedUnknown
	// HostRoomFull: room-full. The id belongs to an ordinary room, or the
	// reservation holds another token's digest, or the link was used: the
	// host's request-close on a sealed room leaves a used marker for 24 h,
	// and a token join on it is refused rather than re-creating the link
	// (D-130).
	HostRoomFull
	// HostInvalidToken: error "Invalid host token", or the local check
	// refused the pair before anything was sent (a malformed token, or a room
	// id that is not the token's derivation).
	HostInvalidToken
	// HostInvalidRoom: error "Invalid room ID".
	HostInvalidRoom
	// HostOldServer: room-joined with any role but host (E-59); the error is
	// ErrOldServer.
	HostOldServer
	// HostTimeout: no answer within replyTimeout (10 s).
	HostTimeout
	// HostDown: the socket closed, or the join could not be written, before
	// an answer arrived.
	HostDown
)

// String is a fixed word per result, never anything the caller passed or the
// server sent.
func (r HostJoinResult) String() string {
	switch r {
	case HostJoined:
		return "joined"
	case HostRefusedDisabled:
		return "refused-disabled"
	case HostRefusedLimited:
		return "refused-limited"
	case HostRefusedUnknown:
		return "refused-unknown"
	case HostRoomFull:
		return "room-full"
	case HostInvalidToken:
		return "invalid-token"
	case HostInvalidRoom:
		return "invalid-room"
	case HostOldServer:
		return "old-server"
	case HostTimeout:
		return "timeout"
	case HostDown:
		return "down"
	}
	return "unknown"
}

// JoinRoomWithToken claims the reserved request room roomId as its host
// (spec 04 5.6.2): it writes {"type":"join-room","roomId":...,"hostToken":...}
// and waits up to replyTimeout for the server's answer.
//
// It first checks locally that roomId is RoomIDFromToken(hostToken), the
// check the server makes, and returns HostInvalidToken without writing
// anything when it is not, so a mismatched pair never reaches the wire.
//
// The error is nil for every answer the server gave (the result says which);
// it is non-nil when the exchange itself failed: the local check
// (HostInvalidToken), a server that predates request links (HostOldServer,
// ErrOldServer), no answer (HostTimeout), or a lost socket (HostDown). No
// error text contains the token. The token is not kept: it is written once
// and dropped.
func (c *Client) JoinRoomWithToken(roomId, hostToken string) (HostJoinResult, error) {
	derived := RoomIDFromToken(hostToken)
	if derived == "" {
		return HostInvalidToken, errHostTokenShape
	}
	if roomId != derived {
		return HostInvalidToken, errRoomNotDerived
	}

	c.roomId = roomId
	if err := c.writeJSON(hostJoinFrame{Type: "join-room", RoomID: roomId, HostToken: hostToken}); err != nil {
		return HostDown, fmt.Errorf("could not send the host join: %w", err)
	}

	timer := time.NewTimer(replyTimeout)
	defer timer.Stop()
	select {
	case role := <-c.Role:
		if role != "host" {
			return HostOldServer, ErrOldServer
		}
		return HostJoined, nil
	case code := <-c.Refused:
		switch code {
		case "disabled":
			return HostRefusedDisabled, nil
		case "limited":
			return HostRefusedLimited, nil
		}
		return HostRefusedUnknown, nil
	case <-c.RoomFull:
		return HostRoomFull, nil
	case msg := <-c.Errors:
		switch msg {
		case "Invalid host token":
			return HostInvalidToken, nil
		case "Invalid room ID":
			return HostInvalidRoom, nil
		}
		return HostRefusedUnknown, nil
	case <-c.Down:
		return HostDown, errDown
	case <-timer.C:
		return HostTimeout, errNoReply
	}
}

// RequestSeal tells the server the room's pair is settled, so a later
// request-join gets room-full (spec 04 5.6.6). The server sends no reply.
func (c *Client) RequestSeal() error { return c.requestControl("request-seal") }

// RequestReopen opens the room to a new visitor again, evicting a seated one
// (spec 04 5.6.6). The server sends no reply.
func (c *Client) RequestReopen() error { return c.requestControl("request-reopen") }

// RequestClose ends the room and its reservation (spec 04 5.6.6). The server
// sends no reply.
func (c *Client) RequestClose() error { return c.requestControl("request-close") }

// requestControl writes {"type":kind,"roomId":<the joined room>}.
func (c *Client) requestControl(kind string) error {
	return c.writeJSON(roomFrame{Type: kind, RoomID: c.roomId})
}

// RequestJoinResult is the server's answer to RequestJoin. The zero value is
// none of the results.
type RequestJoinResult int

const (
	// VisitorJoined: request-joined with role visitor. This socket holds
	// seat 1 and the host has been sent user-connected.
	VisitorJoined RequestJoinResult = iota + 1
	// VisitorHostAbsent: host-absent. No host is connected, the id is
	// unknown, or it is an ordinary room.
	VisitorHostAbsent
	// VisitorRoomFull: room-full. The link was used, or another visitor
	// holds the seat.
	VisitorRoomFull
	// VisitorDisabled: disabled. Request links are turned off on this server.
	VisitorDisabled
	// VisitorInvalidRoom: an error frame (the server's only one here is
	// "Invalid room ID"; its text is never carried), or a seat with a role
	// that is not the visitor's, which comes with an error.
	VisitorInvalidRoom
	// VisitorTimeout: no answer within replyTimeout (10 s); a server that
	// predates request links ignores request-join, so this is its answer.
	VisitorTimeout
	// VisitorDown: the socket closed, or the join could not be written,
	// before an answer arrived.
	VisitorDown
)

// String is a fixed word per result.
func (r RequestJoinResult) String() string {
	switch r {
	case VisitorJoined:
		return "joined"
	case VisitorHostAbsent:
		return "host-absent"
	case VisitorRoomFull:
		return "room-full"
	case VisitorDisabled:
		return "disabled"
	case VisitorInvalidRoom:
		return "invalid-room"
	case VisitorTimeout:
		return "timeout"
	case VisitorDown:
		return "down"
	}
	return "unknown"
}

// RequestJoin asks for the visitor seat of the request room roomId (spec 04
// 5.6.4): it writes {"type":"request-join","roomId":...} and waits up to
// replyTimeout for the server's answer. As with JoinRoomWithToken, the error
// is nil for every answer the server gave and non-nil when the exchange
// failed (VisitorTimeout, VisitorDown, or a seat that is not the visitor's).
func (c *Client) RequestJoin(roomId string) (RequestJoinResult, error) {
	c.roomId = roomId
	if err := c.writeJSON(roomFrame{Type: "request-join", RoomID: roomId}); err != nil {
		return VisitorDown, fmt.Errorf("could not send the request join: %w", err)
	}

	timer := time.NewTimer(replyTimeout)
	defer timer.Stop()
	select {
	case role := <-c.Role:
		if role != "visitor" {
			return VisitorInvalidRoom, errUnexpectedRole
		}
		return VisitorJoined, nil
	case <-c.HostAbsent:
		return VisitorHostAbsent, nil
	case <-c.RoomFull:
		return VisitorRoomFull, nil
	case <-c.Disabled:
		return VisitorDisabled, nil
	case <-c.Errors:
		return VisitorInvalidRoom, nil
	case <-c.Down:
		return VisitorDown, errDown
	case <-timer.C:
		return VisitorTimeout, errNoReply
	}
}

// Close gracefully closes the WebSocket connection and stops the liveness
// ping loop, if there is one.
func (c *Client) Close() {
	if c.stop != nil {
		c.stopOnce.Do(func() { close(c.stop) })
	}
	// WriteControl shares the write path with writeJSON, so hold writeMu to
	// avoid racing an in-flight signal write (e.g. a late trickle-ICE candidate).
	c.writeMu.Lock()
	c.conn.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
		time.Now().Add(time.Second),
	)
	c.writeMu.Unlock()
	c.conn.Close()
}

// writeJSON marshals v to JSON and writes it to the WebSocket.
//
// All writes funnel through here so writeMu is the single serialization point
// for the connection: the main goroutine (join-room, offer/answer) and pion's
// OnICECandidate callback goroutine (trickle ICE) both reach the socket via
// writeJSON, and gorilla/websocket only allows one writer at a time.
func (c *Client) writeJSON(v interface{}) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.conn.WriteJSON(v)
}

// readLoop continuously reads messages from the WebSocket and dispatches them
// to the appropriate channels. Runs as a goroutine until the connection closes.
func (c *Client) readLoop() {
	for {
		if c.cfg.readDeadline > 0 {
			// Before every read, so any frame at all (the pong to our own ping
			// at the least) proves the server is alive. The server's
			// protocol-level pings are answered inside ReadMessage and do not
			// move the deadline.
			_ = c.conn.SetReadDeadline(time.Now().Add(c.cfg.readDeadline))
		}
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			// The socket is gone. Down first, then the PeerLeft push old
			// callers wait on, so a reader woken by PeerLeft already sees Down
			// closed. This is the loop's only exit, so Down closes once.
			close(c.Down)
			select {
			case c.PeerLeft <- struct{}{}:
			default:
			}
			return
		}
		c.dispatch(raw)
	}
}

// pingLoop writes {"type":"ping"} every interval until Close or until the
// read loop has ended. A failed write needs no handling here: the read loop
// sees the same dead socket and closes Down.
func (c *Client) pingLoop(every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-c.stop:
			return
		case <-c.Down:
			return
		case <-t.C:
			_ = c.writeJSON(typeFrame{Type: "ping"})
		}
	}
}

// dispatch decodes one server frame and routes it to its channel. readLoop is
// its only caller; it is a function of its own so a test can drive the decoder
// without a socket.
func (c *Client) dispatch(raw []byte) {
	var msg Message
	if err := json.Unmarshal(raw, &msg); err != nil {
		return
	}

	switch msg.Type {
	// Non-blocking, like every other case below. Both channels are buffered
	// to 1 and every consumer reads them exactly once, so a second frame can
	// only arrive when nobody is waiting for it. The server re-sends
	// user-connected to the room's first peer on every second-peer join and
	// keeps the surviving seat across a one-sided drop, so a receiver that
	// dropped and rejoined twice filled the buffer and then wedged this loop
	// for good. readLoop is the only reader of the socket, so a wedge here
	// silently stops trickle ICE and the transfer dies at the 30s connect
	// timeout with nothing to diagnose from.
	case "room-joined":
		select {
		case c.Role <- msg.Role:
		default:
		}

	case "user-connected":
		select {
		case c.PeerConnected <- msg.ID:
		default:
		}

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

	// The reserved-room answers (spec 04 5.5). A request-joined carries the
	// visitor's role the way room-joined carries the others; the rest are
	// signals with at most a code. Non-blocking like the cases above.
	case "request-joined":
		select {
		case c.Role <- msg.Role:
		default:
		}

	case "refused":
		select {
		case c.Refused <- msg.Code:
		default:
		}

	case "host-absent":
		select {
		case c.HostAbsent <- struct{}{}:
		default:
		}

	case "disabled":
		select {
		case c.Disabled <- struct{}{}:
		default:
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
