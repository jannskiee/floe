package transfer

// The one clock pair for a transfer whose receiver is a person deciding
// whether to accept. Every surface derives its wait from these two constants
// and never restates a literal; client/lib/transfer/protocol.ts mirrors them as
// REQUEST_ACK_TIMEOUT_MS and REQUEST_ACK_GRACE_MS, pinned by parity tests on
// both sides (TestDeadlineConstantsMatchTS here).

import "time"

const (
	// VisitorAckTimeout is how long the side that offered the files waits for
	// the receiver's first ack while a person decides. Its timer is the
	// binding clock: nothing the receiving side does can hold the offer open
	// past it, so the receiving side's own window is derived from it, below.
	VisitorAckTimeout = 10 * time.Minute

	// VisitorAckGrace is added to VisitorAckTimeout by the waiting side and
	// subtracted from it by the deciding side, so the two never fire at the
	// same instant. The deciding side's "expired" frame leaves at
	// HostDecisionWindow and has twice this grace (30 s) to cross the wire
	// before the waiting side's timer (VisitorAckTimeout plus VisitorAckGrace)
	// gives up on its own, with a generic timeout instead of the code.
	VisitorAckGrace = 15 * time.Second

	// HostDecisionWindow is how long the deciding side gives the person
	// before it answers "expired" on their behalf: 9 min 45 s. Derived, never
	// restated, so the margin above cannot drift.
	HostDecisionWindow = VisitorAckTimeout - VisitorAckGrace
)
