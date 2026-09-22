import type { RefusalCode } from '@/lib/transfer/protocol';

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

/**
 * The fixed sentence for a stop this side can name, or null when today's
 * onError wording should stand. Only hash-mismatch has its own sentence; every
 * other code and a null code keep the existing text (the visitor page's
 * per-code copy is S1-WEB-03's).
 *
 * `saved` and `files` are accepted and deliberately unused, so the shape is
 * ready for that per-code copy without a signature change.
 */
export function describeSenderStop(stop: {
    code: RefusalCode | null;
    saved: number;
    files: number;
}): string | null {
    return stop.code === 'hash-mismatch' ? SENDER_HASH_STOP : null;
}
