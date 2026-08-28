package peer

import (
	"strings"
	"testing"

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
