package peer_test

// The Request link's Stage 1 pairing through the real engine layers: the host
// joins a room first, makes the offer with SetupAsSender and then RECEIVES; the
// visitor joins second, answers with SetupAsReceiver and then SENDS. Today's
// CLI only ever runs the offerer as the sender, so nothing else covers this
// direction through peer.New and the signaling client.
//
// An external test package on purpose: the peer to transfer import planned in
// S1-ENG-06 can then never form an import cycle with this file.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/jannskiee/floe/cli/engine/transfer"
	"github.com/pion/webrtc/v4"
)

// relay is a minimal stand-in for the signaling server's /ws endpoint with
// today's handleJoinRoom semantics, which the baseline pairing spike measured
// against a real server.js: seats go by join order, the FIRST joiner gets
// role "sender" whatever its WebRTC role (never "host"), the second gets
// "receiver" and seat 0 is sent user-connected, a third gets room-full, and a
// signal goes to the other seat. It binds 127.0.0.1 through httptest.
type relay struct {
	mu    sync.Mutex
	rooms map[string][]*relayConn
}

type relayConn struct {
	id   string
	room string
	ws   *websocket.Conn
	wmu  sync.Mutex // gorilla/websocket allows one writer at a time
}

func (c *relayConn) send(msg map[string]interface{}) {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_ = c.ws.WriteJSON(msg)
}

func newRelay(t *testing.T) string {
	t.Helper()
	r := &relay{rooms: map[string][]*relayConn{}}
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, req *http.Request) {
		ws, err := up.Upgrade(w, req, nil)
		if err != nil {
			return
		}
		r.serve(&relayConn{id: uuid.New().String(), ws: ws})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv.URL
}

func (r *relay) serve(c *relayConn) {
	defer c.ws.Close()
	defer r.leave(c)
	for {
		_, raw, err := c.ws.ReadMessage()
		if err != nil {
			return
		}
		var msg struct {
			Type   string          `json:"type"`
			RoomID string          `json:"roomId"`
			Signal json.RawMessage `json:"signal"`
		}
		if json.Unmarshal(raw, &msg) != nil {
			continue
		}
		switch msg.Type {
		case "join-room":
			r.join(c, msg.RoomID)
		case "signal":
			if len(msg.Signal) == 0 {
				continue
			}
			if other := r.other(c); other != nil {
				other.send(map[string]interface{}{"type": "signal", "signal": msg.Signal, "sender": c.id})
			}
		}
	}
}

func (r *relay) join(c *relayConn, room string) {
	r.mu.Lock()
	seats := r.rooms[room]
	switch len(seats) {
	case 0:
		c.room = room
		r.rooms[room] = []*relayConn{c}
		r.mu.Unlock()
		c.send(map[string]interface{}{"type": "room-joined", "role": "sender"})
	case 1:
		c.room = room
		r.rooms[room] = append(seats, c)
		first := seats[0]
		r.mu.Unlock()
		c.send(map[string]interface{}{"type": "room-joined", "role": "receiver"})
		first.send(map[string]interface{}{"type": "user-connected", "id": c.id})
	default:
		r.mu.Unlock()
		c.send(map[string]interface{}{"type": "room-full"})
	}
}

func (r *relay) other(c *relayConn) *relayConn {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, s := range r.rooms[c.room] {
		if s != c {
			return s
		}
	}
	return nil
}

func (r *relay) leave(c *relayConn) {
	r.mu.Lock()
	var remaining []*relayConn
	for _, s := range r.rooms[c.room] {
		if s != c {
			remaining = append(remaining, s)
		}
	}
	if len(remaining) == 0 {
		delete(r.rooms, c.room)
	} else {
		r.rooms[c.room] = remaining
	}
	r.mu.Unlock()
	for _, s := range remaining {
		s.send(map[string]interface{}{"type": "peer-disconnected"})
	}
}

// side is one end of a pairing.
type side struct {
	name  string
	sc    *signaling.Client
	conn  *peer.Connection
	dc    *webrtc.DataChannel
	early *peer.Early
	once  sync.Once
}

// close mirrors the CLI's deferred teardown order: the connection, then the
// signaling socket.
func (s *side) close() {
	s.once.Do(func() {
		if s.conn != nil {
			s.conn.Close()
		}
		if s.sc != nil {
			s.sc.Close()
		}
	})
}

func expectRole(t *testing.T, s *side, want string) {
	t.Helper()
	select {
	case role := <-s.sc.Role:
		if role != want {
			t.Fatalf("%s: relay assigned role %q, want %q", s.name, role, want)
		}
	case <-s.sc.RoomFull:
		t.Fatalf("%s: room full", s.name)
	case e := <-s.sc.Errors:
		t.Fatalf("%s: relay error %q", s.name, e)
	case <-s.sc.PeerLeft:
		t.Fatalf("%s: socket closed before the role arrived", s.name)
	case <-time.After(10 * time.Second):
		t.Fatalf("%s: no role within 10s", s.name)
	}
}

// pairHostVisitor runs the Stage 1 join and setup order: the host connects and
// joins FIRST (role "sender"), the visitor joins second (role "receiver"), the
// host waits for user-connected, both build a peer with no ICE servers (host
// candidates only), and then the host offers while the visitor answers.
func pairHostVisitor(t *testing.T, relayURL string) (host, visitor *side) {
	t.Helper()
	room := uuid.New().String()
	host = &side{name: "host"}
	visitor = &side{name: "visitor"}
	t.Cleanup(host.close)
	t.Cleanup(visitor.close)

	var err error
	if host.sc, err = signaling.Connect(relayURL); err != nil {
		t.Fatalf("host signaling connect: %v", err)
	}
	if err = host.sc.JoinRoom(room); err != nil {
		t.Fatalf("host join: %v", err)
	}
	expectRole(t, host, "sender")

	if visitor.sc, err = signaling.Connect(relayURL); err != nil {
		t.Fatalf("visitor signaling connect: %v", err)
	}
	if err = visitor.sc.JoinRoom(room); err != nil {
		t.Fatalf("visitor join: %v", err)
	}
	expectRole(t, visitor, "receiver")

	select {
	case <-host.sc.PeerConnected:
	case <-time.After(10 * time.Second):
		t.Fatal("host never received user-connected")
	}

	if host.conn, err = peer.New(nil, host.sc); err != nil {
		t.Fatalf("host peer.New: %v", err)
	}
	if visitor.conn, err = peer.New(nil, visitor.sc); err != nil {
		t.Fatalf("visitor peer.New: %v", err)
	}

	type setup struct {
		dc  *webrtc.DataChannel
		err error
	}
	hostCh := make(chan setup, 1)
	visitorCh := make(chan setup, 1)
	go func() {
		dc, err := host.conn.SetupAsSender()
		hostCh <- setup{dc, err}
	}()
	go func() {
		dc, err := visitor.conn.SetupAsReceiver()
		visitorCh <- setup{dc, err}
	}()

	var hs, vs setup
	timeout := time.After(60 * time.Second)
	for got := 0; got < 2; got++ {
		select {
		case hs = <-hostCh:
		case vs = <-visitorCh:
		case <-timeout:
			t.Fatal("pairing did not complete within 60s")
		}
	}
	if hs.err != nil {
		t.Fatalf("host SetupAsSender: %v", hs.err)
	}
	if vs.err != nil {
		t.Fatalf("visitor SetupAsReceiver: %v", vs.err)
	}
	host.dc, host.early = hs.dc, host.conn.Early()
	visitor.dc, visitor.early = vs.dc, visitor.conn.Early()
	if host.early == nil || visitor.early == nil {
		t.Fatal("Early() is nil after setup returned")
	}
	return host, visitor
}

// writeRandom writes size random bytes to dir/name and returns their SHA-256.
func writeRandom(t *testing.T, dir, name string, size int) [sha256.Size]byte {
	t.Helper()
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		t.Fatalf("generate %s: %v", name, err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return sha256.Sum256(data)
}

// startSend runs the visitor's send and closes the visitor right after it
// returns, as the CLI's deferred close does.
func startSend(visitor *side, paths []string) <-chan error {
	sendErr := make(chan error, 1)
	go func() {
		err := transfer.SendFilesWithOptions(visitor.dc, paths, "", transfer.SendOptions{
			OnProgress: func(transfer.Progress) {},
			Messages:   visitor.early.Msgs,
			Closed:     visitor.early.Closed,
		})
		visitor.close()
		sendErr <- err
	}()
	return sendErr
}

// startReceive runs the host's receive from its early pump. The stats URL is
// empty, so no report can be made whatever the environment says.
func startReceive(host *side, outDir string) <-chan error {
	recvErr := make(chan error, 1)
	go func() {
		recvErr <- transfer.ReceiveFilesWithOptions(host.dc, outDir, true, "", "", transfer.ReceiveOptions{
			OnProgress: func(transfer.Progress) {},
			Messages:   host.early.Msgs,
			Closed:     host.early.Closed,
		})
	}()
	return recvErr
}

func waitBoth(t *testing.T, sendErr, recvErr <-chan error) {
	t.Helper()
	timeout := time.After(60 * time.Second)
	for got := 0; got < 2; got++ {
		select {
		case err := <-sendErr:
			if err != nil {
				t.Fatalf("visitor SendFilesWithOptions: %v", err)
			}
			sendErr = nil
		case err := <-recvErr:
			if err != nil {
				t.Fatalf("host ReceiveFilesWithOptions: %v", err)
			}
			recvErr = nil
		case <-timeout:
			t.Fatal("transfer did not finish within 60s")
		}
	}
}

// checkTree requires outDir to hold exactly the files in want, each with the
// source's SHA-256, and so no .part staging file.
func checkTree(t *testing.T, outDir string, want map[string][sha256.Size]byte) {
	t.Helper()
	var got []string
	err := filepath.WalkDir(outDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(outDir, path)
		if err != nil {
			return err
		}
		got = append(got, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", outDir, err)
	}
	var names []string
	for name := range want {
		names = append(names, name)
	}
	sort.Strings(got)
	sort.Strings(names)
	if strings.Join(got, "\n") != strings.Join(names, "\n") {
		t.Fatalf("output tree:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(names, "\n"))
	}
	for name, sum := range want {
		data, err := os.ReadFile(filepath.Join(outDir, filepath.FromSlash(name)))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if sha256.Sum256(data) != sum {
			t.Fatalf("%s: SHA-256 differs from the source", name)
		}
	}
}

// TestHostOffersAndReceives: the host offers and receives two files, one of
// them empty, from the answering visitor over host candidates.
func TestHostOffersAndReceives(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}

	host, visitor := pairHostVisitor(t, newRelay(t))
	if path, err := host.conn.ConnectionType(); err != nil || path != "direct" {
		t.Fatalf("host ConnectionType = %q, %v; want direct with no ICE servers", path, err)
	}

	srcDir := t.TempDir()
	want := map[string][sha256.Size]byte{
		"empty.bin":   writeRandom(t, srcDir, "empty.bin", 0),
		"one-mib.bin": writeRandom(t, srcDir, "one-mib.bin", 1<<20),
	}

	outDir := t.TempDir()
	recvErr := startReceive(host, outDir)
	sendErr := startSend(visitor, []string{
		filepath.Join(srcDir, "empty.bin"),
		filepath.Join(srcDir, "one-mib.bin"),
	})
	waitBoth(t, sendErr, recvErr)
	checkTree(t, outDir, want)
}

// TestHostPumpDeliversStagedMessage proves the early-message pump that
// SetupAsSender attaches before the offer leaves. The visitor's metadata is
// made to sit in the host's pump BEFORE the host's receive starts, the state in
// which a handler registered by the transfer layer would have lost it. This
// staging, not the timing of TestHostOffersAndReceives, is the proof: the
// baseline spike found a message already waiting in 0 of 33 natural pairings
// in this direction, so a sleep-based race proves nothing here.
func TestHostPumpDeliversStagedMessage(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}

	host, visitor := pairHostVisitor(t, newRelay(t))

	srcDir := t.TempDir()
	want := map[string][sha256.Size]byte{
		"staged.bin": writeRandom(t, srcDir, "staged.bin", 64*1024),
	}

	// Send with nobody in the transfer layer listening on the host yet.
	sendErr := startSend(visitor, []string{filepath.Join(srcDir, "staged.bin")})

	deadline := time.After(20 * time.Second)
	for len(host.early.Msgs) == 0 {
		select {
		case <-deadline:
			t.Fatal("the visitor's first message never reached the host's pump")
		case err := <-sendErr:
			t.Fatalf("visitor send returned before the host started receiving: %v", err)
		default:
			time.Sleep(2 * time.Millisecond)
		}
	}

	outDir := t.TempDir()
	recvErr := startReceive(host, outDir)
	waitBoth(t, sendErr, recvErr)
	checkTree(t, outDir, want)
}

// TestLoopbackOffererHoldsAckLong holds the first ack for 75 s on real timers:
// longer than the 30 s idle and 60 s stall receive watchdogs (the transfer
// package's TestLoopbackOffererHoldsAck checks that they still are), and under
// the Go sender's hardcoded 120 s ack deadline, which the baseline spike
// measured firing at 120.006 s with "error sending <name>: timed out waiting
// for ack". Never raise the hold to 120 s or more here; a longer wait needs
// SendOptions.AckTimeout (S1-ENG-08). It lives in this package so that go test
// runs the hold alongside the transfer package's tests instead of adding 75 s
// to them.
func TestLoopbackOffererHoldsAckLong(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping the 75 s held-ack loopback transfer in -short mode")
	}

	const hold = 75 * time.Second
	host, visitor := pairHostVisitor(t, newRelay(t))

	srcDir := t.TempDir()
	want := map[string][sha256.Size]byte{
		"held.bin": writeRandom(t, srcDir, "held.bin", 64*1024),
	}
	sendErr := startSend(visitor, []string{filepath.Join(srcDir, "held.bin")})

	// The visitor's metadata waits in the host's pump before the receive starts,
	// as in TestHostPumpDeliversStagedMessage.
	deadline := time.After(20 * time.Second)
	for len(host.early.Msgs) == 0 {
		select {
		case <-deadline:
			t.Fatal("the visitor's first message never reached the host's pump")
		case err := <-sendErr:
			t.Fatalf("visitor send returned before the host started receiving: %v", err)
		default:
			time.Sleep(2 * time.Millisecond)
		}
	}

	outDir := t.TempDir()
	calls := 0
	var held time.Duration
	recvErr := make(chan error, 1)
	go func() {
		recvErr <- transfer.ReceiveFilesWithOptions(host.dc, outDir, true, "", "", transfer.ReceiveOptions{
			OnProgress: func(transfer.Progress) {},
			OnIncoming: func(transfer.IncomingInfo) {
				calls++
				start := time.Now()
				time.Sleep(hold)
				held = time.Since(start)
			},
			Messages: host.early.Msgs,
			Closed:   host.early.Closed,
		})
	}()

	// The visitor sits in its ack wait for the whole hold, under the sender's
	// hardcoded 120 s ack deadline, so waitBoth's 60 s bound is too short here.
	bound := hold + 60*time.Second
	timeout := time.After(bound)
	for got := 0; got < 2; got++ {
		select {
		case err := <-sendErr:
			if err != nil {
				t.Fatalf("visitor SendFilesWithOptions: %v", err)
			}
			sendErr = nil
		case err := <-recvErr:
			if err != nil {
				t.Fatalf("host ReceiveFilesWithOptions: %v", err)
			}
			recvErr = nil
		case <-timeout:
			t.Fatalf("transfer did not finish within %s", bound)
		}
	}

	if calls != 1 {
		t.Fatalf("OnIncoming ran %d times, want 1", calls)
	}
	if held < hold {
		t.Fatalf("OnIncoming held %s, want at least %s", held, hold)
	}
	checkTree(t, outDir, want)
}
