package main

// The plain send's wait for a receiver ("Waiting for peer..."), and what it
// prints when that wait ends without one. Two things end it: this side's own
// connection to the signaling server is lost, or the server reports the other
// side gone. The send used to print one line for both, and it named the peer.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// waitingRoom seats a plain send as the sender and, once the send has
// registered its code (its role is assigned by then, and the wait for a
// receiver is next), ends that wait the way end says: "server-lost" closes the
// socket from the server's side, "peer-left" sends peer-disconnected and keeps
// the socket open.
func waitingRoom(t *testing.T, end string) string {
	t.Helper()
	registered := make(chan struct{})
	var once sync.Once
	var mu sync.Mutex
	var open []*websocket.Conn
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/turn-credentials", func(w http.ResponseWriter, _ *http.Request) {
		// A STUN address on the loopback, so no request leaves the machine.
		_, _ = io.WriteString(w, `[{"urls":"stun:127.0.0.1:9"}]`)
	})
	mux.HandleFunc("/api/code", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"code": "olive-tiger-castle"})
		once.Do(func() { close(registered) })
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		mu.Lock()
		open = append(open, ws)
		mu.Unlock()
		defer ws.Close()
		var wmu sync.Mutex
		for {
			var m struct {
				Type string `json:"type"`
			}
			if ws.ReadJSON(&m) != nil {
				return
			}
			if m.Type != "join-room" {
				continue
			}
			wmu.Lock()
			_ = ws.WriteJSON(map[string]string{"type": "room-joined", "role": "sender"})
			wmu.Unlock()
			go func() {
				select {
				case <-registered:
				case <-time.After(30 * time.Second):
					return
				}
				if end == "server-lost" {
					_ = ws.Close()
					return
				}
				wmu.Lock()
				_ = ws.WriteJSON(map[string]string{"type": "peer-disconnected"})
				wmu.Unlock()
			}()
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

// TestPlainSendWaitNamesWhatEndedIt: the two ends of the wait for a receiver
// print the two sentences the setup that follows it already prints for the
// same two causes (peer.ErrSignalingLost and peer.ErrPeerLeft), so a sender
// whose own network dropped is not told the other person left.
func TestPlainSendWaitNamesWhatEndedIt(t *testing.T) {
	for _, c := range []struct{ end, want string }{
		{"server-lost", "Error: the connection to the server was lost before the peer connected\n"},
		{"peer-left", "Error: the other side left before the connection was established\n"},
	} {
		t.Run(c.end, func(t *testing.T) {
			o := captureOutput(t)
			url := waitingRoom(t, c.end)
			src := filepath.Join(t.TempDir(), "note.txt")
			if err := os.WriteFile(src, []byte("hello"), 0o600); err != nil {
				t.Fatal(err)
			}
			r := startCLI(t, src, "--server", url).wait(t, 30*time.Second).read(o)
			if r.err == nil {
				t.Fatal("the send succeeded with no receiver, want exit 1")
			}
			if got := pionLog.ReplaceAllString(r.stderr, ""); got != c.want {
				t.Fatalf("stderr = %q, want %q\nstdout:\n%s", got, c.want, r.stdout)
			}
		})
	}
}
