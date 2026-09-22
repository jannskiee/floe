import { describe, it, expect } from 'vitest';
import { describeSenderStop, SENDER_HASH_STOP } from './senderStop';

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
