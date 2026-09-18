package transfer

import (
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
