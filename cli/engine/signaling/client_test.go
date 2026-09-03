package signaling

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestToWSScheme(t *testing.T) {
	cases := []struct{ in, want string }{
		{"https://api.floe.one", "wss://api.floe.one"},
		{"http://localhost:3001", "ws://localhost:3001"},
		{"wss://api.floe.one", "wss://api.floe.one"},
		{"ws://localhost:3001", "ws://localhost:3001"},
		// Not a URL at all: passed through rather than guessed at, so the dial
		// fails with the string the user typed instead of a mangled one.
		{"api.floe.one", "api.floe.one"},
		{"", ""},
	}
	for _, c := range cases {
		if got := toWSScheme(c.in); got != c.want {
			t.Errorf("toWSScheme(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestOriginFromServer(t *testing.T) {
	cases := []struct{ in, want string }{
		// The two known deployments map to their web app, not to themselves.
		{"https://api.floe.one", "https://floe.one"},
		{"http://localhost:3001", "http://localhost:3000"},
		// Everything else keeps its own origin, so a self-hosted server is not
		// misrepresented as floe.one to its own CORS check.
		{"https://floe.example.com", "https://floe.example.com"},
		{"https://floe.example.com/", "https://floe.example.com"},
		{"https://floe.example.com/signal", "https://floe.example.com"},
		{"https://floe.example.com:8443/x/y", "https://floe.example.com:8443"},
		{"api.floe.one", "api.floe.one"},
	}
	for _, c := range cases {
		if got := originFromServer(c.in); got != c.want {
			t.Errorf("originFromServer(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// testServer upgrades one connection and hands the raw socket to write, so a
// test can push exactly the frame sequence it wants to reproduce.
func testServer(t *testing.T, write func(*websocket.Conn)) *httptest.Server {
	t.Helper()
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ws" {
			http.NotFound(w, r)
			return
		}
		conn, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		write(conn)
		// Hold the connection open so readLoop is not torn down by the close
		// before the test has read what it is waiting for.
		time.Sleep(2 * time.Second)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func dial(t *testing.T, srv *httptest.Server) *Client {
	t.Helper()
	c, err := Connect(strings.Replace(srv.URL, "http://", "ws://", 1))
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	t.Cleanup(c.Close)
	return c
}

// The regression this package exists to prevent. Role and PeerConnected are
// buffered to 1 and every consumer reads them exactly once, so a repeated
// user-connected has nobody waiting for it. The server re-sends user-connected
// to the room's first peer on every second-peer join and keeps the surviving
// seat across a one-sided drop, so a receiver that drops and rejoins twice
// produces exactly this sequence. With a blocking send, the third frame parks
// readLoop forever; readLoop is the only reader of the socket, so every later
// signal frame is lost and the peer dies at the connect timeout with a generic
// message.
func TestReadLoopSurvivesRepeatedUserConnected(t *testing.T) {
	srv := testServer(t, func(conn *websocket.Conn) {
		for i := 0; i < 3; i++ {
			_ = conn.WriteJSON(map[string]string{"type": "user-connected", "id": "peer"})
		}
		_ = conn.WriteJSON(map[string]any{
			"type":   "signal",
			"signal": map[string]string{"type": "offer", "sdp": "v=0"},
		})
	})
	c := dial(t, srv)

	select {
	case <-c.PeerConnected:
	case <-time.After(3 * time.Second):
		t.Fatal("no user-connected delivered")
	}

	// The assertion: dispatch is still running after the surplus frames.
	select {
	case raw := <-c.Signal:
		var got struct{ Type string }
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatalf("signal payload: %v", err)
		}
		if got.Type != "offer" {
			t.Fatalf("signal type = %q, want offer", got.Type)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("signal never arrived: readLoop wedged on a surplus user-connected")
	}
}

// Same shape for room-joined. Unreachable today (both the CLI and the desktop
// call JoinRoom once per Connect), but it is one added rejoin away and the
// blocking form has the same consequence.
func TestReadLoopSurvivesRepeatedRoomJoined(t *testing.T) {
	srv := testServer(t, func(conn *websocket.Conn) {
		for i := 0; i < 3; i++ {
			_ = conn.WriteJSON(map[string]string{"type": "room-joined", "role": "sender"})
		}
		_ = conn.WriteJSON(map[string]string{"type": "error", "message": "after"})
	})
	c := dial(t, srv)

	select {
	case role := <-c.Role:
		if role != "sender" {
			t.Fatalf("role = %q, want sender", role)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no room-joined delivered")
	}

	select {
	case <-c.Errors:
	case <-time.After(3 * time.Second):
		t.Fatal("error frame never arrived: readLoop wedged on a surplus room-joined")
	}
}

// A closed socket must release anything waiting on PeerLeft rather than
// leaving a caller blocked with no connection behind it.
func TestReadLoopSignalsPeerLeftOnClose(t *testing.T) {
	srv := testServer(t, func(conn *websocket.Conn) { _ = conn.Close() })
	c := dial(t, srv)

	select {
	case <-c.PeerLeft:
	case <-time.After(3 * time.Second):
		t.Fatal("PeerLeft not signalled after the connection closed")
	}
}

// Malformed JSON is skipped, not fatal: one bad frame from a misbehaving proxy
// must not cost the rest of the session.
func TestReadLoopSkipsMalformedFrames(t *testing.T) {
	srv := testServer(t, func(conn *websocket.Conn) {
		_ = conn.WriteMessage(websocket.TextMessage, []byte("{not json"))
		_ = conn.WriteJSON(map[string]string{"type": "room-full"})
	})
	c := dial(t, srv)

	select {
	case <-c.RoomFull:
	case <-time.After(3 * time.Second):
		t.Fatal("room-full never arrived after a malformed frame")
	}
}
