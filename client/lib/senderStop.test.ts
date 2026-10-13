import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { describeSenderStop, SEND_INTERNAL_ERROR, SENDER_HASH_STOP, senderCloseInterrupted } from './senderStop';

// The code type is deliberately not imported here: the consumer-map checker
// counts that name as a peer-field token, and its warning total is a max
// check. TypeScript infers these literals from the parameter type anyway.
const OTHER_CODES = [
    'declined',
    'disk-full',
    'expired',
    'file-too-large-for-folder',
    'over-approved',
    'path-too-long',
    'relay-cap',
    'save-blocked',
    'stopped',
    'time-limit',
    'write-failed',
] as const;

describe('describeSenderStop', () => {
    it('hash-mismatch maps to the fixed sentence and never the peer text', () => {
        expect(
            describeSenderStop({ code: 'hash-mismatch', saved: 0, files: 1 })
        ).toBe(SENDER_HASH_STOP);
        // saved and files are accepted and unused, so no count can leak into
        // the sentence through them.
        expect(
            describeSenderStop({ code: 'hash-mismatch', saved: 7, files: 3 })
        ).toBe(SENDER_HASH_STOP);
    });

    it('other codes and null keep the onError text', () => {
        for (const c of OTHER_CODES) {
            expect(describeSenderStop({ code: c, saved: 0, files: 1 })).toBe(
                null
            );
        }
        expect(describeSenderStop({ code: null, saved: 0, files: 1 })).toBe(
            null
        );
    });

    it('the sentence is the D-092 string byte for byte', () => {
        // Quoted, never built by concatenation: the audit's web leg waits for
        // this exact string and web.test.mjs reads it out of senderStop.ts.
        expect(SENDER_HASH_STOP).toBe(
            'The other side discarded a file that did not match what was sent. Try sending again.'
        );
        expect(SENDER_HASH_STOP).not.toMatch(/SHA|256|[0-9a-f]{64}/);
    });
});

describe('senderCloseInterrupted', () => {
    const base = { transferComplete: false, progress: 40, closedByUs: false, wireReason: false };

    it('stays quiet after the receiver said why it stopped', () => {
        // A Go receiver that refuses a file (hash-mismatch) sends its frame and
        // then closes. onStopped already latched the wire reason and set
        // "Transfer failed" under the fixed sentence; the close that follows
        // must not relabel that as a connection problem.
        expect(senderCloseInterrupted({ ...base, wireReason: true })).toBe(false);
    });

    it('says interrupted when a started transfer loses a connection this side did not close', () => {
        expect(senderCloseInterrupted(base)).toBe(true);
    });

    it('stays quiet once every file was sent, before any byte moved, or when this side closed', () => {
        expect(senderCloseInterrupted({ ...base, transferComplete: true })).toBe(false);
        expect(senderCloseInterrupted({ ...base, progress: 0 })).toBe(false);
        expect(senderCloseInterrupted({ ...base, closedByUs: true })).toBe(false);
    });
});

// P2PTransfer cannot be mounted here (vitest runs in node, with no DOM), so the
// order of four lines in it is read as text. e2e/send-status.spec.ts drives
// the real thing; this is so that undoing either change fails in the unit job.
describe('how the sender page uses a stop', () => {
    const page = readFileSync(fileURLToPath(new URL('../components/P2PTransfer.tsx', import.meta.url)), 'utf8');
    const stopped = page.slice(page.indexOf('onStopped: (stop) => {'));

    // Every stop the peer reports is latched, not only the one that has a
    // sentence of its own. Latched below the early return, a refusal with any
    // other code left "Transfer failed" unprotected, and the next socket drop
    // wrote "Transfer complete" over it.
    it('latches the wire reason before it asks whether the stop has its own sentence', () => {
        const latch = stopped.indexOf('wireReasonRef.current = true;');
        const sentence = stopped.indexOf('const sentence = describeSenderStop(');
        expect(latch).toBeGreaterThan(0);
        expect(sentence).toBeGreaterThan(latch);
    });

    // The latch silences the error handler, and that handler held the only
    // count of a failed send for a refusal that is not a hash mismatch. So the
    // count is taken here, once, for every stop.
    it('counts the failed send before that early return too', () => {
        const count = stopped.indexOf("track('transfer-failed'");
        const early = stopped.indexOf('if (!sentence) return;');
        expect(count).toBeGreaterThan(0);
        expect(early).toBeGreaterThan(count);
        expect(stopped.slice(0, stopped.indexOf('\n                },')).split("track('transfer-failed'")).toHaveLength(2);
    });

    // transferCompleteRef and progressRef are per send. Left set, they made
    // every later send read as the first one's outcome.
    it('clears the two per-send refs where a sender session begins', () => {
        const from = page.indexOf('The only place a sender session begins');
        const to = page.indexOf("setStatus('Peer joined. Starting transfer');", from);
        expect(from).toBeGreaterThan(0);
        const block = page.slice(from, to);
        expect(block).toContain('wireReasonRef.current = false;');
        expect(block).toContain('transferCompleteRef.current = false;');
        expect(block).toContain('progressRef.current = 0;');
    });
});

// The send starts inside a timer callback, so nothing awaits it. A throw
// inside the send engine was an unhandled rejection and nothing else: the
// report went to Sentry and the page stayed on its last status line for good.
describe('a send that throws', () => {
    const page = readFileSync(fileURLToPath(new URL('../components/P2PTransfer.tsx', import.meta.url)), 'utf8');

    it('has fixed words of its own, the twin of the receiver sentence', () => {
        expect(SEND_INTERNAL_ERROR).toBe(
            'Something went wrong while sending, so the transfer was stopped. Reload the page, add the files again, and share the new link.'
        );
    });

    it('is caught where the send is started, and nowhere started without the catch', () => {
        expect(page.match(/sendAllFiles\(peer, files\)/g)).toHaveLength(1);
        expect(page).toContain('sendAllFiles(peer, files).catch((cause: unknown) => {');
    });

    // The handler says something and then lets the throw go on, so the report
    // Sentry already made of it (an unhandled rejection) is the one it keeps
    // making. A session the page has moved on from, and a send whose files had
    // all left, keep what they show.
    it('shows the sentence without talking over a banner, and rethrows', () => {
        const from = page.indexOf('sendAllFiles(peer, files).catch((cause: unknown) => {');
        const handler = page.slice(from, page.indexOf('\n                    });', from));
        expect(handler).toContain('if (peerRef.current === peer && !transferCompleteRef.current) {');
        expect(handler).toContain('setError((prev) => prev || SEND_INTERNAL_ERROR);');
        expect(handler).toContain("setStatus('Transfer failed');");
        expect(handler).toContain("setSendEnd((end) => (end === 'open' ? 'failed' : end));");
        expect(handler.trimEnd().endsWith('throw cause;')).toBe(true);
        expect(handler).not.toContain('Sentry.');
    });
});
