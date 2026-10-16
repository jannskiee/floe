package main

// What floe send and floe receive print when the server turns the connection
// away by its per-network limit: a Floe server accepts the upgrade and closes
// the socket at once with 1008 (server.js, checkRateLimit), and both commands
// used to read that as a lost connection or a failed write.

import (
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
	"github.com/jannskiee/floe/cli/engine/signaling"
)

// limitLine is the line both commands end on, Floe Desktop's sentence as the
// owner approved it for the CLI (2026-10-16), behind cobra's "Error: ".
const limitLine = "Error: the server is limiting connections from this network. Wait a minute and try again.\n"

// limitedServer answers the ICE fetch with a STUN address on the loopback and
// closes every /ws socket with 1008 and the server's own reason. A real
// server closes at once, so the join-room write races the close; with
// afterJoin the close waits for the join, so the wait for a role sees it.
func limitedServer(t *testing.T, afterJoin bool, code int) string {
	t.Helper()
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/turn-credentials", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `[{"urls":"stun:127.0.0.1:9"}]`)
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		if afterJoin {
			_, _, _ = ws.ReadMessage()
		}
		_ = ws.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(code, "Rate limit exceeded"),
			time.Now().Add(time.Second))
		time.Sleep(200 * time.Millisecond)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv.URL
}

// TestSendAndReceiveNameTheConnectionLimit: a connection the server turns
// away right after the upgrade ends floe send and floe receive on the limit
// line, whichever of the two the close reaches first: the join-room write or
// the wait for a role. Nothing had started, and waiting a minute is the fix.
func TestSendAndReceiveNameTheConnectionLimit(t *testing.T) {
	for _, form := range []struct {
		name      string
		afterJoin bool
	}{
		{"the close races the join", false},
		{"the close ends the wait for a role", true},
	} {
		t.Run("send/"+form.name, func(t *testing.T) {
			o := captureOutput(t)
			url := limitedServer(t, form.afterJoin, websocket.ClosePolicyViolation)
			src := filepath.Join(t.TempDir(), "note.txt")
			if err := os.WriteFile(src, []byte("hello"), 0o600); err != nil {
				t.Fatal(err)
			}
			r := startCLI(t, src, "--server", url).wait(t, 30*time.Second).read(o)
			if r.err == nil {
				t.Fatal("the send succeeded against a server that turned it away")
			}
			if got := pionLog.ReplaceAllString(r.stderr, ""); got != limitLine {
				t.Fatalf("stderr = %q, want %q", got, limitLine)
			}
		})
		t.Run("receive/"+form.name, func(t *testing.T) {
			url := limitedServer(t, form.afterJoin, websocket.ClosePolicyViolation)
			room := uuid.New().String()
			_, stderr, err := receiveWith(t, nil, "https://files.example.com/#room="+room, "--server", url)
			if err == nil {
				t.Fatal("the receive succeeded against a server that turned it away")
			}
			if stderr != limitLine {
				t.Fatalf("stderr = %q, want %q", stderr, limitLine)
			}
			if strings.Contains(stderr, room) {
				t.Fatalf("the room id was printed: %q", stderr)
			}
		})
	}
}

// TestJoinWriteAfterTheCloseNamesTheLimit holds the race above to the form
// it can lose: the read loop has recorded the close before the join-room
// write, so the write fails with "websocket: close sent". Only a 1008 is the
// limit; any other code keeps the failed-join words.
func TestJoinWriteAfterTheCloseNamesTheLimit(t *testing.T) {
	for _, c := range []struct {
		code int
		want string
	}{
		{websocket.ClosePolicyViolation, errLimited.Error()},
		{websocket.CloseGoingAway, "failed to join room: websocket: close sent"},
	} {
		sc, err := signaling.Connect(limitedServer(t, false, c.code))
		if err != nil {
			t.Fatal(err)
		}
		select {
		case <-sc.Down:
		case <-time.After(5 * time.Second):
			t.Fatal("the socket was never closed")
		}
		werr := sc.JoinRoom(uuid.New().String())
		if werr == nil {
			t.Fatalf("code %d: the join-room write succeeded on a closed socket", c.code)
		}
		if got := joinFailed(sc, werr).Error(); got != c.want {
			t.Fatalf("code %d: %q, want %q", c.code, got, c.want)
		}
		sc.Close()
	}
}

// TestOtherClosesBeforeARoleKeepTheirWords: a server that closes the socket
// before a role with any other code is not named as limiting anything, so
// the line it gets is the one it always had.
func TestOtherClosesBeforeARoleKeepTheirWords(t *testing.T) {
	url := limitedServer(t, true, websocket.CloseGoingAway)
	_, stderr, err := receiveWith(t, nil, "https://files.example.com/#room="+uuid.New().String(), "--server", url)
	if err == nil {
		t.Fatal("the receive succeeded against a server that closed the socket")
	}
	if want := "Error: connection closed before the server assigned a role\n"; stderr != want {
		t.Fatalf("stderr = %q, want %q", stderr, want)
	}
}

// TestSendToNamesTheConnectionLimit: floe send --to turned away by the same
// limit ends on its own approved line (the owner, 2026-10-16), whether the
// close reaches the request-join write or the wait for an answer first, and a
// socket the server closed for any other reason keeps the couldn't-connect line.
func TestSendToNamesTheConnectionLimit(t *testing.T) {
	for _, c := range []struct {
		name      string
		afterJoin bool
		code      int
		want      string
	}{
		{"the close races the join", false, websocket.ClosePolicyViolation, lineLimited},
		{"the close ends the wait for an answer", true, websocket.ClosePolicyViolation, lineLimited},
		{"a close for another reason", true, websocket.CloseGoingAway, lineCouldNotConnect},
	} {
		t.Run(c.name, func(t *testing.T) {
			o := captureOutput(t)
			url := limitedServer(t, c.afterJoin, c.code)
			p, _ := oneFile(t, t.TempDir(), "a.bin", 16)
			r := runCLI(t, p, "--to", linkFor(), "--server", url).read(o)
			wantOutcome(t, r, c.want)
		})
	}
}
