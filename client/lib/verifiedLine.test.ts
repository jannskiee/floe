import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// The check mark carries the words on both cards (the desktop's rule, D-161):
// a green circle-check when every file matched, a gray plain check when the
// transfer finished without that, and the words for screen readers only. The
// e2e specs find the two marks by data-mark.
describe('the check carries the words on both cards', () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

    for (const card of ['ReceiverPanel.tsx', 'ShareLinkPanel.tsx']) {
        it(`${card} draws a green or a gray check and never the words`, () => {
            const src = read(`../components/${card}`);
            expect(src).toMatch(/<CheckCircle2 data-mark="verified" className="[^"]*text-green-[45]00"/);
            expect(src).toMatch(/<Check data-mark="plain" className="[^"]*text-zinc-500"/);
            // The words are rendered in exactly one place, and it is sr-only.
            expect(src.match(/\{verifiedLine\}/g)).toHaveLength(1);
            expect(src).toContain('<p className="sr-only">{verifiedLine}</p>');
        });
    }
});
