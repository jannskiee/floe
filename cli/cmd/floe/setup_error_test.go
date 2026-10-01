package main

// A setup error can quote the peer's SDP (FU-40 review, the SDP residual).

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"unicode"

	"github.com/gorilla/websocket"
)

// hostileToken is an SDP network type made of terminal controls: clear the
// screen and home the cursor, write the clipboard with OSC 52, plant an OSC 8
// link. pion/sdp refuses it and quotes it in its error ("sdp: invalid value
// `...`"), which floe send and floe receive print after "WebRTC setup failed".
const hostileToken = "\x1b[2J\x1b[H\x1b]52;c;ZWNobyBwd25lZA==\x07\x1b]8;;http://evil.example/\x07CLICK\x1b]8;;\x07"

// hostileSDP carries hostileToken where the o= line's network type goes.
const hostileSDP = "v=0\r\no=- 1 2 " + hostileToken + " IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"

// hostilePeer serves, on 127.0.0.1, what floe send and floe receive ask a
// server for before they signal (the ICE list, a code), then seats the command
// as role and plays the other peer: a receiver gets hostileSDP as the offer,
// and a sender gets it as the answer to its own offer.
func hostilePeer(t *testing.T, role string) string {
	t.Helper()
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	var mu sync.Mutex
	var open []*websocket.Conn
	mux := http.NewServeMux()
	mux.HandleFunc("/api/turn-credentials", func(w http.ResponseWriter, _ *http.Request) {
		// A STUN address on the loopback, so no request leaves the machine.
		_, _ = io.WriteString(w, `[{"urls":"stun:127.0.0.1:9"}]`)
	})
	mux.HandleFunc("/api/code", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"code":"olive-tiger-castle"}`)
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		mu.Lock()
		open = append(open, ws)
		mu.Unlock()
		defer ws.Close()
		sendHostile := func(sdpType string) {
			_ = ws.WriteJSON(map[string]any{"type": "signal", "sender": "peer", "signal": map[string]string{"type": sdpType, "sdp": hostileSDP}})
		}
		for {
			var m struct {
				Type   string `json:"type"`
				Signal struct {
					Type string `json:"type"`
				} `json:"signal"`
			}
			if ws.ReadJSON(&m) != nil {
				return
			}
			switch {
			case m.Type == "join-room" && role == "receiver":
				_ = ws.WriteJSON(map[string]string{"type": "room-joined", "role": "receiver"})
				sendHostile("offer")
			case m.Type == "join-room":
				_ = ws.WriteJSON(map[string]string{"type": "room-joined", "role": "sender"})
				_ = ws.WriteJSON(map[string]string{"type": "user-connected", "id": "peer"})
			case m.Type == "signal" && m.Signal.Type == "offer":
				sendHostile("answer")
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

// runAgainst runs the real command tree the way main does, through cobra,
// against the server at url (typed as --server and set as FLOE_SERVER, so
// the run cannot fall back to the default server), and returns what cobra
// printed to its error writer: the line a user sees when a command fails. The
// receive flags a test may type go back to their defaults afterwards, since
// cobra keeps flag state between Execute calls.
func runAgainst(t *testing.T, url string, args ...string) string {
	t.Helper()
	resetSharedFlags(t)
	t.Setenv("FLOE_SERVER", url)
	t.Cleanup(func() {
		for _, name := range []string{"output", "yes", "no-report"} {
			if f := receiveCmd.Flags().Lookup(name); f != nil {
				_ = f.Value.Set(f.DefValue)
				f.Changed = false
			}
		}
	})
	var printed bytes.Buffer
	rootCmd.SetOut(io.Discard)
	rootCmd.SetErr(&printed)
	rootCmd.SetArgs(append(args, "--server", url))
	t.Cleanup(func() {
		rootCmd.SetOut(nil)
		rootCmd.SetErr(nil)
		rootCmd.SetArgs(nil)
	})
	if err := rootCmd.Execute(); err == nil {
		t.Fatalf("floe %s succeeded against a peer that sent a broken SDP", args[0])
	}
	return printed.String()
}

// requireEscapedSetupError: the printed line is the setup failure, it carries
// no raw control or format character, and the token's printable parts are
// still there, so the diagnostic survives. It checks that property rather
// than how the escape is spelled.
func requireEscapedSetupError(t *testing.T, printed string) {
	t.Helper()
	if !strings.Contains(printed, "WebRTC setup failed") {
		t.Fatalf("the command did not fail at the WebRTC setup: %q", printed)
	}
	for i, r := range strings.TrimSuffix(printed, "\n") {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			t.Fatalf("the error line reached the terminal with %U raw at %d: %q", r, i, printed)
		}
	}
	t.Logf("printed: %s", strings.TrimSuffix(printed, "\n")) // safe to log as is now
	for _, want := range []string{"[2J", "52;c;ZWNobyBwd25lZA==", "8;;http://evil.example/", "CLICK"} {
		if !strings.Contains(printed, want) {
			t.Errorf("the error line lost %q from the token: %q", want, printed)
		}
	}
}

// TestReceiveEscapesAHostileOffer (FU-40 review): the sender's offer quotes
// terminal controls into pion's parse error, and floe receive prints it.
func TestReceiveEscapesAHostileOffer(t *testing.T) {
	t.Setenv("FLOE_NO_STATS", "1")
	url := hostilePeer(t, "receiver")
	printed := runAgainst(t, url, "receive", url+"/#room=floe-hostile-sdp", "--no-report", "--output", t.TempDir())
	requireEscapedSetupError(t, printed)
}

// TestSendEscapesAHostileAnswer (FU-40 review): the receiver's answer quotes
// terminal controls into pion's parse error, and floe send prints it.
func TestSendEscapesAHostileAnswer(t *testing.T) {
	file := filepath.Join(t.TempDir(), "hello.txt")
	if err := os.WriteFile(file, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	url := hostilePeer(t, "sender")
	printed := runAgainst(t, url, "send", file)
	requireEscapedSetupError(t, printed)
}

// TestSetupErrorTextIsBounded (FU-40 review 2 L3): the server relays a signal
// of up to 1 MB, so a token pion/sdp quotes can be that long. The printed text
// stays one bounded line with no raw control, and a short error keeps its
// words.
func TestSetupErrorTextIsBounded(t *testing.T) {
	long := errors.New("sdp: invalid value `" + strings.Repeat("\x1b", 1<<20) + "`")
	got := setupErrorText(long)
	if n := len(got); n > 4*setupErrorMax+8 {
		t.Fatalf("setupErrorText printed %d bytes for a 1 MiB token, want at most %d", n, 4*setupErrorMax+8)
	}
	if !strings.HasSuffix(got, "…") {
		t.Errorf("a cut setup error does not end with the ellipsis: %q", got[len(got)-16:])
	}
	if strings.ContainsRune(got, 0x1b) {
		t.Errorf("a raw ESC survived in the bounded setup error")
	}
	short := errors.New("timed out establishing a connection")
	if got := setupErrorText(short); got != short.Error() {
		t.Errorf("setupErrorText(%q) = %q, want it unchanged", short.Error(), got)
	}
}
