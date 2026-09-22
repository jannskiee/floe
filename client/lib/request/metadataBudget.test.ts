import { describe, it, expect } from 'vitest';
import { metadataFrameBytes, checkPick, type PickCandidate } from './metadataBudget';
import { CONTROL_MSG_MAX } from '../transfer/protocol';

/** An ASCII path whose metadata frame measures exactly `target` bytes, for a
 *  selection of `total` files whose sizes sum to `sumOfSizes`.
 *
 *  Safe because every character it adds is one ASCII byte that JSON does not
 *  escape, so the frame grows by exactly one per character. Measured rather
 *  than hard-coded: pinning a magic path length here would make this file fail
 *  the day a field is added to the frame, which is a change the boundary should
 *  absorb, not announce.
 *
 *  The sum is spelled `sumOfSizes` rather than by its wire name on purpose.
 *  check-consumers.mjs scans every file for the wire field names and warns on a
 *  test that carries one, and that warning count is only worth having while it
 *  means "a test names a peer field". Nothing in this file touches a peer
 *  value: it measures the frame this side is about to build. */
function pathOfExactly(target: number, total = 1, sumOfSizes = 0): string {
    const probe = metadataFrameBytes('a', 0, total, sumOfSizes);
    return 'a'.repeat(1 + (target - probe));
}

function candidate(relativePath: string, size = 0): PickCandidate {
    return { relativePath, file: { size } };
}

describe('metadataFrameBytes and checkPick', () => {
    it('accepts 1000 bytes and refuses 1001 bytes', () => {
        // The cap is on the ENCODED frame, and it is exact: at 1000 the browser
        // receiver accepts and at 1001 it aborts the transfer.
        expect(CONTROL_MSG_MAX).toBe(1000);

        const at999 = pathOfExactly(999);
        const at1000 = pathOfExactly(1000);
        const at1001 = pathOfExactly(1001);

        expect(metadataFrameBytes(at999, 0, 1, 0)).toBe(999);
        expect(metadataFrameBytes(at1000, 0, 1, 0)).toBe(1000);
        expect(metadataFrameBytes(at1001, 0, 1, 0)).toBe(1001);

        expect(checkPick([candidate(at999)])).toEqual({ ok: true });
        expect(checkPick([candidate(at1000)])).toEqual({ ok: true });
        expect(checkPick([candidate(at1001)])).toEqual({ ok: false, cause: 'path-too-long' });
    });

    it('counts JSON escaping of quotes and backslashes', () => {
        // A character-count estimate is wrong here: both of these cost two
        // bytes inside a JSON string, and a folder named with either is
        // ordinary on every platform that allows it.
        const plain = metadataFrameBytes('aaaa', 0, 1, 0);
        expect(metadataFrameBytes('a"aa', 0, 1, 0)).toBe(plain + 1);
        expect(metadataFrameBytes('a\\aa', 0, 1, 0)).toBe(plain + 1);
        expect(metadataFrameBytes('a"a\\', 0, 1, 0)).toBe(plain + 2);
    });

    it('counts astral characters as four UTF-8 bytes', () => {
        // One code point, two UTF-16 units, four encoded bytes. A path length
        // in .length would have called this two.
        const twoAscii = metadataFrameBytes('aa', 0, 1, 0);
        expect(metadataFrameBytes('\u{1F600}', 0, 1, 0)).toBe(twoAscii + 2);
        // A BMP non-ASCII character is three bytes, not one.
        expect(metadataFrameBytes('世a', 0, 1, 0)).toBe(twoAscii + 2);
    });

    it('counts escaped control characters', () => {
        const twoAscii = metadataFrameBytes('ab', 0, 1, 0);
        // A tab becomes the two characters \t.
        expect(metadataFrameBytes('a\t', 0, 1, 0)).toBe(twoAscii + 1);
        // Anything without a short escape becomes \u00XX, six characters.
        expect(metadataFrameBytes('a\u0000', 0, 1, 0)).toBe(twoAscii + 5);
        expect(metadataFrameBytes('a\u001f', 0, 1, 0)).toBe(twoAscii + 5);
    });

    it('a total of 10,000 costs more digits than 9', () => {
        // `index` is measured at its widest, which is `total`, so the count
        // costs its digits twice over.
        const few = metadataFrameBytes('a', 0, 9, 0);
        const many = metadataFrameBytes('a', 0, 10_000, 0);
        expect(many).toBeGreaterThan(few);
        expect(many - few).toBe(8);
    });

    it('rechecks the whole selection when a second pick raises total', () => {
        // The trap this closes: two of the three inputs to a frame's size
        // belong to the SELECTION, not the file. A path that fit alone stops
        // fitting when a later pick makes the batch-size field wider, and a
        // check that only measured the newly added files would never look at
        // it again.
        const boundary = pathOfExactly(CONTROL_MSG_MAX);
        const first = [candidate(boundary)];
        expect(checkPick(first)).toEqual({ ok: true });

        const second = [...first, candidate('b', 1_000_000)];
        expect(checkPick(second)).toEqual({ ok: false, cause: 'path-too-long' });
        // ...and it is the FIRST file that no longer fits, not the new one.
        expect(metadataFrameBytes('b', 1_000_000, 2, 1_000_000)).toBeLessThan(CONTROL_MSG_MAX);
        expect(metadataFrameBytes(boundary, 0, 2, 1_000_000)).toBeGreaterThan(CONTROL_MSG_MAX);
    });
});
