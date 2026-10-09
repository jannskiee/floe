package main

// The TURN client's log line (FU-32 F2-1), read the way the floe binary runs:
// this test binary starts as floe does, so whatever floe does at process
// start has happened by the time these tests run. Nothing here names
// pionlog.go's own symbols, so the file runs as it is against a tree that
// predates them.

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/pion/logging"
	"github.com/pion/stun/v3"
	"github.com/pion/turn/v5"
	"github.com/pion/webrtc/v4"
)

// pionLevelChosen reports whether whoever runs the tests turned a pion log
// level on, which floe leaves as it is: any PION_LOG_ or PIONS_LOG_ ERROR,
// WARN, INFO, DEBUG or TRACE that is not empty. A DISABLE variable alone
// only ever turns logging off, and floe adds turnc to it.
func pionLevelChosen() bool {
	for _, prefix := range []string{"PION_LOG_", "PIONS_LOG_"} {
		for _, level := range []string{"ERROR", "WARN", "INFO", "DEBUG", "TRACE"} {
			if os.Getenv(prefix+level) != "" {
				return true
			}
		}
	}
	return false
}

// turncErrorLine is the TURN client's ERROR line as pion/turn v5.0.13 writes
// it when a permission refresh gets an error response, the reason quoted.
const turncErrorLine = "Fail to refresh permissions: %s"

// TestTURNClientLogIsQuietFromTheStart: from process start, pion's default
// logger factory, the one pion/ice v4.4.0 gives its TURN client, prints
// nothing for the "turnc" scope, while every other scope keeps pion's default
// ERROR level. Before, it printed the TURN client's ERROR line, reason and all.
func TestTURNClientLogIsQuietFromTheStart(t *testing.T) {
	if pionLevelChosen() {
		t.Skip("a PION_LOG_* or PIONS_LOG_* level is set for this run, and floe leaves those alone")
	}
	var buf bytes.Buffer
	f := logging.NewDefaultLoggerFactory()
	f.Writer = &buf
	f.NewLogger("turnc").Errorf(turncErrorLine, "CreatePermission error response (error 403: \x1b[2J)")
	if buf.Len() != 0 {
		t.Fatalf("pion's default factory printed the TURN client's ERROR line: %q", buf.String())
	}
	// The control is a scope no pion package uses, so no runner's own
	// PION_LOG_DISABLE (ice is a common one) names it; pion gives an unknown
	// scope its default level.
	f.NewLogger("floe-control").Errorf("still printed")
	if !strings.Contains(buf.String(), "floe-control ERROR: ") {
		t.Fatalf("a scope other than turnc lost pion's default ERROR level: %q", buf.String())
	}
}

// TestMuxLogIsQuietFromTheStart (deep QA QA-07): from process start, a
// factory built from pion's default, as peer.New builds the one pion/webrtc
// gives its packet mux, prints nothing for the "mux" scope. Before, a stalled
// send printed its ERROR line once per datagram, 174 times in one QA run.
func TestMuxLogIsQuietFromTheStart(t *testing.T) {
	if pionLevelChosen() {
		t.Skip("a PION_LOG_* or PIONS_LOG_* level is set for this run, and floe leaves those alone")
	}
	var buf bytes.Buffer
	f := logging.NewDefaultLoggerFactory()
	f.Writer = &buf
	f.NewLogger("mux").Errorf("failed to read from packetio.Buffer %s", "short buffer")
	if buf.Len() != 0 {
		t.Fatalf("pion's default factory printed the mux's ERROR line: %q", buf.String())
	}
	f.NewLogger("floe-control").Errorf("still printed")
	if !strings.Contains(buf.String(), "floe-control ERROR: ") {
		t.Fatalf("a scope other than mux lost pion's default ERROR level: %q", buf.String())
	}
}

// forgedReason is the reason phrase the on-path shim puts in its 403: an
// OSC 52 clipboard write, a screen clear, and a CR LF that starts a line
// passing for floe's own.
const forgedReason = "\x1b]52;c;U0tFUFRJQw==\x07\x1b[2J\r\n  Floe: forged line from the shim"

// TestForgedTURNRefreshErrorReachesNoTerminal is F2-1 end to end through
// floe's own peer.New. It is slow, so it runs only with
// FLOE_TEST_TURN_REFRESH=1: pion/turn refreshes a relay permission every
// 120 s and pion/ice sets no shorter interval, so a run takes about 125 s.
//
// Two peers pair, relay only, through a real pion/turn server on a local
// address (pion/ice binds each TURN client to an interface address, which on
// Windows cannot reach 127.0.0.1; FLOE_TEST_TURN_IP picks the address). The
// victim reaches the server through a UDP shim that stands in for an on-path
// party: it forwards everything, one upstream socket per client as a NAT
// would, and from a minute on answers every CreatePermission request itself
// with a 403 on the request's transaction id and forgedReason. pion/turn
// takes it, and its ERROR line quotes the reason; nothing of it may reach
// stderr raw.
func TestForgedTURNRefreshErrorReachesNoTerminal(t *testing.T) {
	if os.Getenv("FLOE_TEST_TURN_REFRESH") != "1" {
		t.Skip("set FLOE_TEST_TURN_REFRESH=1 to run this two-minute test")
	}
	if pionLevelChosen() {
		t.Skip("a PION_LOG_* or PIONS_LOG_* level is set for this run, and floe leaves those alone")
	}
	ip := turnTestIP(t)
	shimAddr, srvAddr, user, pass, sh := forgingTURN(t, ip, time.Minute)
	t.Logf("TURN server %s, on-path shim %s", srvAddr, shimAddr)

	url := pairingRelay(t)
	sender := joinPairing(t, url, "sender")
	receiver := joinPairing(t, url, "receiver")
	select {
	case <-sender.PeerConnected:
	case <-time.After(5 * time.Second):
		t.Fatal("the relay never told the sender its peer arrived")
	}

	stderr := captureStderr(t)
	victim := []webrtc.ICEServer{{URLs: []string{"turn:" + shimAddr + "?transport=udp"}, Username: user, Credential: pass}}
	other := []webrtc.ICEServer{{URLs: []string{"turn:" + srvAddr + "?transport=udp"}, Username: user, Credential: pass}}
	connS, err := peer.New(victim, sender, peer.WithRelayOnly())
	if err != nil {
		t.Fatalf("peer.New: %v", err)
	}
	defer connS.Close()
	connR, err := peer.New(other, receiver, peer.WithRelayOnly())
	if err != nil {
		t.Fatalf("peer.New: %v", err)
	}
	defer connR.Close()

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
	case <-time.After(15 * time.Second):
		t.Fatal("the first message never crossed")
	}
	t.Logf("connected at +%s; CreatePermission requests the shim saw so far: %d",
		time.Since(sh.start).Round(time.Millisecond), sh.perms.Load())

	// Until the line shows, or for 5 s after the first forged answer when it
	// never does, the channel kept busy as a transfer keeps it.
	for deadline := time.Now().Add(170 * time.Second); time.Now().Before(deadline); {
		if strings.Contains(stderr.String(), "Fail to refresh permissions") {
			break
		}
		if first := sh.firstForge.Load(); first > 0 && time.Since(sh.start) > time.Duration(first)*time.Millisecond+5*time.Second {
			break
		}
		_ = dc.SendText(`{"type":"tick"}`)
		time.Sleep(500 * time.Millisecond)
	}
	connS.Close()
	connR.Close()
	time.Sleep(2 * time.Second) // pion's goroutines log on their way out; let them finish before the pipe goes
	out := stderr.stop()

	t.Logf("shim: CreatePermission requests seen %d, answered with the forged 403 %d (first at +%d ms)",
		sh.perms.Load(), sh.forged.Load(), sh.firstForge.Load())
	for _, line := range strings.SplitAfter(out, "\n") {
		if line != "" {
			t.Logf("stderr (quoted): %q", line)
		}
	}
	if sh.forged.Load() == 0 {
		t.Fatal("no permission refresh reached the shim after the first minute, so the run shows nothing")
	}
	requireNoRawControl(t, "stderr after a forged TURN refresh error", out)
}

// turnTestIP is FLOE_TEST_TURN_IP, or the first private IPv4 address of an
// interface that is up and not the loopback.
func turnTestIP(t *testing.T) string {
	t.Helper()
	if v := os.Getenv("FLOE_TEST_TURN_IP"); v != "" {
		return v
	}
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok {
				if ip4 := ipn.IP.To4(); ip4 != nil && ip4.IsPrivate() {
					return ip4.String()
				}
			}
		}
	}
	t.Skip("no private IPv4 address on an interface that is up; set FLOE_TEST_TURN_IP")
	return ""
}

// turnShim counts what the on-path shim saw and did.
type turnShim struct {
	start      time.Time
	perms      atomic.Int64
	forged     atomic.Int64
	firstForge atomic.Int64 // ms after start, 0 until the first forged answer
}

// forgingTURN starts a pion/turn server on ip and, in front of it, the
// on-path shim, which forges the answer to every CreatePermission request
// from forgeAfter on. It returns both addresses and one set of long-term
// credentials the server takes.
func forgingTURN(t *testing.T, ip string, forgeAfter time.Duration) (shimAddr, srvAddr, user, pass string, sh *turnShim) {
	t.Helper()
	// The server listens on a LAN address for the two minutes of the run (it
	// cannot be the loopback: peer.New gathers no loopback interface), so its
	// secret is new each run and never one a host on that LAN could read here.
	key := make([]byte, 16)
	if _, err := rand.Read(key); err != nil {
		t.Fatalf("TURN secret: %v", err)
	}
	secret := hex.EncodeToString(key)
	srvConn, err := net.ListenPacket("udp4", ip+":0")
	if err != nil {
		t.Fatalf("TURN server socket: %v", err)
	}
	quiet := logging.NewDefaultLoggerFactory()
	quiet.Writer = &bytes.Buffer{}
	srv, err := turn.NewServer(turn.ServerConfig{
		Realm:         "floe.test",
		AuthHandler:   turn.NewLongTermAuthHandler(secret, quiet.NewLogger("auth")),
		LoggerFactory: quiet,
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn:            srvConn,
			RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{RelayAddress: net.ParseIP(ip), Address: ip},
		}},
	})
	if err != nil {
		t.Fatalf("TURN server: %v", err)
	}
	t.Cleanup(func() { _ = srv.Close() })

	shim, err := net.ListenPacket("udp4", ip+":0")
	if err != nil {
		t.Fatalf("shim socket: %v", err)
	}
	t.Cleanup(func() { _ = shim.Close() })
	sh = &turnShim{start: time.Now()}
	var mu sync.Mutex
	upstreams := map[string]net.PacketConn{}
	t.Cleanup(func() {
		mu.Lock()
		defer mu.Unlock()
		for _, u := range upstreams {
			_ = u.Close()
		}
	})
	upstream := func(client net.Addr) net.PacketConn {
		mu.Lock()
		defer mu.Unlock()
		if u, ok := upstreams[client.String()]; ok {
			return u
		}
		u, err := net.ListenPacket("udp4", ip+":0")
		if err != nil {
			return nil
		}
		upstreams[client.String()] = u
		go func() {
			buf := make([]byte, 64<<10)
			for {
				n, _, err := u.ReadFrom(buf)
				if err != nil {
					return
				}
				_, _ = shim.WriteTo(buf[:n], client)
			}
		}()
		return u
	}
	go func() {
		buf := make([]byte, 64<<10)
		for {
			n, from, err := shim.ReadFrom(buf)
			if err != nil {
				return
			}
			pkt := append([]byte(nil), buf[:n]...)
			if stun.IsMessage(pkt) {
				m := &stun.Message{Raw: pkt}
				if m.Decode() == nil && m.Type.Method == stun.MethodCreatePermission && m.Type.Class == stun.ClassRequest {
					sh.perms.Add(1)
					if time.Since(sh.start) >= forgeAfter {
						resp, err := stun.Build(
							stun.NewTransactionIDSetter(m.TransactionID),
							stun.NewType(stun.MethodCreatePermission, stun.ClassErrorResponse),
							stun.ErrorCodeAttribute{Code: stun.CodeForbidden, Reason: []byte(forgedReason)},
							stun.Fingerprint,
						)
						if err == nil {
							if sh.forged.Add(1) == 1 {
								sh.firstForge.Store(int64(time.Since(sh.start) / time.Millisecond))
							}
							_, _ = shim.WriteTo(resp.Raw, from)
						}
						continue
					}
				}
			}
			if u := upstream(from); u != nil {
				_, _ = u.WriteTo(pkt, srvConn.LocalAddr())
			}
		}
	}()
	user, pass, err = turn.GenerateLongTermCredentials(secret, time.Hour)
	if err != nil {
		t.Fatalf("TURN credentials: %v", err)
	}
	return shim.LocalAddr().String(), srvConn.LocalAddr().String(), user, pass, sh
}

// pairingRelay serves /ws on 127.0.0.1 with the two parts of server.js a
// pairing needs: the first join-room is seated as the sender and the second
// as the receiver, whose arrival the sender hears as user-connected, and a
// signal goes to the other seat.
func pairingRelay(t *testing.T) string {
	t.Helper()
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	var mu sync.Mutex
	var seats []*pairingSeat
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		me := &pairingSeat{ws: ws}
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
			var others []*pairingSeat
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

// pairingSeat is one pairingRelay connection; gorilla/websocket allows one
// writer at a time, and both seats' read loops write to it.
type pairingSeat struct {
	mu sync.Mutex
	ws *websocket.Conn
}

func (s *pairingSeat) send(v any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.ws.WriteJSON(v)
}

// joinPairing connects to pairingRelay, joins its room and checks the seat.
func joinPairing(t *testing.T, url, want string) *signaling.Client {
	t.Helper()
	sc, err := signaling.Connect(url)
	if err != nil {
		t.Fatalf("signaling.Connect: %v", err)
	}
	t.Cleanup(sc.Close)
	if err := sc.JoinRoom("floe-turn-log"); err != nil {
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

// capturedStderr is what reached os.Stderr while captureStderr held it.
type capturedStderr struct {
	mu   sync.Mutex
	buf  bytes.Buffer
	once sync.Once
	undo func()
}

func (c *capturedStderr) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buf.String()
}

// stop hands os.Stderr back, waits for the pipe to drain and returns all it
// got.
func (c *capturedStderr) stop() string {
	c.once.Do(c.undo)
	return c.String()
}

// captureStderr swaps os.Stderr for a pipe until stop, or the end of the
// test. peer.New hands pion the stderr of the moment, and pion's default
// factory takes it when pion/ice makes its agent, so the swap comes first.
func captureStderr(t *testing.T) *capturedStderr {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	orig := os.Stderr
	os.Stderr = w
	drained := make(chan struct{})
	c := &capturedStderr{undo: func() {
		os.Stderr = orig
		_ = w.Close()
		<-drained
		_ = r.Close()
	}}
	go func() {
		defer close(drained)
		b := make([]byte, 4096)
		for {
			n, err := r.Read(b)
			if n > 0 {
				c.mu.Lock()
				c.buf.Write(b[:n])
				c.mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() { c.stop() })
	return c
}
