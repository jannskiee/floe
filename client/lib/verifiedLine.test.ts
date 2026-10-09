import { describe, it, expect } from 'vitest';
import { verifiedLine, VERIFIED_LINE } from './verifiedLine';

describe('verifiedLine', () => {
    it('every file verified shows the line', () => {
        expect(verifiedLine([{ verified: true }], 1)).toBe(VERIFIED_LINE);
        expect(verifiedLine([{ verified: true }, { verified: true }], 2)).toBe(
            VERIFIED_LINE
        );
        expect(VERIFIED_LINE).toBe('SHA-256 matched');
    });

    it('one unverified file shows nothing', () => {
        expect(verifiedLine([{ verified: true }, { verified: false }], 2)).toBe(
            null
        );
        expect(verifiedLine([{ verified: false }], 1)).toBe(null);
    });

    it('zero files or a count below the announced total show nothing', () => {
        expect(verifiedLine([], 0)).toBe(null);
        expect(verifiedLine([], 2)).toBe(null);
        expect(verifiedLine([{ verified: true }], 0)).toBe(null);
        // A partial receive proves nothing about the files that never came.
        expect(verifiedLine([{ verified: true }], 2)).toBe(null);
    });
});
