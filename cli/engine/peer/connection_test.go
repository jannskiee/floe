package peer

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/pion/webrtc/v4"
)

// TestPatchMaxMessageSizeInjects verifies the attribute is added after the
// a=sctp-port line that pion emits but never includes itself.
func TestPatchMaxMessageSizeInjects(t *testing.T) {
	sdp := "v=0\r\n" +
		"a=sctp-port:5000\r\n" +
		"a=ice-ufrag:abc\r\n"

	got := patchMaxMessageSize(sdp)

	if !strings.Contains(got, "a=max-message-size:1073741824\r\n") {
		t.Fatalf("patched SDP missing max-message-size attribute:\n%s", got)
	}
	// It must sit immediately after the sctp-port line.
	want := "a=sctp-port:5000\r\na=max-message-size:1073741824\r\n"
	if !strings.Contains(got, want) {
		t.Errorf("attribute not injected directly after sctp-port:\n%s", got)
	}
}

// TestPatchMaxMessageSizeReplaces verifies an existing attribute is rewritten
// rather than duplicated (forward-compat with future pion versions).
func TestPatchMaxMessageSizeReplaces(t *testing.T) {
	sdp := "v=0\r\n" +
		"a=sctp-port:5000\r\n" +
		"a=max-message-size:65536\r\n"

	got := patchMaxMessageSize(sdp)

	if strings.Count(got, "a=max-message-size:") != 1 {
		t.Errorf("expected exactly one max-message-size attribute, got:\n%s", got)
	}
	if strings.Contains(got, "a=max-message-size:65536") {
		t.Errorf("old max-message-size value not replaced:\n%s", got)
	}
	if !strings.Contains(got, "a=max-message-size:1073741824") {
		t.Errorf("max-message-size not set to 1 GB:\n%s", got)
	}
}

// TestConnectionTypeUnconnected verifies ConnectionType errors cleanly (no
// panic) on a peer connection that never negotiated a candidate pair.
func TestConnectionTypeUnconnected(t *testing.T) {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("NewPeerConnection: %v", err)
	}
	defer pc.Close()

	conn := &Connection{pc: pc}
	if _, err := conn.ConnectionType(); err == nil {
		t.Fatal("expected an error before a candidate pair is selected, got nil")
	}
}

// TestWithRelayOnlySetsRelayPolicy verifies the option lands on the peer
// connection as ICE transport policy "relay", which is what makes pion gather
// and pair relay candidates only. Without the option the policy stays "all".
func TestWithRelayOnlySetsRelayPolicy(t *testing.T) {
	tests := []struct {
		name string
		opts []Option
		want webrtc.ICETransportPolicy
	}{
		{"default gathers every path", nil, webrtc.ICETransportPolicyAll},
		{"WithRelayOnly restricts to relay", []Option{WithRelayOnly()}, webrtc.ICETransportPolicyRelay},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			// A zero-value signaling client is enough: New only reads it from
			// goroutines that block on its channels, and nothing here starts
			// ICE gathering, which is the only path that writes to it.
			conn, err := New(nil, &signaling.Client{}, tc.opts...)
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			defer conn.Close()

			if got := conn.pc.GetConfiguration().ICETransportPolicy; got != tc.want {
				t.Errorf("ICETransportPolicy = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestCloseReleasesGoroutines is the regression test for the leak the desktop
// pays for. New starts dispatchSignals and handleCandidates; before Close
// closed conn.done, dispatchSignals ranged over conn.sc.Signal and
// handleCandidates over conn.candidates, and neither channel is ever closed by
// anyone. Connection.Close called only pc.Close, so both goroutines parked
// forever holding a closed *webrtc.PeerConnection alive.
//
// It costs nothing in the CLI (one Connection per process, then exit) and is
// unbounded on the desktop, which builds a fresh Connection for every send and
// every receive.
//
// The count is sampled rather than asserted exactly: pion starts its own
// goroutines and the runtime keeps some of them briefly after Close. What
// matters is that the delta does not scale with the number of connections,
// which is what a per-Connection leak looks like.
func TestCloseReleasesGoroutines(t *testing.T) {
	settle := func() int {
		for i := 0; i < 50; i++ {
			runtime.GC()
			time.Sleep(20 * time.Millisecond)
		}
		return runtime.NumGoroutine()
	}

	before := settle()

	const rounds = 20
	for i := 0; i < rounds; i++ {
		// A zero-value signaling client leaves sc.Signal nil, so the dispatcher
		// can never be released by a channel close. done is the only exit, which
		// is exactly the property under test.
		conn, err := New(nil, &signaling.Client{})
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		conn.Close()
	}

	after := settle()

	// Two goroutines per Connection would be 40 here. Anything under one per
	// round means they are being released; the slack absorbs pion's own.
	if leaked := after - before; leaked >= rounds {
		t.Fatalf("goroutines grew by %d across %d connections (before %d, after %d): "+
			"dispatchSignals or handleCandidates is not exiting on Close",
			leaked, rounds, before, after)
	}
}

// Close is called from more than one defer on some paths, and the desktop's
// cancel path can race it. Closing conn.done twice would panic.
func TestCloseIsIdempotent(t *testing.T) {
	conn, err := New(nil, &signaling.Client{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	conn.Close()
	conn.Close()
	conn.Close()
}

// ---- Setup stops at once when the peer leaves (S1-ENG-11, D-036) ----
//
// Before this, the offer or answer wait and the data-channel wait read
// neither the signaling client's PeerLeft nor the connection's own done, so a
// peer that left during setup cost the full 30 s and ended in "timed out
// establishing a connection", and a local Close during the offer or answer
// wait changed nothing until the same 30 s had passed.

// setupWS is the server side of one fake /ws socket after the join.
type setupWS struct {
	ws     *websocket.Conn
	frames chan setupFrame
}

// setupFrame is the part of a client frame the tests look at.
type setupFrame struct {
	Type   string          `json:"type"`
	Signal json.RawMessage `json:"signal"`
}

// newSetupServer is a fake /ws endpoint: it answers the first frame
// (join-room) with room-joined in role, hands the socket to the test and
// forwards every later frame, so the test decides when to send
// peer-disconnected, close the socket, or say nothing. It binds 127.0.0.1
// through httptest. The test is the only writer once it has the socket.
func newSetupServer(t *testing.T, role string) (string, <-chan *setupWS) {
	t.Helper()
	ready := make(chan *setupWS, 1)
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		if _, _, err := ws.ReadMessage(); err != nil {
			return
		}
		if ws.WriteJSON(map[string]string{"type": "room-joined", "role": role}) != nil {
			return
		}
		s := &setupWS{ws: ws, frames: make(chan setupFrame, 256)}
		ready <- s
		for {
			_, raw, err := ws.ReadMessage()
			if err != nil {
				return
			}
			var f setupFrame
			if json.Unmarshal(raw, &f) == nil {
				select {
				case s.frames <- f:
				default:
				}
			}
		}
	}))
	t.Cleanup(srv.Close)
	return srv.URL, ready
}

// joinedClient connects a real signaling client to a fake server, joins and
// waits for the role the way the CLI's join wait does.
func joinedClient(t *testing.T, role string) (*signaling.Client, *setupWS) {
	t.Helper()
	url, ready := newSetupServer(t, role)
	sc, err := signaling.Connect(url)
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	t.Cleanup(sc.Close)
	if err := sc.JoinRoom("6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"); err != nil {
		t.Fatalf("JoinRoom: %v", err)
	}
	select {
	case got := <-sc.Role:
		if got != role {
			t.Fatalf("role = %q, want %q", got, role)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no room-joined")
	}
	select {
	case s := <-ready:
		return sc, s
	case <-time.After(3 * time.Second):
		t.Fatal("the fake server never handed over its socket")
		return nil, nil
	}
}

// joinedConnection is joinedClient plus the Connection a CLI builds next.
func joinedConnection(t *testing.T, role string) (*Connection, *setupWS) {
	t.Helper()
	sc, s := joinedClient(t, role)
	conn, err := New(nil, sc)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(conn.Close)
	return conn, s
}

// shrinkSignalWait shrinks the offer and answer wait for one test.
func shrinkSignalWait(t *testing.T, d time.Duration) {
	t.Helper()
	if signalWait != signalWaitTimeout {
		t.Fatalf("signalWait = %v, want signalWaitTimeout (%v)", signalWait, signalWaitTimeout)
	}
	signalWait = d
	t.Cleanup(func() { signalWait = signalWaitTimeout })
}

// runSetup runs one Setup call on its own goroutine.
func runSetup(setup func() (*webrtc.DataChannel, error)) <-chan error {
	done := make(chan error, 1)
	go func() {
		_, err := setup()
		done <- err
	}()
	return done
}

// waitSetup waits up to limit for setup to return and reports how long it
// took after since.
func waitSetup(t *testing.T, done <-chan error, since time.Time, limit time.Duration) (time.Duration, error) {
	t.Helper()
	select {
	case err := <-done:
		return time.Since(since), err
	case <-time.After(limit):
		t.Fatalf("setup still waiting %v after the event", limit)
		return 0, nil
	}
}

// assertStopped checks the sentinel, the stage and that the text is the
// sentinel's own sentence and nothing else.
func assertStopped(t *testing.T, err, sentinel error, stage string) {
	t.Helper()
	if !errors.Is(err, sentinel) {
		t.Fatalf("err = %v, want %v", err, sentinel)
	}
	var se *SetupError
	if !errors.As(err, &se) || se.Stage != stage {
		t.Fatalf("err = %#v, want a *SetupError at stage %q", err, stage)
	}
	if err.Error() != sentinel.Error() {
		t.Fatalf("text = %q, want the sentinel's %q", err.Error(), sentinel.Error())
	}
}

// waitSignal reads the client's frames until a signal of kind (offer or
// answer) arrives and returns its SDP.
func waitSignal(t *testing.T, s *setupWS, kind string) string {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case f := <-s.frames:
			if f.Type != "signal" {
				continue
			}
			var p struct {
				Type string `json:"type"`
				SDP  string `json:"sdp"`
			}
			if json.Unmarshal(f.Signal, &p) == nil && p.Type == kind {
				return p.SDP
			}
		case <-deadline:
			t.Fatalf("no %s reached the server", kind)
			return ""
		}
	}
}

// peerLeaves sends what the server sends when the other seat disconnects.
func peerLeaves(t *testing.T, s *setupWS) time.Time {
	t.Helper()
	at := time.Now()
	if err := s.ws.WriteJSON(map[string]string{"type": "peer-disconnected"}); err != nil {
		t.Fatalf("write peer-disconnected: %v", err)
	}
	return at
}

// The receiver waits for the offer; the sender leaves 100 ms in.
func TestSetupAsReceiverReturnsAtOnceWhenPeerLeaves(t *testing.T) {
	shrinkSignalWait(t, 2*time.Second)
	conn, s := joinedConnection(t, "receiver")
	done := runSetup(conn.SetupAsReceiver)
	time.Sleep(100 * time.Millisecond)
	left := peerLeaves(t, s)

	elapsed, err := waitSetup(t, done, left, 5*time.Second)
	t.Logf("SetupAsReceiver returned %v after the peer left", elapsed)
	if elapsed >= time.Second {
		t.Fatalf("returned %v after the peer left, want under 1s (err %v)", elapsed, err)
	}
	assertStopped(t, err, ErrPeerLeft, StagePeerLeft)
}

// The sender's offer reached the server; the receiver leaves before it
// answers.
func TestSetupAsSenderReturnsAtOnceWhenPeerLeaves(t *testing.T) {
	shrinkSignalWait(t, 2*time.Second)
	conn, s := joinedConnection(t, "sender")
	done := runSetup(conn.SetupAsSender)
	waitSignal(t, s, "offer")
	left := peerLeaves(t, s)

	elapsed, err := waitSetup(t, done, left, 5*time.Second)
	t.Logf("SetupAsSender returned %v after the peer left", elapsed)
	if elapsed >= time.Second {
		t.Fatalf("returned %v after the peer left, want under 1s (err %v)", elapsed, err)
	}
	assertStopped(t, err, ErrPeerLeft, StagePeerLeft)
}

// The server goes away during the answer wait: the PeerLeft push comes from
// the socket closing, which Down tells apart from a peer that left.
func TestSetupReturnsSignalingLostWhenTheSocketCloses(t *testing.T) {
	shrinkSignalWait(t, 2*time.Second)
	conn, s := joinedConnection(t, "sender")
	done := runSetup(conn.SetupAsSender)
	waitSignal(t, s, "offer")
	lost := time.Now()
	_ = s.ws.Close()

	elapsed, err := waitSetup(t, done, lost, 5*time.Second)
	t.Logf("SetupAsSender returned %v after the socket closed", elapsed)
	if elapsed >= time.Second {
		t.Fatalf("returned %v after the socket closed, want under 1s (err %v)", elapsed, err)
	}
	assertStopped(t, err, ErrSignalingLost, StageSignalingLost)
}

// Close from another goroutine during the offer wait (the desktop's
// CancelTransfer) ends setup at once; it used to wait out signalWaitTimeout.
func TestSetupReturnsClosedOnLocalClose(t *testing.T) {
	shrinkSignalWait(t, 2*time.Second)
	conn, _ := joinedConnection(t, "receiver")
	done := runSetup(conn.SetupAsReceiver)
	time.Sleep(200 * time.Millisecond)
	closed := time.Now()
	go conn.Close()

	elapsed, err := waitSetup(t, done, closed, 5*time.Second)
	t.Logf("SetupAsReceiver returned %v after Close", elapsed)
	if elapsed >= time.Second {
		t.Fatalf("returned %v after Close, want under 1s (err %v)", elapsed, err)
	}
	assertStopped(t, err, ErrClosed, StageClosed)
}

// A peer that is present but never signals still ends in today's timeout
// text, byte for byte, at the (shrunk) signal wait, and in none of the new
// sentinels.
func TestSetupStillTimesOutWithoutSignals(t *testing.T) {
	shrinkSignalWait(t, 300*time.Millisecond)
	for _, tc := range []struct {
		role, text, stage string
		setup             func(*Connection) func() (*webrtc.DataChannel, error)
	}{
		{"receiver", "timed out waiting for the peer's offer", StageOffer, func(c *Connection) func() (*webrtc.DataChannel, error) { return c.SetupAsReceiver }},
		{"sender", "timed out waiting for the peer to answer", StageAnswer, func(c *Connection) func() (*webrtc.DataChannel, error) { return c.SetupAsSender }},
	} {
		t.Run(tc.role, func(t *testing.T) {
			conn, _ := joinedConnection(t, tc.role)
			start := time.Now()
			_, err := tc.setup(conn)()
			if err == nil || err.Error() != tc.text {
				t.Fatalf("err = %v, want %q", err, tc.text)
			}
			var se *SetupError
			if !errors.As(err, &se) || se.Stage != tc.stage {
				t.Fatalf("err = %#v, want stage %q", err, tc.stage)
			}
			for _, s := range []error{ErrPeerLeft, ErrSignalingLost, ErrClosed} {
				if errors.Is(err, s) {
					t.Fatalf("a plain timeout reads as %v", s)
				}
			}
			if d := time.Since(start); d < 250*time.Millisecond {
				t.Fatalf("timed out after %v, before the 300ms wait", d)
			}
		})
	}
}

// The join waits keep PeerLeft to themselves. The CLI visitor builds its
// Connection before it joins (spec 07 4.8), so New runs first here: a
// peer-disconnected that lands during the join wait is still read by the
// join select as today (New's goroutines never read PeerLeft), and once that
// select has consumed it, setup afterwards never sees it: with no frames it
// waits out the shrunk offer wait and ends in the plain timeout.
func TestSetupPeerLeftDoesNotStealTheJoinWait(t *testing.T) {
	shrinkSignalWait(t, 300*time.Millisecond)
	sc, s := joinedClient(t, "sender")
	conn, err := New(nil, sc)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(conn.Close)
	peerLeaves(t, s)

	// send.go's wait for the receiver, in shape.
	select {
	case <-sc.PeerConnected:
		t.Fatal("no peer connected in this test")
	case <-sc.PeerLeft:
	case <-time.After(3 * time.Second):
		t.Fatal("the join wait never saw the peer leave: something else read PeerLeft")
	}

	start := time.Now()
	_, err = conn.SetupAsReceiver()
	if errors.Is(err, ErrPeerLeft) || errors.Is(err, ErrSignalingLost) {
		t.Fatalf("setup saw the push the join wait had consumed: %v", err)
	}
	if err == nil || err.Error() != "timed out waiting for the peer's offer" {
		t.Fatalf("err = %v, want the plain offer timeout", err)
	}
	if d := time.Since(start); d < 250*time.Millisecond {
		t.Fatalf("setup returned after %v, before its wait could pass", d)
	}
}

// newAnswerer answers offerSDP with a real pion peer and returns the answer
// SDP. It trickles nothing anywhere, so ICE between it and the Connection
// under test can never complete: a setup that has the answer sits in its
// data-channel wait until something ends it.
func newAnswerer(t *testing.T, offerSDP string) string {
	t.Helper()
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("answerer: %v", err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offerSDP}); err != nil {
		t.Fatalf("answerer remote description: %v", err)
	}
	ans, err := pc.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("answerer answer: %v", err)
	}
	if err := pc.SetLocalDescription(ans); err != nil {
		t.Fatalf("answerer local description: %v", err)
	}
	return ans.SDP
}

// newOfferer makes a real pion offer with a data channel, trickling nothing.
func newOfferer(t *testing.T) string {
	t.Helper()
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("offerer: %v", err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	if _, err := pc.CreateDataChannel("floe", nil); err != nil {
		t.Fatalf("offerer channel: %v", err)
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("offerer offer: %v", err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatalf("offerer local description: %v", err)
	}
	return offer.SDP
}

// sendSignal writes a signal frame from the fake server.
func sendSignal(t *testing.T, s *setupWS, kind, sdp string) {
	t.Helper()
	msg := map[string]interface{}{"type": "signal", "signal": map[string]string{"type": kind, "sdp": sdp}}
	if err := s.ws.WriteJSON(msg); err != nil {
		t.Fatalf("write %s: %v", kind, err)
	}
}

// The data-channel waits, past the SDP exchange, get the same two cases:
// the peer leaving ends them at once, and so does a local Close. Before,
// the first waited for connectTimeout (30 s) and the second ended as a
// connection failure.
func TestSetupDataChannelWaitStopsAtOnce(t *testing.T) {
	notYet := func(t *testing.T, done <-chan error) {
		t.Helper()
		time.Sleep(300 * time.Millisecond)
		select {
		case err := <-done:
			t.Fatalf("setup returned before the event: %v", err)
		default:
		}
	}
	t.Run("sender, peer leaves", func(t *testing.T) {
		conn, s := joinedConnection(t, "sender")
		done := runSetup(conn.SetupAsSender)
		sendSignal(t, s, "answer", newAnswerer(t, waitSignal(t, s, "offer")))
		notYet(t, done)
		left := peerLeaves(t, s)
		elapsed, err := waitSetup(t, done, left, 3*time.Second)
		t.Logf("SetupAsSender returned %v after the peer left", elapsed)
		assertStopped(t, err, ErrPeerLeft, StagePeerLeft)
	})
	t.Run("receiver, peer leaves", func(t *testing.T) {
		conn, s := joinedConnection(t, "receiver")
		done := runSetup(conn.SetupAsReceiver)
		sendSignal(t, s, "offer", newOfferer(t))
		waitSignal(t, s, "answer")
		notYet(t, done)
		left := peerLeaves(t, s)
		elapsed, err := waitSetup(t, done, left, 3*time.Second)
		t.Logf("SetupAsReceiver returned %v after the peer left", elapsed)
		assertStopped(t, err, ErrPeerLeft, StagePeerLeft)
	})
	t.Run("sender, local close", func(t *testing.T) {
		conn, s := joinedConnection(t, "sender")
		done := runSetup(conn.SetupAsSender)
		sendSignal(t, s, "answer", newAnswerer(t, waitSignal(t, s, "offer")))
		notYet(t, done)
		closed := time.Now()
		conn.Close()
		elapsed, err := waitSetup(t, done, closed, 3*time.Second)
		t.Logf("SetupAsSender returned %v after Close", elapsed)
		assertStopped(t, err, ErrClosed, StageClosed)
	})
}
