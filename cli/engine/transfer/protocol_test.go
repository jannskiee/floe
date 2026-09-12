package transfer

import (
	"strings"
	"testing"
	"unicode/utf8"
)

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

// TestCheckCompat covers the full matrix of protocol version range comparisons.
func TestCheckCompat(t *testing.T) {
	cases := []struct {
		name                 string
		localMin, localMax   int
		remoteMin, remoteMax int
		wantOk               bool
		wantLocalTooOld      bool
	}{
		{"equal v1", 1, 1, 1, 1, true, false},
		{"legacy remote (zeros treated as v1)", 1, 1, 0, 0, true, false},
		{"overlap: local 1-2 remote 2-3", 1, 2, 2, 3, true, false},
		{"local too old: local 1-1 remote 2-2", 1, 1, 2, 2, false, true},
		{"remote too old: local 2-2 remote 1-1", 2, 2, 1, 1, false, false},
		{"no overlap: local 3-4 remote 1-2", 3, 4, 1, 2, false, false},
		{"wide local range", 1, 5, 3, 3, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ok, localTooOld := CheckCompat(tc.localMin, tc.localMax, tc.remoteMin, tc.remoteMax)
			if ok != tc.wantOk || localTooOld != tc.wantLocalTooOld {
				t.Errorf("CheckCompat(%d,%d,%d,%d) = (ok=%v,localTooOld=%v), want (ok=%v,localTooOld=%v)",
					tc.localMin, tc.localMax, tc.remoteMin, tc.remoteMax,
					ok, localTooOld, tc.wantOk, tc.wantLocalTooOld)
			}
		})
	}
}

// TestCompatErrorMessage verifies the user-facing error strings.
func TestCompatErrorMessage(t *testing.T) {
	// Local too old: should suggest running floe update locally
	msg := CompatErrorMessage(true, "v1.5.5", "v2.0.0", 1, 1, 2, 2)
	if !strings.Contains(msg, "floe update") {
		t.Errorf("local-too-old message should mention 'floe update', got: %s", msg)
	}
	if !strings.Contains(msg, "v1.5.5") || !strings.Contains(msg, "v2.0.0") {
		t.Errorf("message should contain both version strings, got: %s", msg)
	}

	// Remote too old: should ask the other side to update
	msg2 := CompatErrorMessage(false, "v2.0.0", "v1.5.5", 2, 2, 1, 1)
	if !strings.Contains(msg2, "other side") {
		t.Errorf("remote-too-old message should mention 'other side', got: %s", msg2)
	}

	// Empty ver strings omitted from ranges
	msg3 := CompatErrorMessage(true, "", "", 1, 1, 2, 2)
	if strings.Contains(msg3, "()") {
		t.Errorf("empty ver should not produce '()' in message, got: %s", msg3)
	}

	// GUI callers can replace the CLI-only local remedy.
	const appHint = "Update Floe from your app store or floe.one/download."
	msg4 := compatErrorMessage(true, "v1.5.5", "v2.0.0", 1, 1, 2, 2, appHint)
	if !strings.Contains(msg4, appHint) || strings.Contains(msg4, "floe update") {
		t.Errorf("custom local update hint not applied, got: %s", msg4)
	}

	// The local app cannot know which surface the peer uses, so the remote
	// remedy stays surface-neutral when a custom local hint is configured.
	msg5 := compatErrorMessage(false, "v2.0.0", "v1.5.5", 2, 2, 1, 1, appHint)
	if !strings.Contains(msg5, "Ask the other side to update Floe.") || strings.Contains(msg5, "app store") {
		t.Errorf("custom peer update hint should be surface-neutral, got: %s", msg5)
	}

	// A current receiver's reason is written from the receiver's perspective.
	// The sender must reconstruct it from its own protocol range and hint.
	msg6 := compatErrorFromIncompatible("v1.5.5", appHint, incompatibleMsg{
		Reason: "receiver-perspective message",
		Pv:     2,
		PvMin:  2,
		Ver:    "v2.0.0",
	})
	if !strings.Contains(msg6, appHint) || strings.Contains(msg6, "receiver-perspective") {
		t.Errorf("sender did not rebuild incompatibility message, got: %s", msg6)
	}

	// Legacy peers supplied only a prebuilt reason.
	const legacyReason = "legacy incompatibility reason"
	if got := compatErrorFromIncompatible("v1.5.5", appHint, incompatibleMsg{Reason: legacyReason}); got != legacyReason {
		t.Errorf("legacy reason = %q, want %q", got, legacyReason)
	}

	// When this receiver is newer, the sender-facing fallback must say that the
	// sender itself is old and must not leak this receiver's app-store hint.
	peerMsg := peerCompatErrorMessage(false, "v2.0.0", "v1.5.5", 2, 2, 1, 1)
	if !strings.Contains(peerMsg, "your floe is too old") ||
		!strings.Contains(peerMsg, "You: protocol 1 (v1.5.5)  Peer: protocol 2 (v2.0.0)") ||
		!strings.Contains(peerMsg, "Update Floe to continue.") {
		t.Errorf("newer receiver produced wrong sender-facing message: %s", peerMsg)
	}

	// When this receiver is older, the newer sender should be told neutrally
	// that the peer needs an update.
	peerMsg2 := peerCompatErrorMessage(true, "v1.5.5", "v2.0.0", 1, 1, 2, 2)
	if !strings.Contains(peerMsg2, "peer's floe is too old") ||
		!strings.Contains(peerMsg2, "You: protocol 2 (v2.0.0)  Peer: protocol 1 (v1.5.5)") ||
		!strings.Contains(peerMsg2, "Ask the other side to update Floe.") {
		t.Errorf("older receiver produced wrong sender-facing message: %s", peerMsg2)
	}
}

// TestCompatErrorMessageSanitizesPeerStrings: the peer's version string and
// its legacy reason are printed by the CLI and shown on the desktop status
// line, so they arrive there cleaned and capped no matter which path built
// the message.
func TestCompatErrorMessageSanitizesPeerStrings(t *testing.T) {
	msg := CompatErrorMessage(false, "v1", "v2\x1b[2K\u202e", 1, 1, 2, 2)
	if !strings.Contains(msg, "v2_[2K_") || strings.Contains(msg, "\x1b") {
		t.Errorf("remote version not cleaned: %q", msg)
	}
	msg = compatErrorMessage(true, "v1", "v2\x1b[2K\u202e", 1, 1, 2, 2, "hint")
	if !strings.Contains(msg, "v2_[2K_") || strings.Contains(msg, "\x1b") {
		t.Errorf("remote version not cleaned on the GUI path: %q", msg)
	}

	// A legacy peer's reason is the only prose the sender prints verbatim.
	legacy := compatErrorFromIncompatible("v1", "", incompatibleMsg{Reason: strings.Repeat("evil\n", 1000)})
	if n := utf8.RuneCountInString(legacy); n > 300 {
		t.Errorf("legacy reason is %d runes, want at most 300", n)
	}
	if strings.Contains(legacy, "\n") {
		t.Errorf("a newline survived in the legacy reason: %q", legacy)
	}

	// A current peer's ver is capped before it is embedded in the rebuilt message.
	rebuilt := compatErrorFromIncompatible("v1", "", incompatibleMsg{Ver: strings.Repeat("v", 10*1024), Pv: 2, PvMin: 2})
	if n := utf8.RuneCountInString(rebuilt); n >= 500 {
		t.Errorf("rebuilt message is %d runes for a 10 KB ver, want under 500", n)
	}
}
