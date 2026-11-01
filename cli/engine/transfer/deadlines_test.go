package transfer

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestDeadlineConstantsMatchTS pins the clock pair to the browser twin:
// client/lib/transfer/protocol.test.ts holds the same numbers in its
// "constants" block (REQUEST_ACK_TIMEOUT_MS is 600000 and REQUEST_ACK_GRACE_MS
// is 15000), each side naming the other, so neither can move alone. The
// derived window is pinned too, so the 30 s margin between the "expired"
// frame leaving and the waiting side's own timer cannot drift.
func TestDeadlineConstantsMatchTS(t *testing.T) {
	if VisitorAckTimeout != 600*time.Second {
		t.Errorf("VisitorAckTimeout = %v, want 600s (mirrors REQUEST_ACK_TIMEOUT_MS in client/lib/transfer/protocol.ts)", VisitorAckTimeout)
	}
	if VisitorAckGrace != 15*time.Second {
		t.Errorf("VisitorAckGrace = %v, want 15s (mirrors REQUEST_ACK_GRACE_MS in client/lib/transfer/protocol.ts)", VisitorAckGrace)
	}
	if HostDecisionWindow != 585*time.Second {
		t.Errorf("HostDecisionWindow = %v, want 585s (VisitorAckTimeout minus VisitorAckGrace)", HostDecisionWindow)
	}
	if HostDecisionWindow+2*VisitorAckGrace != VisitorAckTimeout+VisitorAckGrace {
		t.Errorf("the expired frame has %v to arrive, want exactly twice the grace", VisitorAckTimeout+VisitorAckGrace-HostDecisionWindow)
	}
}

// TestBrowserHashWaitsFitGoClocks pins the two Go clocks that the browser's
// digest waits are sized under: END_DIGEST_WAIT_MS (45 s, under the 60 s
// stall) and POST_END_HASH_WAIT_MS (90 s, under the 120 s ack wait) in
// client/lib/transfer/protocol.ts. Shortening either clock here without
// shrinking its twin there lets a slow browser hasher fail a whole file again.
func TestBrowserHashWaitsFitGoClocks(t *testing.T) {
	if receiveStallTimeout != 60*time.Second {
		t.Errorf("receiveStallTimeout = %v, want 60s (END_DIGEST_WAIT_MS in client/lib/transfer/protocol.ts is 45 s under it)", receiveStallTimeout)
	}
	if defaultAckTimeout != 120*time.Second {
		t.Errorf("defaultAckTimeout = %v, want 120s (POST_END_HASH_WAIT_MS in client/lib/transfer/protocol.ts is 90 s under it)", defaultAckTimeout)
	}
}

// TestKeyCheckWaitFitsTheOtherClocks: decision D7. An enforcing sender waits at
// most this long for a proof a keyed receiver sent at its start, so its first
// metadata still lands inside that receiver's idle clock.
func TestKeyCheckWaitFitsTheOtherClocks(t *testing.T) {
	if KeyCheckWait != 15*time.Second {
		t.Errorf("KeyCheckWait = %v, want 15s", KeyCheckWait)
	}
	if KeyCheckWait >= receiveIdleTimeout {
		t.Errorf("KeyCheckWait %v does not fit under the receive idle clock %v", KeyCheckWait, receiveIdleTimeout)
	}
}

// TestKeyCheckConstantsMatchTS reads client/lib/transfer/protocol.ts and holds
// its KEY_CHECK_WAIT_MS and two wire reasons to the Go values, so the clock and
// the two sentences cannot move on one side alone.
func TestKeyCheckConstantsMatchTS(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "client", "lib", "transfer", "protocol.ts"))
	if err != nil {
		t.Fatalf("read the browser twin: %v", err)
	}
	src := string(raw)

	wait := regexp.MustCompile(`(?m)^export const KEY_CHECK_WAIT_MS\b[^=\n]*=\s*([0-9_]+)\s*;`).FindStringSubmatch(src)
	if wait == nil {
		t.Fatal("protocol.ts has no KEY_CHECK_WAIT_MS constant")
	}
	ms, err := strconv.Atoi(strings.ReplaceAll(wait[1], "_", ""))
	if err != nil {
		t.Fatalf("KEY_CHECK_WAIT_MS is %q: %v", wait[1], err)
	}
	if want := int(KeyCheckWait / time.Millisecond); ms != want {
		t.Errorf("KEY_CHECK_WAIT_MS = %d, want %d (KeyCheckWait)", ms, want)
	}

	floor := regexp.MustCompile(`(?m)^const KEY_CHECK_PROTOCOL\s*=\s*(\d+);`).FindStringSubmatch(src)
	if floor == nil {
		t.Fatal("protocol.ts has no KEY_CHECK_PROTOCOL constant")
	}
	if got, err := strconv.Atoi(floor[1]); err != nil || got != keyCheckProtocol {
		t.Errorf("KEY_CHECK_PROTOCOL = %s, want %d (keyCheckProtocol)", floor[1], keyCheckProtocol)
	}

	for name, want := range map[string]string{
		"RECEIVER_UNVERIFIED_REASON": CodeUnverified.WireReason(),
		"SENDER_UNVERIFIED_REASON":   senderUnverifiedReason,
	} {
		m := regexp.MustCompile(`(?m)^export const ` + name + `\b[^=\n]*=\s*['"]([^'"\n]*)['"]\s*;`).FindStringSubmatch(src)
		if m == nil {
			t.Errorf("protocol.ts has no %s constant", name)
			continue
		}
		if m[1] != want {
			t.Errorf("%s = %q, want %q", name, m[1], want)
		}
	}
}
