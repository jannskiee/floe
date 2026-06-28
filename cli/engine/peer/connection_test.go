package peer

import (
	"strings"
	"testing"
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
