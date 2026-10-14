package main

// The lines floe send and floe receive end on when a start step fails: the
// WebRTC peer that cannot be made (A4-B23) and the /ws handshake a server or
// a proxy answers with an HTTP status (H-1). Every server here is an
// httptest one on the loopback.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/gorilla/websocket"
)

// startServer answers the ICE fetch with ice and the code registration, and
// /ws with wsStatus and no upgrade, or, when wsStatus is 0, seats a join as
// role: a "sender" is also told at once that a receiver is there.
func startServer(t *testing.T, ice string, wsStatus int, role string) string {
	t.Helper()
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	var mu sync.Mutex
	var open []*websocket.Conn
	mux := http.NewServeMux()
	mux.HandleFunc("/api/turn-credentials", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, ice)
	})
	mux.HandleFunc("/api/code", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"code": "olive-tiger-castle"})
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		if wsStatus != 0 {
			// A body a proxy would send. None of it may reach the line.
			w.WriteHeader(wsStatus)
			_, _ = io.WriteString(w, "<html>\x1b[2J proxy page</html>")
			return
		}
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		mu.Lock()
		open = append(open, ws)
		mu.Unlock()
		defer ws.Close()
		for {
			var m struct {
				Type string `json:"type"`
			}
			if ws.ReadJSON(&m) != nil {
				return
			}
			if m.Type == "join-room" {
				_ = ws.WriteJSON(map[string]string{"type": "room-joined", "role": role})
				if role == "sender" {
					_ = ws.WriteJSON(map[string]string{"type": "user-connected", "id": "peer"})
				}
			}
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(func() {
		mu.Lock()
		for _, ws := range open {
			_ = ws.Close()
		}
		mu.Unlock()
		srv.Close()
	})
	return srv.URL
}

// sendFile is a one-file argument for floe send.
func sendFile(t *testing.T) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "hello.txt")
	if err := os.WriteFile(file, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	return file
}

// TestPeerConnectionFailureSaysItOnce (A4-B23): a peer connection pion will
// not make (here, an ICE list with a URL it cannot parse) ends both commands
// on "failed to create peer connection" once. The engine and the command
// each used to add the words, so the line read them twice.
func TestPeerConnectionFailureSaysItOnce(t *testing.T) {
	const ice = `[{"urls":"bogus:127.0.0.1:9"}]`
	t.Setenv("FLOE_NO_STATS", "1")
	for _, c := range []struct {
		name, role string
		args       func(url string) []string
	}{
		{"floe receive", "receiver", func(url string) []string {
			return []string{"receive", url + "/#room=6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f", "--no-report", "--output", t.TempDir()}
		}},
		{"floe send", "sender", func(string) []string { return []string{"send", sendFile(t)} }},
	} {
		t.Run(c.name, func(t *testing.T) {
			url := startServer(t, ice, 0, c.role)
			printed := runAgainst(t, url, c.args(url)...)
			if !strings.HasPrefix(printed, "Error: failed to create peer connection: ") {
				t.Fatalf("printed %q, want the peer connection line", printed)
			}
			if n := strings.Count(printed, "failed to create peer connection"); n != 1 {
				t.Fatalf("the words are there %d times: %q", n, printed)
			}
		})
	}
}

// TestRefusedHandshakeNamesTheLikelyCause (H-1): a /ws upgrade answered with
// an HTTP status keeps the line it has always printed, status included, and
// adds one fixed sentence where the cause is known: 403 is the server's
// Origin check, which a reverse proxy that rewrites the Host header trips,
// and 404 is a proxy that does not forward /ws, or an address that is not a
// Floe server. Any other status adds nothing. The outer "failed to connect to
// signaling server" stays: the transfer audit's classifiers read it.
func TestRefusedHandshakeNamesTheLikelyCause(t *testing.T) {
	const ice = `[{"urls":"stun:127.0.0.1:9"}]`
	t.Setenv("FLOE_NO_STATS", "1")
	for _, c := range []struct {
		status int
		hint   string
	}{
		{403, ". A reverse proxy in front of the server may be changing the Host header: make it pass Host through unchanged."},
		{404, ". Check the server address, and that a reverse proxy in front of the server forwards /ws with the WebSocket upgrade."},
		{502, ""},
	} {
		for _, cmd := range []string{"receive", "send"} {
			t.Run(cmd+" "+http.StatusText(c.status), func(t *testing.T) {
				url := startServer(t, ice, c.status, "")
				args := []string{"send", sendFile(t)}
				if cmd == "receive" {
					args = []string{"receive", url + "/#room=6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f", "--no-report", "--output", t.TempDir()}
				}
				printed := runAgainst(t, url, args...)
				ws := "ws" + strings.TrimPrefix(url, "http") + "/ws"
				want := "Error: failed to connect to signaling server: cannot connect to signaling server at " + ws +
					": websocket: bad handshake (HTTP " + strconv.Itoa(c.status) + ")" + c.hint + "\n"
				if printed != want {
					t.Fatalf("printed\n%q\nwant\n%q", printed, want)
				}
			})
		}
	}
}
