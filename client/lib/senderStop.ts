import type { RefusalCode } from '@/lib/transfer/protocol';
import type { KeyMode } from './transfer/keySession';
import { KEY_REFUSED_SENDER, KEY_UNAVAILABLE_SENDER } from './linkKeyCopy';

// What a browser SENDER says when its peer refused a file. Pure and outside
// P2PTransfer.tsx for the same reason receiverClose.ts is: nothing in the suite
// mounts the component, so the branch has to be testable on its own.
//
// Approved copy (D-092, D-101). It names no file, no digest and no peer text:
// the peer's prose stops at refusalCodeOf, and only the allowlisted code gets
// here. The audit's web leg waits for this exact string
// (.claude/skills/transfer-audit/scripts/lib/web.mjs HASH_REFUSAL_SENTENCE, pinned
// against this file by web.test.mjs), so a reword is a two-file change.
export const SENDER_HASH_STOP =
    'The other side discarded a file that did not match what was sent. Try sending again.';

// What the sending page says when its own send code throws. The twin of
// INTERNAL_ERROR_MESSAGE in lib/transfer/receiver.ts, ending in the remedy the
// sending page's other failures name. The send is started from a timer and
// never awaited, so until it had a catch a throw in it showed nothing at all.
export const SEND_INTERNAL_ERROR =
    'Something went wrong while sending, so the transfer was stopped. Reload the page, add the files again, and share the new link.';

// The words for a stop with the link key's code once the receiver has answered a file.
// The same fallback the page's error handler uses, so no peer's words get here either.
export const SENDER_REJECTED = 'The other side rejected the transfer.';

/**
 * The fixed sentence for a stop this side can name, or null when today's
 * onError wording should stand. Hash-mismatch and unverified have their own
 * sentence; every other code and a null code keep the existing text (the visitor
 * page's per-code copy is S1-WEB-03's).
 *
 * `keyUnavailable` is this page's own fact, that it could not read the connection's
 * certificates and so had no proof to give. That is why a keyed receiver refused it,
 * and telling the person to make a new link would not help.
 *
 * `acked` says the receiver has answered a file, after which a file's bytes can have
 * gone. Both key sentences say nothing was sent, and a hostile receiver that holds the
 * bytes could otherwise make the page say so, so past that point the code gets the plain
 * words.
 *
 * `saved` and `files` are accepted and deliberately unused, so the shape is
 * ready for that per-code copy without a signature change.
 */
export function describeSenderStop(stop: {
    code: RefusalCode | null;
    saved: number;
    files: number;
    keyUnavailable?: boolean;
    acked?: boolean;
}): string | null {
    if (stop.code === 'hash-mismatch') return SENDER_HASH_STOP;
    if (stop.code === 'unverified') {
        if (stop.acked) return SENDER_REJECTED;
        return stop.keyUnavailable ? KEY_UNAVAILABLE_SENDER : KEY_REFUSED_SENDER;
    }
    return null;
}

/**
 * Whether the sender's close handler says the connection was interrupted: the
 * transfer had started and not finished, and this side did not close it. A
 * receiver that stops mid-file (it ran out of memory, or its tab closed)
 * closes the connection, and the send engine then stops without a word, so
 * without this the screen stayed on "Sending: <name>" (#500).
 *
 * Not after a wire reason: a receiver that refused a file on purpose (a Go
 * receiver sends hash-mismatch and then closes) has already said why through
 * onStopped, and the close that follows must not relabel it as a connection
 * problem, the same latch the sender's error handler honors.
 *
 * `acked` counts as started: progress moves on a 500 ms ticker and reads 0 below half a
 * percent of a file, which can be a lot of bytes, and past that ack nothing else speaks.
 */
export function senderCloseInterrupted(close: {
    transferComplete: boolean;
    progress: number;
    closedByUs: boolean;
    wireReason: boolean;
    acked?: boolean;
}): boolean {
    return !close.transferComplete && (close.progress > 0 || close.acked === true) && !close.closedByUs && !close.wireReason;
}

/**
 * Whether a connection that went after the link-key check found something owes the
 * page that account, in place of whatever the close or the error would say. For when
 * the send engine never got to act on it: it starts up to 2 s after the connection
 * (lib/relay.ts), which is as long as a refusing browser waits before it closes, and
 * it does not run at all once the peer is gone.
 *
 * The opposite of senderCloseInterrupted: the sentence this picks says nothing was sent,
 * so it holds only until the receiver answers a file. No file byte goes before that
 * answer, and the ack is read for it, not progress, which reads 0 long after the first
 * byte. Observe mode stops nothing and tells nobody.
 */
export function senderKeyFailureAtClose(close: {
    mode: KeyMode;
    transferComplete: boolean;
    acked: boolean;
    closedByUs: boolean;
    wireReason: boolean;
}): boolean {
    return close.mode !== 'observe' && !close.transferComplete && !close.acked && !close.closedByUs && !close.wireReason;
}
