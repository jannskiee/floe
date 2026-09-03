package peer

import (
	"runtime"
	"strings"
	"testing"
	"time"

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
