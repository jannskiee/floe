package peer

// Which pion loggers write around newLoggerFactory (FU-40 review L1).

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"
)

// bypassLine is the only kind of line allowed on pion's default route: the
// mDNS server's "mdns" logger and the TURN client's "turnc", which pion/ice
// v4.4.0 builds from its own default factory (logging.go). The DTLS client for
// TURN over DTLS logs as "dtls" on that route too, but this pairing has no
// TURN server, so a dtls line there would be something new.
var bypassLine = regexp.MustCompile(`^(mdns|turn[a-z]*) (TRACE|DEBUG|INFO|WARNING|ERROR): `)

// bypassProbeScope names a default-factory logger the test builds itself,
// after New, to show that the pipe it reads is the one the default route
// writes to.
const bypassProbeScope = "floeprobe"

// TestOnlyMDNSAndTURNBypassTheLoggerFactory (FU-40 review L1) pairs two real
// connections on 127.0.0.1 at PION_LOG_TRACE=all, so that every pion logger
// that exists speaks, while the sender's socket trickles hostileUfrags to the
// receiver. peer.New hands pion the os.Stderr of the moment, so both News run
// with stderr on one pipe (the factory's writer) and the pairing runs with it
// on a second, where anything built from pion's default factory after New
// writes. The second pipe may carry mdns and turn lines and nothing else, and
// neither pipe may carry a raw control.
func TestOnlyMDNSAndTURNBypassTheLoggerFactory(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping an ICE loopback pairing in -short mode")
	}
	for _, prefix := range []string{"PION_LOG_", "PIONS_LOG_"} {
		for _, level := range []string{"DISABLE", "ERROR", "WARN", "INFO", "DEBUG", "TRACE"} {
			t.Setenv(prefix+level, "")
		}
	}
	t.Setenv("PION_LOG_TRACE", "all")

	url := pairRelay(t)
	sender := joinRelay(t, url, "sender")
	receiver := joinRelay(t, url, "receiver")
	select {
	case <-sender.PeerConnected:
	case <-time.After(5 * time.Second):
		t.Fatal("the relay never told the sender its peer arrived")
	}

	viaFactory := captureStderr(t)
	connS, err := New(nil, sender)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer closeAndWait(t, connS)
	connR, err := New(nil, receiver)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer closeAndWait(t, connR)
	aroundFactory := captureStderr(t)
	logging.NewDefaultLoggerFactory().NewLogger(bypassProbeScope).Errorf("the default route reaches this pipe")

	go func() {
		time.Sleep(300 * time.Millisecond)
		for _, u := range hostileUfrags {
			_ = sender.SendSignal(map[string]any{"candidate": map[string]any{
				"candidate": "candidate:1 1 udp 2130706431 192.0.2.1 5000 typ host ufrag " + u,
				"sdpMid":    "0",
			}})
		}
	}()
	type setup struct {
		dc  *webrtc.DataChannel
		err error
	}
	answered := make(chan setup, 1)
	go func() {
		dc, err := connR.SetupAsReceiver()
		answered <- setup{dc, err}
	}()
	dc, err := connS.SetupAsSender()
	if err != nil {
		t.Fatalf("SetupAsSender: %v", err)
	}
	if r := <-answered; r.err != nil {
		t.Fatalf("SetupAsReceiver: %v", r.err)
	}
	if err := dc.SendText(`{"type":"hello"}`); err != nil {
		t.Fatalf("SendText: %v", err)
	}
	select {
	case <-connR.Early().Msgs:
	case <-time.After(10 * time.Second):
		t.Fatal("the first message never crossed")
	}
	const dropped = 6 // the hostileUfrags pion can parse (logging_test.go)
	for deadline := time.Now().Add(5 * time.Second); strings.Count(viaFactory.String(), "dropping candidate") < dropped && time.Now().Before(deadline); {
		time.Sleep(20 * time.Millisecond)
	}
	closeAndWait(t, connS) // and whatever closing still logs
	closeAndWait(t, connR)
	around := aroundFactory.stop()
	via := viaFactory.stop()

	if !strings.Contains(around, bypassProbeScope+" ERROR: ") {
		t.Fatalf("a default-factory logger built after New did not reach the second pipe, so it cannot show a bypass: %q", around)
	}
	for _, line := range strings.Split(around, "\n") {
		if line == "" || strings.HasPrefix(line, bypassProbeScope+" ") {
			continue
		}
		if !bypassLine.MatchString(line) {
			t.Errorf("a pion logger other than mdns or turn writes around the factory: %q", line)
		}
	}
	for name, out := range map[string]string{"the factory's pipe": via, "the default route": around} {
		if bad := firstUnsafe(out); bad != "" {
			t.Errorf("%s carried %s raw", name, bad)
		}
	}
	if !strings.Contains(via, "ice TRACE: ") {
		t.Errorf("no ice TRACE line came through the factory, so PION_LOG_TRACE=all did not take and the run shows nothing")
	}
	if n := strings.Count(via, "dropping candidate"); n < dropped {
		t.Errorf("the factory's pipe holds %d dropped candidates, want %d", n, dropped)
	}
}

// pairRelay serves /ws on 127.0.0.1 with the two parts of server.js a pairing
// needs: the first join-room is seated as the sender and the second as the
// receiver, whose arrival the sender hears as user-connected, and a signal
// goes to the other seat.
func pairRelay(t *testing.T) string {
	t.Helper()
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	var mu sync.Mutex
	var seats []*relaySeat
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		me := &relaySeat{ws: ws}
		for {
			var m struct {
				Type   string          `json:"type"`
				Signal json.RawMessage `json:"signal"`
			}
			if ws.ReadJSON(&m) != nil {
				return
			}
			mu.Lock()
			if m.Type == "join-room" {
				seats = append(seats, me)
			}
			first := len(seats) == 1
			var others []*relaySeat
			for _, s := range seats {
				if s != me {
					others = append(others, s)
				}
			}
			mu.Unlock()
			switch {
			case m.Type == "join-room" && first:
				me.send(map[string]string{"type": "room-joined", "role": "sender"})
			case m.Type == "join-room":
				me.send(map[string]string{"type": "room-joined", "role": "receiver"})
				for _, s := range others {
					s.send(map[string]string{"type": "user-connected", "id": "receiver"})
				}
			case m.Type == "signal":
				for _, s := range others {
					s.send(map[string]any{"type": "signal", "signal": m.Signal})
				}
			}
		}
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// relaySeat is one pairRelay connection. gorilla/websocket allows one writer
// at a time, and both seats' read loops write to it.
type relaySeat struct {
	mu sync.Mutex
	ws *websocket.Conn
}

func (s *relaySeat) send(v any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.ws.WriteJSON(v)
}

// joinRelay connects to pairRelay, joins its room and checks the seat.
func joinRelay(t *testing.T, url, want string) *signaling.Client {
	t.Helper()
	sc, err := signaling.Connect(url)
	if err != nil {
		t.Fatalf("signaling.Connect: %v", err)
	}
	t.Cleanup(sc.Close)
	if err := sc.JoinRoom("floe-log-bypass"); err != nil {
		t.Fatalf("JoinRoom: %v", err)
	}
	select {
	case got := <-sc.Role:
		if got != want {
			t.Fatalf("the relay seated a %s, want a %s", got, want)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the relay seated nobody")
	}
	return sc
}
