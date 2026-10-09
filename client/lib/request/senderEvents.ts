// How the visitor page reads a send: sendFiles' callbacks, mapped to reducer
// events.
//
// Pure, and in lib/ so the mapping itself is tested, not only the reducer that
// consumes it (WP-W1 review F2). The rules it carries from the S1-WEB-07
// review:
//
// - Delivered (E22, RECEIVED) comes from onAllSent and from nothing else.
//   Under requireReceived onAllSent fires only after the host's `received`
//   follows the last end frame, while a `received` frame itself can arrive at
//   any moment: onDelivered is a claim, mapped to the display-only verified
//   count, and onReceived is not mapped at all.
// - A refusal sets the page's wire-verdict latch before its event, so the
//   close the host sends next cannot overwrite it (spec 07 4.7).
// - Arrived moves only on onAck's index, the sender's own count.
// - The page never reads onError or onFileStart: the one carries peer text on
//   some paths, the other the file's bare name rather than the visitor's path.
//
// Every value taken from a stop or a report arrives already reduced by the
// sender: code allowlisted (refusalCodeOf) or null, saved clamped, verified
// range checked (verifiedCountOf) or null, rangeOverlaps a boolean.

import type { SenderCallbacks } from '../transfer/sender';
import type { VisitorEvent } from './visitorState';

export interface SenderEventDeps {
    /** Dispatch for this attempt only (the page's attempt gate). */
    dispatch: (event: VisitorEvent) => void;
    now: () => number;
    /** Mandatory under requireReceived, which has no deadline (E-36). */
    isDestroyed: () => boolean;
    /** Set the page's wire-verdict latch. */
    onWireVerdict: () => void;
}

export function senderEvents(deps: SenderEventDeps): SenderCallbacks {
    return {
        isDestroyed: deps.isDestroyed,
        onAck: (index) => deps.dispatch({ type: 'ACK', index, now: deps.now() }),
        onProgress: (percent) => deps.dispatch({ type: 'PROGRESS', percent }),
        onSpeed: (bytesPerSec, etaSeconds) => deps.dispatch({ type: 'PROGRESS', bytesPerSec, etaSeconds }),
        onStopped: (stop) => {
            deps.onWireVerdict();
            deps.dispatch({
                type: 'INCOMPATIBLE',
                refusal: stop.code,
                savedCount: stop.saved,
                rangeOverlaps: stop.rangeOverlaps,
            });
        },
        onDelivered: (report) => deps.dispatch({ type: 'VERIFIED_COUNT', verifiedCount: report.verified }),
        onAllSent: () => deps.dispatch({ type: 'RECEIVED', now: deps.now() }),
        onFailed: (failure) =>
            deps.dispatch(
                failure.kind === 'ack-timeout'
                    ? { type: 'ACK_TIMEOUT', index: failure.index }
                    : failure.kind === 'unreadable'
                      ? { type: 'UNREADABLE', index: failure.index }
                      : { type: 'CHANNEL_CLOSED' }
            ),
    };
}
