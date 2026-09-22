// What the visitor page learns from a send, beyond the callbacks themselves.
//
// Two facts sendFiles does not report on its own:
//
// 1. Whether it ended with a verdict. Under requireReceived a send ends in
//    onAllSent (the host said received), onStopped (a refusal) or onFailed
//    (an ack timeout, a close, an unreadable file). Three exits report through
//    onError alone and then resolve normally: a metadata send() that throws,
//    an ack whose protocol range misses ours, and an ack with an unusable
//    resume offset. The last two are values the HOST chooses. The page never
//    renders onError, so a settlement with no verdict would otherwise leave it
//    in Waiting or Sending forever; it reads that settlement as Lost (spec 07
//    4.12.3 E31, the S1-WEB-07 review's M-1).
//
// 2. When the first metadata frame went out, which is when the page moves to
//    Waiting for accept (E17). There is no callback for it; the first string
//    frame of a send is its first metadata, because chunks are binary and the
//    end frame only follows an ack.

import type { SenderCallbacks, SenderDeps } from '../transfer/sender';

export interface SendWatch {
    /** The callbacks to hand sendFiles: the page's own, with the three
     *  verdicts recorded on the way through. */
    callbacks: SenderCallbacks;
    /** True once any verdict has fired. onReceived and onDelivered are not
     *  verdicts: a host can send `received` at any moment, so they are claims
     *  the page displays and never an ending (E22 comes from onAllSent). */
    reported(): boolean;
}

export function watchSend(cb: SenderCallbacks): SendWatch {
    let verdict = false;
    return {
        callbacks: {
            ...cb,
            onAllSent: () => {
                verdict = true;
                cb.onAllSent?.();
            },
            onStopped: (stop) => {
                verdict = true;
                cb.onStopped?.(stop);
            },
            onFailed: (failure) => {
                verdict = true;
                cb.onFailed?.(failure);
            },
        },
        reported: () => verdict,
    };
}

/** Wrap a send so `onFirst` runs once, right after the first STRING frame
 *  reached the channel. A send that throws reports nothing: that frame never
 *  left, and the throw is one of the silent exits above. */
export function firstStringFrame(
    send: SenderDeps['send'],
    onFirst: () => void
): SenderDeps['send'] {
    let seen = false;
    return (data) => {
        send(data);
        if (!seen && typeof data === 'string') {
            seen = true;
            onFirst();
        }
    };
}
