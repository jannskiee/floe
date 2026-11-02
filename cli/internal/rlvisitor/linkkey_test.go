package main

// The visitor with a link key: the link it is given decides. A keyed link enforces,
// through the engine for -send and with a proof in front of a crafted frame, and -kc
// makes a visitor that fails honestly: a proof under another key, or none. The far
// end is a real engine receive on a fake request-room server.

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/jannskiee/floe/cli/engine/code"
	"github.com/jannskiee/floe/cli/engine/linkkey"
	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/jannskiee/floe/cli/engine/transfer"
)

const testRoom = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"

// fakeRoom is the request room over /ws: join-room seats the host, request-join seats
// the visitor and tells the host, and a signal goes to the other seat.
func fakeRoom(t *testing.T) string {
	t.Helper()
	var mu sync.Mutex
	var host, visitor *safeConn
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		me := &safeConn{ws: ws}
		for {
			var m struct {
				Type   string          `json:"type"`
				Signal json.RawMessage `json:"signal"`
			}
			if ws.ReadJSON(&m) != nil {
				return
			}
			switch m.Type {
			case "join-room":
				mu.Lock()
				host = me
				mu.Unlock()
				me.send(map[string]any{"type": "room-joined", "role": "host"})
			case "request-join":
				mu.Lock()
				visitor = me
				h := host
				mu.Unlock()
				me.send(map[string]any{"type": "request-joined", "role": "visitor"})
				h.send(map[string]any{"type": "user-connected", "id": "visitor"})
			case "signal":
				mu.Lock()
				to := host
				if me == host {
					to = visitor
				}
				mu.Unlock()
				to.send(map[string]any{"type": "signal", "signal": m.Signal, "sender": "peer"})
			}
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv.URL
}

type safeConn struct {
	ws *websocket.Conn
	mu sync.Mutex
}

func (c *safeConn) send(v map[string]any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.ws.WriteJSON(v)
}

// hostResult is how the real receive on the far end went.
type hostResult struct {
	err     error
	decided int
}

// keyedHost is the far end: seated first, it offers and receives with kc when the
// visitor comes, declining at Decide.
func keyedHost(t *testing.T, url, out string, kc *transfer.KeyCheck) <-chan hostResult {
	t.Helper()
	sc, err := signaling.Connect(url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sc.Close)
	if err := sc.JoinRoom(testRoom); err != nil {
		t.Fatal(err)
	}
	select {
	case <-sc.Role:
	case <-time.After(10 * time.Second):
		t.Fatal("the host was never seated")
	}
	res := make(chan hostResult, 1)
	go func() {
		select {
		case <-sc.PeerConnected:
		case <-time.After(30 * time.Second):
			res <- hostResult{err: errors.New("no visitor came")}
			return
		}
		conn, err := peer.New(nil, sc)
		if err != nil {
			res <- hostResult{err: err}
			return
		}
		defer conn.Close()
		dc, err := conn.SetupAsSender()
		if err != nil {
			res <- hostResult{err: err}
			return
		}
		early := conn.Early()
		var out2 hostResult
		out2.err = transfer.ReceiveFilesWithOptions(dc, out, false, "test", "", transfer.ReceiveOptions{
			OnProgress: func(transfer.Progress) {},
			Decide: func(in transfer.IncomingInfo) transfer.Decision {
				out2.decided++
				if in.FirstName == "go.bin" {
					return transfer.Decision{Kind: transfer.DecisionAccept}
				}
				return transfer.Decision{Kind: transfer.DecisionDecline}
			},
			Messages: early.Msgs,
			Closed:   early.Closed,
			KeyCheck: kc,
		})
		res <- out2
	}()
	return res
}

// runCaptured runs the visitor with its events in a file and returns the exit code
// and what it printed.
func runCaptured(t *testing.T, cfg config) (int, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "events.txt")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	prev := stdout
	stdout = f
	exit := run(cfg)
	stdout = prev
	f.Close()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return exit, string(raw)
}

func keyedFlags(t *testing.T, url string, extra ...string) (config, *transfer.KeyCheck) {
	t.Helper()
	key, err := linkkey.New()
	if err != nil {
		t.Fatal(err)
	}
	link := "https://floe.one/r/Xk3p9Q0aB1c#" + testRoom + "." + key.Encode()
	parsed, err := code.ParseRequestLink(link)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := parseFlags(append([]string{"-link", link, "-server", url, "-timeout", "60s"}, extra...))
	if err != nil {
		t.Fatalf("parseFlags: %v", err)
	}
	return cfg, &transfer.KeyCheck{Key: parsed.Key, RoomID: parsed.RoomID}
}

func wantNoKeyPrinted(t *testing.T, printed string, kc *transfer.KeyCheck) {
	t.Helper()
	if strings.Contains(printed, kc.Key.Encode()) {
		t.Fatalf("the key was printed:\n%s", printed)
	}
}

func oneFile(t *testing.T, name string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, make([]byte, 2048), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func wantHost(t *testing.T, res <-chan hostResult) hostResult {
	t.Helper()
	select {
	case r := <-res:
		return r
	case <-time.After(30 * time.Second):
		t.Fatal("the host did not end")
		return hostResult{}
	}
}

// The link decides: a keyed link's -send goes through the engine's enforce mode.
func TestKeyedLinkSendDelivers(t *testing.T) {
	url := fakeRoom(t)
	cfg, kc := keyedFlags(t, url, "-send", oneFile(t, "go.bin"))
	if cfg.kc == nil || !cfg.kc.Enforce {
		t.Fatalf("a keyed link does not enforce: %+v", cfg.kc)
	}
	out := t.TempDir()
	res := keyedHost(t, url, out, kc)
	exit, printed := runCaptured(t, cfg)
	if exit != exitDelivered {
		t.Fatalf("exit %d\n%s", exit, printed)
	}
	if r := wantHost(t, res); r.err != nil || r.decided != 1 {
		t.Fatalf("host: %+v", r)
	}
	wantNoKeyPrinted(t, printed, kc)
	if _, err := os.Stat(filepath.Join(out, "go.bin")); err != nil {
		t.Fatal(err)
	}
}

// -kc=bad on -send is an honest proof under another key: the visitor's own check of
// the host fails too, and it says so with its exit code. The host refuses it.
func TestKCBadSendIsUnverified(t *testing.T) {
	url := fakeRoom(t)
	cfg, kc := keyedFlags(t, url, "-send", oneFile(t, "go.bin"), "-kc", "bad")
	if cfg.kc == nil || cfg.kc.Key == kc.Key {
		t.Fatal("-kc=bad proves with the link's own key")
	}
	out := t.TempDir()
	res := keyedHost(t, url, out, kc)
	exit, printed := runCaptured(t, cfg)
	if exit != exitUnverified {
		t.Fatalf("exit %d, want %d\n%s", exit, exitUnverified, printed)
	}
	if r := wantHost(t, res); !errors.Is(r.err, transfer.ErrSenderNotConfirmed) || r.decided != 0 {
		t.Fatalf("host: %+v", r)
	}
	wantNoKeyPrinted(t, printed, kc)
	if !strings.Contains(printed, `"outcome":"unverified"`) {
		t.Fatalf("no unverified outcome:\n%s", printed)
	}
}

// -kc=none on -send sends no proof at all, so the host refuses the metadata.
func TestKCNoneSendIsRefusedAsUnverified(t *testing.T) {
	url := fakeRoom(t)
	cfg, kc := keyedFlags(t, url, "-send", oneFile(t, "go.bin"), "-kc", "none")
	if cfg.kc != nil {
		t.Fatal("-kc=none still proves")
	}
	out := t.TempDir()
	res := keyedHost(t, url, out, kc)
	exit, printed := runCaptured(t, cfg)
	if exit != exitUnverified {
		t.Fatalf("exit %d, want %d\n%s", exit, exitUnverified, printed)
	}
	if r := wantHost(t, res); !errors.Is(r.err, transfer.ErrSenderNotConfirmed) || r.decided != 0 {
		t.Fatalf("host: %+v", r)
	}
	if entries, _ := os.ReadDir(out); len(entries) != 0 {
		t.Fatalf("the host's folder holds %d entries", len(entries))
	}
}

// A crafted mode on a keyed link sends the proof first, so the crafted frame reaches
// the part of the host it is meant to test: here its Decide, which declines.
func TestCraftedModeProvesFirstOnAKeyedLink(t *testing.T) {
	url := fakeRoom(t)
	cfg, kc := keyedFlags(t, url, "-hostile-name")
	res := keyedHost(t, url, t.TempDir(), kc)
	exit, printed := runCaptured(t, cfg)
	if exit != exitPeerRefused {
		t.Fatalf("exit %d, want %d\n%s", exit, exitPeerRefused, printed)
	}
	if !strings.Contains(printed, `"code":"declined"`) {
		t.Fatalf("the host did not decline:\n%s", printed)
	}
	if r := wantHost(t, res); !errors.Is(r.err, transfer.ErrDeclined) || r.decided != 1 {
		t.Fatalf("host: %+v", r)
	}
}

// Crafted modes with a failing proof never reach it: the host refuses with the code
// and the visitor's exit code says so.
func TestCraftedModeFailingProofIsUnverified(t *testing.T) {
	for _, mode := range []string{"bad", "none"} {
		t.Run(mode, func(t *testing.T) {
			url := fakeRoom(t)
			cfg, kc := keyedFlags(t, url, "-hostile-name", "-kc", mode)
			res := keyedHost(t, url, t.TempDir(), kc)
			exit, printed := runCaptured(t, cfg)
			if exit != exitUnverified {
				t.Fatalf("exit %d, want %d\n%s", exit, exitUnverified, printed)
			}
			if r := wantHost(t, res); !errors.Is(r.err, transfer.ErrSenderNotConfirmed) || r.decided != 0 {
				t.Fatalf("host: %+v", r)
			}
		})
	}
}

// A bare link is as it was: no key, and -send with no proof.
func TestBareLinkHasNoKeyCheck(t *testing.T) {
	cfg, err := parseFlags([]string{"-link", "https://floe.one/r/Xk3p9Q0aB1c#" + testRoom, "-send", "a.bin"})
	if err != nil || cfg.kc != nil {
		t.Fatalf("a bare link: %+v, %v", cfg.kc, err)
	}
	cfg, err = parseFlags([]string{"-room", testRoom, "-send", "a.bin"})
	if err != nil || cfg.kc != nil {
		t.Fatalf("-room: %+v, %v", cfg.kc, err)
	}
}

func TestSendOutcomeWordsForTheKeyCheck(t *testing.T) {
	for name, c := range map[string]struct {
		err error
		by  string
	}{
		"its own check, a bad proof": {transfer.ErrReceiverNotConfirmed, "visitor"},
		"its own check, silence":     {transfer.ErrReceiverSilent, "visitor"},
		"the host refused it":        {&transfer.PeerStoppedError{Code: transfer.CodeUnverified}, "host"},
	} {
		ev, exit := sendOutcome(c.err)
		if exit != exitUnverified || ev["outcome"] != "unverified" || ev["by"] != c.by {
			t.Errorf("%s: %v, exit %d", name, ev, exit)
		}
	}
}
