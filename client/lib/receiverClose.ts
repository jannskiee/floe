// What a receiver should show when its peer connection closes.
//
// Pure, and outside P2PTransfer.tsx, for the same reason peerErrors.ts is: the
// branchy part is the part that was wrong. The handler used to write a Sentry
// breadcrumb and nothing else, so `isConnected` stayed true and the last status
// line stayed on screen after the sender had walked away. Two of the three
// branches that replaced it were also wrong on the first attempt, one of them
// unreachable and one of them firing on a healthy reconnect, and neither showed
// up in a test because nothing mounts the component.
//
// The caller owns every side effect (setError, setStatus, setIsConnected,
// Sentry) and supplies the outcome sentence for a partial receive, because that
// wording belongs to the component.

export type ReceiverCloseDecision =
    | { kind: 'silent' }
    | { kind: 'outcome' }
    | { kind: 'failed'; error: string };

export interface ReceiverCloseInputs {
    /** This side asked for the teardown, so it already knows why. */
    closedByUs: boolean;
    /**
     * A replacement peer is already in place. The Socket.IO rejoin path builds
     * one and the outgoing peer's close can still be in flight, which is how a
     * reconnect used to pin a permanent failure on a transfer that was fine.
     */
    replaced: boolean;
    /** The peer sent a reason, and it beats anything the transport says next. */
    wireReason: boolean;
    /** Files handed to the person so far. */
    receivedCount: number;
}

export const RECEIVER_CLOSED_EARLY =
    'The sender ended the transfer before it finished.';

/**
 * Decides what a receiver shows when its peer closes.
 *
 * Ordered by what the person can already see. Anything that has explained
 * itself stays quiet; a run that produced files reports its outcome, whether it
 * finished or not; only a receive that produced nothing gets the failure line.
 *
 * Note there is no `transferComplete` input, deliberately. That ref is set on
 * the FIRST completed file and never cleared, so gating on it made the
 * partial-receive branch unreachable: any close after any file went to the
 * silent path. `receivedCount` is the honest question.
 */
export function decideReceiverClose(inputs: ReceiverCloseInputs): ReceiverCloseDecision {
    if (inputs.closedByUs || inputs.replaced || inputs.wireReason) {
        return { kind: 'silent' };
    }
    if (inputs.receivedCount > 0) {
        return { kind: 'outcome' };
    }
    return { kind: 'failed', error: RECEIVER_CLOSED_EARLY };
}
