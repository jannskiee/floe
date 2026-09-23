package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// A server that does not seat the visitor ends the run with exitNotJoined, not
// exitFailed, so CELL-06 tells host-absent from a transport failure by the exit
// code as well as the event word (WP-Q review 2, R2-1).
func TestRunNotJoinedHasItsOwnExitCode(t *testing.T) {
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		for {
			_, raw, err := ws.ReadMessage()
			if err != nil {
				return
			}
			var m struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(raw, &m) == nil && m.Type == "request-join" {
				_ = ws.WriteJSON(map[string]string{"type": "host-absent"})
			}
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	code := make(chan int, 1)
	go func() {
		code <- run(config{server: srv.URL, room: "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f", hostileName: true, timeout: 20 * time.Second})
	}()
	select {
	case got := <-code:
		if got != exitNotJoined {
			t.Fatalf("exit %d, want exitNotJoined (%d)", got, exitNotJoined)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("run did not end after host-absent")
	}
}
