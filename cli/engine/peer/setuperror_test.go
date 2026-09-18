package peer

// SetupError: every setup failure site that can be driven in-process returns
// the type with its stage and today's text, and the one site whose text
// carries the peer's bytes is display-safe.

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/pion/webrtc/v4"
)

// signalSink is a /ws endpoint that accepts the upgrade, forwards every
// signal payload it reads to a channel and never answers on its own, so
// SendSignal succeeds and the test decides what comes back. A zero-value
// signaling.Client cannot stand in: its write path dereferences a nil socket.
func signalSink(t *testing.T) (*signaling.Client, <-chan json.RawMessage) {
	t.Helper()
	signals := make(chan json.RawMessage, 64)
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
			var msg struct {
				Type   string          `json:"type"`
				Signal json.RawMessage `json:"signal"`
			}
			if json.Unmarshal(raw, &msg) == nil && msg.Type == "signal" {
				select {
				case signals <- msg.Signal:
				default:
				}
			}
		}
	}))
	t.Cleanup(srv.Close)
	sc, err := signaling.Connect(srv.URL)
	if err != nil {
		t.Fatalf("connect to the sink: %v", err)
	}
	t.Cleanup(sc.Close)
	return sc, signals
}

// offerFrom is a bare pion peer's offer with a data channel, and the peer that
// made it. No candidate is ever exchanged, so nothing connects.
func offerFrom(t *testing.T) webrtc.SessionDescription {
	t.Helper()
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("counterpart peer: %v", err)
	}
	t.Cleanup(func() { pc.Close() })
	if _, err := pc.CreateDataChannel("floe", nil); err != nil {
		t.Fatalf("counterpart data channel: %v", err)
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatalf("counterpart offer: %v", err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatalf("counterpart SetLocalDescription: %v", err)
	}
	return offer
}

// answerTo is a bare pion peer's answer to the offer under test.
func answerTo(t *testing.T, offer webrtc.SessionDescription) webrtc.SessionDescription {
	t.Helper()
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("counterpart peer: %v", err)
	}
	t.Cleanup(func() { pc.Close() })
	if err := pc.SetRemoteDescription(offer); err != nil {
		t.Fatalf("counterpart SetRemoteDescription: %v", err)
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("counterpart answer: %v", err)
	}
	if err := pc.SetLocalDescription(answer); err != nil {
		t.Fatalf("counterpart SetLocalDescription: %v", err)
	}
	return answer
}

// offerSentTo reads the offer the connection under test sent to the sink,
// skipping the trickle candidates that can precede it.
func offerSentTo(t *testing.T, signals <-chan json.RawMessage) webrtc.SessionDescription {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case raw := <-signals:
			var payload signalPayload
			if json.Unmarshal(raw, &payload) == nil && payload.Type == "offer" {
				return webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: payload.SDP}
			}
		case <-deadline:
			t.Fatal("the offer never reached the sink")
		}
	}
}

// requireSetupError asserts the error is a *SetupError at the stage, that
// its text starts as the site's text always did and, unless the text carries
// peer bytes, that Error() is Err's text byte for byte.
func requireSetupError(t *testing.T, err error, stage, text string, peerText bool) *SetupError {
	t.Helper()
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	var se *SetupError
	if !errors.As(err, &se) {
		t.Fatalf("error = %v (%T), want *SetupError", err, err)
	}
	if se.Stage != stage {
		t.Fatalf("stage = %q, want %q (error %v)", se.Stage, stage, err)
	}
	if !strings.HasPrefix(err.Error(), text) {
		t.Fatalf("Error() = %q, want it to start with %q", err.Error(), text)
	}
	if !peerText && err.Error() != se.Err.Error() {
		t.Fatalf("Error() = %q differs from the site's text %q", err.Error(), se.Err.Error())
	}
	return se
}

// TestSetupErrorWrapsEveryStage drives every setup failure site that can be
// reached in-process, on both roles, and pins the stage and today's text. The
// sites it cannot drive are pion refusing valid input (CreateDataChannel,
// CreateOffer, CreateAnswer, SetLocalDescription) and the 30 s waits, which
// are wrapped the same way at the same call sites. The two grace-period sites
// wait connectGrace (10 s each) and are skipped under -short.
func TestSetupErrorWrapsEveryStage(t *testing.T) {
	connFailed := errors.New("connection failed (state: failed)")
	cases := []struct {
		name  string
		stage string
		text  string
		slow  bool
		run   func(t *testing.T) error
	}{
		{"sender: send offer", StageOffer, "failed to send offer: ", false, func(t *testing.T) error {
			sc, _ := signalSink(t)
			sc.Close()
			conn, err := New(nil, sc)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			_, err = conn.SetupAsSender()
			return err
		}},
		{"sender: signaling closed before the answer", StageAnswer, "signaling closed before answer was received", false, func(t *testing.T) error {
			sc, _ := signalSink(t)
			conn, err := New(nil, sc)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			close(conn.answers)
			_, err = conn.SetupAsSender()
			return err
		}},
		{"sender: bad answer", StageRemoteDescription, "failed to set remote description: ", false, func(t *testing.T) error {
			sc, _ := signalSink(t)
			conn, err := New(nil, sc)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			conn.answers <- webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: "not an sdp"}
			_, err = conn.SetupAsSender()
			return err
		}},
		{"sender: connection failed", StageConnect, "connection failed (state: ", false, func(t *testing.T) error {
			sc, signals := signalSink(t)
			conn, err := New(nil, sc)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			done := make(chan error, 1)
			go func() { _, err := conn.SetupAsSender(); done <- err }()
			answer := answerTo(t, offerSentTo(t, signals))
			conn.connected <- connFailed
			conn.answers <- answer
			select {
			case err := <-done:
				if !errors.Is(err, connFailed) {
					t.Fatalf("the connect error is not reachable: %v", err)
				}
				return err
			case <-time.After(10 * time.Second):
				t.Fatal("SetupAsSender did not return")
			}
			return nil
		}},
		{"sender: channel never opened", StageChannel, "connected but the data channel did not open", true, func(t *testing.T) error {
			sc, signals := signalSink(t)
			conn, err := New(nil, sc)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			done := make(chan error, 1)
			go func() { _, err := conn.SetupAsSender(); done <- err }()
			answer := answerTo(t, offerSentTo(t, signals))
			conn.connected <- nil
			conn.answers <- answer
			select {
			case err := <-done:
				return err
			case <-time.After(connectGrace + 10*time.Second):
				t.Fatal("SetupAsSender did not return")
			}
			return nil
		}},
		{"receiver: signaling closed before the offer", StageOffer, "signaling closed before offer was received", false, func(t *testing.T) error {
			sc, _ := signalSink(t)
			conn, err := New(nil, sc)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			close(conn.offers)
			_, err = conn.SetupAsReceiver()
			return err
		}},
		{"receiver: bad offer", StageRemoteDescription, "failed to set remote description: ", false, func(t *testing.T) error {
			sc, _ := signalSink(t)
			conn, err := New(nil, sc)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			conn.offers <- webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: "not an sdp"}
			_, err = conn.SetupAsReceiver()
			return err
		}},
		{"receiver: send answer", StageAnswer, "failed to send answer: ", false, func(t *testing.T) error {
			sc, _ := signalSink(t)
			sc.Close()
			conn, err := New(nil, sc)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			conn.offers <- offerFrom(t)
			_, err = conn.SetupAsReceiver()
			return err
		}},
		{"receiver: connection failed", StageConnect, "connection failed (state: ", false, func(t *testing.T) error {
			sc, _ := signalSink(t)
			conn, err := New(nil, sc)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			conn.connected <- connFailed
			conn.offers <- offerFrom(t)
			_, err = conn.SetupAsReceiver()
			if !errors.Is(err, connFailed) {
				t.Fatalf("the connect error is not reachable: %v", err)
			}
			return err
		}},
		{"receiver: channel never opened", StageChannel, "connected but the data channel did not open", true, func(t *testing.T) error {
			sc, _ := signalSink(t)
			conn, err := New(nil, sc)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			conn.connected <- nil
			conn.offers <- offerFrom(t)
			_, err = conn.SetupAsReceiver()
			return err
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.slow && testing.Short() {
				t.Skip("waits out connectGrace; skipped under -short")
			}
			err := tc.run(t)
			requireSetupError(t, err, tc.stage, tc.text, tc.stage == StageRemoteDescription)
		})
	}
}

// forbiddenRune reports whether r is a C0 or C1 control, DEL, or a Unicode
// bidi control. Written out here rather than borrowed from the transfer
// package's sanitizer, so the property does not grade the code with its own
// answer key.
func forbiddenRune(r rune) bool {
	switch {
	case r < 0x20, r >= 0x7f && r <= 0x9f:
		return true
	case r == 0x061c, r == 0x200e, r == 0x200f,
		r >= 0x202a && r <= 0x202e, r >= 0x2066 && r <= 0x2069:
		return true
	}
	return false
}

// TestSetupErrorIsDisplaySafe: an SDP built to make pion embed attacker text
// in its error (a bidi override, a terminal escape, a 5,000-character token
// and shell and markup punctuation) yields a remote-description SetupError
// whose text has no control or bidi rune and at most 300 runes. The raw
// pion error is required to carry the payload for at least one fixture, or
// the test would be proving nothing about a sink.
func TestSetupErrorIsDisplaySafe(t *testing.T) {
	marker := "$(calc)]]><"
	hostile := "‮\x1b[2K" + marker + strings.Repeat("A", 5000)
	fixtures := map[string]string{
		"invalid line":   "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n" + hostile + "\r\n",
		"invalid value":  "v=" + hostile + "\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n",
		"bad media line": "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=" + hostile + "\r\n",
		"bad attribute":  "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=" + hostile + "\r\n",
	}
	embedded := 0
	for name, sdp := range fixtures {
		t.Run(name, func(t *testing.T) {
			conn, err := New(nil, &signaling.Client{})
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			err = conn.setRemoteDesc(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp})
			se := requireSetupError(t, err, StageRemoteDescription, "failed to set remote description: ", true)
			raw := se.Err.Error()
			if strings.Contains(raw, marker) || strings.Contains(raw, "AAAA") {
				embedded++
			}
			shown := err.Error()
			if n := utf8.RuneCountInString(shown); n > 300 {
				t.Errorf("Error() is %d runes, want at most 300", n)
			}
			for i, r := range shown {
				if forbiddenRune(r) {
					t.Errorf("Error() carries U+%04X at byte %d: %q", r, i, shown)
					break
				}
			}
			if strings.Contains(shown, "‮") || strings.Contains(shown, "\x1b") {
				t.Errorf("a raw bidi override or escape reached Error(): %q", shown)
			}
			if !errors.Is(err, se.Err) {
				t.Error("Unwrap does not reach the site's error")
			}
		})
	}
	if embedded == 0 {
		t.Fatal("no fixture made pion embed the payload in its error; the sink under test was not exercised")
	}
	t.Logf("%d of %d fixtures made pion quote the payload", embedded, len(fixtures))
}
