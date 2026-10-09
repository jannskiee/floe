package transfer

// The one clock pair for a transfer whose receiver is a person deciding
// whether to accept. Every surface derives its wait from these two constants
// and never restates a literal; client/lib/transfer/protocol.ts mirrors them as
// REQUEST_ACK_TIMEOUT_MS and REQUEST_ACK_GRACE_MS, pinned by parity tests on
// both sides (TestDeadlineConstantsMatchTS here). Declared one per line on
// purpose, so a grep for each definition finds exactly one.
//
// The sender's own default ack wait lives here too, so sender.go carries no
// deadline literal and every transfer clock is readable in one file.

import "time"

// VisitorAckTimeout is how long the side that offered the files waits for the
// receiver's first ack while a person decides. Its timer is the binding
// clock: nothing the receiving side does can hold the offer open past it, so
// the receiving side's own window is derived from it, below.
const VisitorAckTimeout = 10 * time.Minute

// VisitorAckGrace is added to VisitorAckTimeout by the waiting side and
// subtracted from it by the deciding side, so the two never fire at the same
// instant. The deciding side's "expired" frame leaves at HostDecisionWindow
// and has twice this grace (30 s) to cross the wire before the waiting side's
// timer (VisitorAckTimeout plus VisitorAckGrace) gives up on its own, with a
// generic timeout instead of the code.
const VisitorAckGrace = 15 * time.Second

// HostDecisionWindow is how long the deciding side gives the person before it
// answers "expired" on their behalf: 9 min 45 s. Derived, never restated, so
// the margin above cannot drift.
const HostDecisionWindow = VisitorAckTimeout - VisitorAckGrace

// defaultAckTimeout is how long a sender waits for a file's first ack when
// SendOptions.AckTimeout is zero. It is sized for the person already at the
// keyboard answering `floe receive`'s own "Accept? [Y/n]" prompt, which is
// the only decider today's callers have. The baseline spike measured it
// firing at 120.006 s.
const defaultAckTimeout = 120 * time.Second

// ackTimeoutOrDefault is the one place the zero SendOptions.AckTimeout turns
// into a duration. Anything at or below zero takes the default rather than
// arming a timer that has already expired: the value comes from a local
// caller, never from a peer, so a nonsensical one is a programming mistake
// and silently failing every send in 0 s would be the worst way to report it.
func ackTimeoutOrDefault(d time.Duration) time.Duration {
	if d <= 0 {
		return defaultAckTimeout
	}
	return d
}
