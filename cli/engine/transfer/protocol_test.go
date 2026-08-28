package transfer

import "testing"

// TestProtocolVersionPinnedToClient anchors the two constants to the browser
// client's PROTOCOL_VERSION and MIN_PROTOCOL_VERSION (client/lib/transfer/
// protocol.ts): both are 1. The browser pins the same numbers in the
// "constants" block of client/lib/transfer/protocol.test.ts, each test naming
// the other, so a bump cannot land on one side without touching a test that
// points at its twin.
func TestProtocolVersionPinnedToClient(t *testing.T) {
	if ProtocolVersion != 1 {
		t.Errorf("ProtocolVersion = %d, want 1 (mirrors PROTOCOL_VERSION in client/lib/transfer/protocol.ts)", ProtocolVersion)
	}
	if MinProtocolVersion != 1 {
		t.Errorf("MinProtocolVersion = %d, want 1 (mirrors MIN_PROTOCOL_VERSION in client/lib/transfer/protocol.ts)", MinProtocolVersion)
	}
	if MinProtocolVersion > ProtocolVersion {
		t.Errorf("MinProtocolVersion %d > ProtocolVersion %d: the supported range is empty", MinProtocolVersion, ProtocolVersion)
	}
}
