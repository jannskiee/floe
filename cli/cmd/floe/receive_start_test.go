package main

// How floe receive starts: what it says when the room it joins is empty, and
// when it makes the output folder (-o). Every server here is an httptest one
// on the loopback.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// emptyRoom stands in for a server whose room the sender has left. It answers
// the ICE fetch (a STUN address on the loopback, so nothing leaves the
// machine), resolves any code to room, and seats whoever joins as "sender",
// the first seat of an empty room, which is what a receiver is handed once
// nobody is sharing. joins counts the join-room frames it read.
func emptyRoom(t *testing.T, room string) (url string, joins *atomic.Int32) {
	t.Helper()
	joins = &atomic.Int32{}
	var mu sync.Mutex
	var open []*websocket.Conn
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/turn-credentials", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `[{"urls":"stun:127.0.0.1:9"}]`)
	})
	mux.HandleFunc("/api/code/", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"roomId": room})
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
		for {
			var m struct {
				Type string `json:"type"`
			}
			if ws.ReadJSON(&m) != nil {
				return
			}
			if m.Type == "join-room" {
				joins.Add(1)
				_ = ws.WriteJSON(map[string]string{"type": "room-joined", "role": "sender"})
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
	return srv.URL, joins
}

// TestReceiveIntoAnEmptyRoomNamesTheCodeOrLink: a receiver seated first is in
// a room nobody is sharing from, whether it came by a code or by a pasted
// link (a link has no code in it), so the line names both and says whom to
// ask.
func TestReceiveIntoAnEmptyRoomNamesTheCodeOrLink(t *testing.T) {
	room := uuid.New().String()
	url, joins := emptyRoom(t, room)
	const want = "Error: this code or link is no longer active; ask the sender for a new one\n"
	for name, input := range map[string]string{
		"a pasted link": "https://files.example.com/#room=" + room,
		"a code":        "olive-tiger-castle",
	} {
		t.Run(name, func(t *testing.T) {
			before := joins.Load()
			_, stderr, err := receiveWith(t, nil, input, "--server", url)
			if err == nil {
				t.Fatal("receive succeeded in a room with no sender")
			}
			if joins.Load() != before+1 {
				t.Fatalf("the receive joined %d time(s), want once", joins.Load()-before)
			}
			if stderr != want {
				t.Fatalf("stderr is %q, want %q", stderr, want)
			}
			if strings.Contains(stderr, room) {
				t.Fatalf("the room id was printed: %q", stderr)
			}
		})
	}
}

// TestReceiveLeavesNoOutputFolderWhenItCannotStart: a receive that ends
// before it is seated, at any of its four steps, leaves no folder behind for
// an -o that did not exist. It used to make the folder first and leave it
// empty.
func TestReceiveLeavesNoOutputFolderWhenItCannotStart(t *testing.T) {
	room := uuid.New().String()
	url, _ := emptyRoom(t, room)
	noSocket := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(noSocket.Close)
	link := "https://files.example.com/#room=" + room
	cases := []struct {
		name string
		// stub is the one server the stubbed network allows, "" for none; nil
		// leaves the real calls, which reach only the loopback server.
		stub *string
		args []string
		want string
	}{
		{"the ICE fetch fails", new(string), []string{link, "--server", url}, "Error: failed to fetch ICE credentials: "},
		{"--relay-only and no relay", nil, []string{link, "--server", url, "--relay-only"}, "Error: --relay-only needs a TURN relay and " + url + " offers none"},
		{"the signaling connect fails", &noSocket.URL, []string{link, "--server", noSocket.URL}, "Error: failed to connect to signaling server: "},
		{"the room is empty", nil, []string{link, "--server", url}, "Error: this code or link is no longer active"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if c.stub != nil {
				stubNetwork(t, *c.stub)
			}
			// --relay-only is a root flag, which receiveInto does not put back.
			t.Cleanup(func() {
				f := rootCmd.PersistentFlags().Lookup("relay-only")
				_ = f.Value.Set(f.DefValue)
				f.Changed = false
			})
			base := t.TempDir()
			out := filepath.Join(base, "new", "nested")
			_, stderr, err := receiveInto(t, nil, out, c.args...)
			if err == nil || !strings.HasPrefix(stderr, c.want) {
				t.Fatalf("the receive ended on %q (error %v), want it to begin %q", stderr, err, c.want)
			}
			if _, statErr := os.Stat(filepath.Join(base, "new")); !os.IsNotExist(statErr) {
				t.Fatalf("a receive that never started left %s behind (stat error %v)", filepath.Join(base, "new"), statErr)
			}
		})
	}
}

// TestReceiveRefusesAnOutputFolderItCannotMakeBeforeItJoins: an -o that
// cannot be made is still reported before any network call that follows the
// lookup, so the sender's code is not used up and the same code works once
// the folder is fixed (CLAUDE.md, Room Codes: every failure before the join
// stays retryable). Nothing on disk changes.
func TestReceiveRefusesAnOutputFolderItCannotMakeBeforeItJoins(t *testing.T) {
	room := uuid.New().String()
	base := t.TempDir()
	taken := filepath.Join(base, "taken")
	if err := os.WriteFile(taken, []byte("a file, not a folder"), 0o600); err != nil {
		t.Fatal(err)
	}
	for name, out := range map[string]string{
		"a file where the folder goes":  taken,
		"a file above where it goes":    filepath.Join(taken, "sub"),
		"a file two levels above where": filepath.Join(taken, "sub", "deeper"),
	} {
		t.Run(name, func(t *testing.T) {
			calls := stubNetwork(t, "")
			_, stderr, err := receiveInto(t, nil, out, "https://files.example.com/#room="+room, "--server", closedServer)
			if want := "Error: cannot create output directory " + out + ": "; err == nil || !strings.HasPrefix(stderr, want) {
				t.Fatalf("the receive ended on %q (error %v), want it to begin %q", stderr, err, want)
			}
			if n, c := calls.ice.Load(), calls.connect.Load(); n != 0 || c != 0 {
				t.Fatalf("ICE fetches %d, signaling connects %d before the folder was refused; want none", n, c)
			}
			if got, readErr := os.ReadFile(taken); readErr != nil || string(got) != "a file, not a folder" {
				t.Fatalf("the file in the way changed: %q, %v", got, readErr)
			}
			if entries, _ := os.ReadDir(base); len(entries) != 1 {
				t.Fatalf("the refused receive left %d entries beside the file, want the file alone", len(entries))
			}
		})
	}
}

// TestReceiveRefusesAnOutputFolderItMayNotMakeBeforeItJoins: the same for an
// -o under a folder this account may not write to, which nothing short of
// making the folder can tell. Skipped where a folder's mode does not stop a
// new entry: on Windows, and for root.
func TestReceiveRefusesAnOutputFolderItMayNotMakeBeforeItJoins(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("a folder's mode does not refuse a new entry here")
	}
	locked := filepath.Join(t.TempDir(), "locked")
	if err := os.Mkdir(locked, 0o500); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(locked, "new")
	calls := stubNetwork(t, "")
	_, stderr, err := receiveInto(t, nil, out, "https://files.example.com/#room="+uuid.New().String(), "--server", closedServer)
	if want := "Error: cannot create output directory " + out + ": "; err == nil || !strings.HasPrefix(stderr, want) {
		t.Fatalf("the receive ended on %q (error %v), want it to begin %q", stderr, err, want)
	}
	if n, c := calls.ice.Load(), calls.connect.Load(); n != 0 || c != 0 {
		t.Fatalf("ICE fetches %d, signaling connects %d before the folder was refused; want none", n, c)
	}
}

// TestReceiveKeepsFoldersThatWereAlreadyThere: the check before the join
// removes only what it made itself. An -o that existed, empty, is still
// there after a receive that could not start, and so is the existing parent
// of one that did not.
func TestReceiveKeepsFoldersThatWereAlreadyThere(t *testing.T) {
	room := uuid.New().String()
	link := "https://files.example.com/#room=" + room
	base := t.TempDir()
	existing := filepath.Join(base, "inbox")
	if err := os.Mkdir(existing, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, out := range []string{existing, filepath.Join(existing, "today")} {
		stubNetwork(t, "")
		if _, stderr, err := receiveInto(t, nil, out, link, "--server", closedServer); err == nil || !strings.HasPrefix(stderr, "Error: failed to fetch ICE credentials: ") {
			t.Fatalf("the receive ended on %q (error %v), want the ICE fetch failure", stderr, err)
		}
		if fi, err := os.Stat(existing); err != nil || !fi.IsDir() {
			t.Fatalf("the folder that was already there is gone after -o %s: %v", out, err)
		}
		if _, err := os.Stat(filepath.Join(existing, "today")); !os.IsNotExist(err) {
			t.Fatalf("a receive that never started left %s behind", filepath.Join(existing, "today"))
		}
	}
}

// TestReceiveMakesTheOutputFolderWhenAFileIsSaved: an -o that does not exist
// is made when the first file is saved, and the file lands in it.
func TestReceiveMakesTheOutputFolderWhenAFileIsSaved(t *testing.T) {
	url, _ := plainRoom(t)
	src := filepath.Join(t.TempDir(), "only.txt")
	if err := os.WriteFile(src, []byte("only file"), 0o600); err != nil {
		t.Fatal(err)
	}
	room := uuid.New().String()
	_, result := engineSender(t, url, room, []string{src})
	out := filepath.Join(t.TempDir(), "new", "nested")
	_, stderr, err := receiveInto(t, nil, out, url+"/#room="+room, "--server", url, "-y")
	if err != nil {
		t.Fatalf("the receive failed: %v\nstderr:\n%s", err, stderr)
	}
	select {
	case sendErr := <-result:
		if sendErr != nil {
			t.Fatalf("the send failed: %v", sendErr)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the send never ended")
	}
	if got, readErr := os.ReadFile(filepath.Join(out, "only.txt")); readErr != nil || string(got) != "only file" {
		t.Fatalf("the file in the new folder: %q, %v", got, readErr)
	}
}

// TestReceiveDeclinedAtThePromptLeavesNoOutputFolder: answering n at
// "Accept? [Y/n]" saves nothing, so an -o that did not exist is not made.
func TestReceiveDeclinedAtThePromptLeavesNoOutputFolder(t *testing.T) {
	url, _ := plainRoom(t)
	src := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(src, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := stdinW.WriteString("n\n"); err != nil {
		t.Fatal(err)
	}
	_ = stdinW.Close()
	prevStdin := os.Stdin
	os.Stdin = stdinR
	t.Cleanup(func() {
		os.Stdin = prevStdin
		_ = stdinR.Close()
	})
	room := uuid.New().String()
	engineSender(t, url, room, []string{src})
	base := t.TempDir()
	out := filepath.Join(base, "new", "nested")
	_, stderr, runErr := receiveInto(t, nil, out, url+"/#room="+room, "--server", url)
	if runErr == nil || stderr != "Error: transfer declined\n" {
		t.Fatalf("the receive ended on %q (error %v), want the decline", stderr, runErr)
	}
	if _, statErr := os.Stat(filepath.Join(base, "new")); !os.IsNotExist(statErr) {
		t.Fatalf("a declined receive left %s behind (stat error %v)", filepath.Join(base, "new"), statErr)
	}
}
