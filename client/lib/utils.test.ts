import { describe, it, expect } from 'vitest';
import { BYTE_COUNT_FORMAT, formatBytes, formatSplitBytes, splitBytes } from './utils';
import { RELAY_SIZE_LIMIT } from './relay';

describe('formatBytes', () => {
    it('returns "0 Bytes" for 0', () => expect(formatBytes(0)).toBe('0 Bytes'));

    it('formats bytes', () => expect(formatBytes(500)).toBe('500 Bytes'));

    it('formats KB', () => expect(formatBytes(1024)).toBe('1 KB'));
    it('formats fractional KB', () => expect(formatBytes(1536)).toBe('1.5 KB'));

    it('formats MB', () => expect(formatBytes(1024 * 1024)).toBe('1 MB'));
    it('formats fractional MB', () => expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB'));

    it('formats GB', () => expect(formatBytes(1024 ** 3)).toBe('1 GB'));
});

// The guards both formatters were missing one half of. Math.log of a negative
// is NaN; BYTE_UNITS[NaN] and BYTE_UNITS[Math.min(NaN, 4)] are both undefined,
// so formatBytes printed "NaN undefined" and splitBytes returned an undefined
// unit. formatBytes also had no top clamp, so a petabyte printed
// "1 undefined". cli/engine/transfer/format.go carries the post-mortem for the
// same bug on the Go side, where it was fixed and the browser was not.
describe('byte formatter guards', () => {
    const bad = [-1, -1024, NaN, Infinity, -Infinity];

    it('formatBytes never emits an undefined unit', () => {
        for (const n of bad) expect(formatBytes(n)).toBe('0 Bytes');
        expect(formatBytes(1024 ** 5)).toBe('1024 TB');
        expect(formatBytes(1024 ** 6)).toBe('1048576 TB');
    });

    it('splitBytes never emits an undefined unit', () => {
        for (const n of bad) expect(splitBytes(n)).toEqual({ value: 0, unit: 'Bytes' });
        expect(splitBytes(1024 ** 5)).toEqual({ value: 1024, unit: 'TB' });
    });

    it('renders the relay cap the way every other copy of the string spells it', () => {
        expect(formatBytes(RELAY_SIZE_LIMIT)).toBe('2 GB');
    });
});

// The static fallback in components/AnimatedByteCount.tsx has to be
// indistinguishable from the animated counter it replaces, and components are
// not reachable from this suite, so the string itself is pinned here.
describe('formatSplitBytes', () => {
    // Built locally rather than hardcoded, because the runtime locale decides
    // the group and decimal separators and a contributor's default is not
    // necessarily en-US.
    const asNumberFlowWouldPaint = (value: number, unit: string) =>
        `${new Intl.NumberFormat(undefined, BYTE_COUNT_FORMAT).format(value)} ${unit}`;

    it('pads to two fraction digits the way NumberFlow does', () => {
        // 1181116006 bytes is 1.10 GB. splitBytes returns 1.1, so a bare
        // template literal would render "1.1 GB" and drift from the animation.
        expect(formatSplitBytes(splitBytes(1181116006))).toBe(asNumberFlowWouldPaint(1.1, 'GB'));
        expect(formatSplitBytes(splitBytes(1181116006))).toMatch(/^1\D10 GB$/);
    });

    it('renders the pre-load zero the same way', () => {
        expect(formatSplitBytes(splitBytes(0))).toBe(asNumberFlowWouldPaint(0, 'Bytes'));
    });

    it('groups large values, as Intl.NumberFormat does', () => {
        expect(formatSplitBytes({ value: 1234.5, unit: 'TB' })).toBe(
            asNumberFlowWouldPaint(1234.5, 'TB')
        );
    });
});

// The unit is chosen after rounding. Chosen from the raw count, a count just
// under the next unit rounded up to 1024 in the unit below: 1048575 bytes is
// 1023.999 KB, and it read "1024 KB". cli/engine/transfer/format_test.go pins
// the same rows, and desktop/frontend/src/incoming.test.ts the same boundaries.
describe('a size just under the next unit', () => {
    it('reads in that unit', () => {
        expect(formatBytes(1048571)).toBe('1 MB');
        expect(formatBytes(1024 ** 2 - 1)).toBe('1 MB');
        expect(formatBytes(1073736582)).toBe('1 GB');
        expect(formatBytes(1024 ** 3 - 1)).toBe('1 GB');
        expect(formatBytes(1099506259067)).toBe('1 TB');
        expect(formatBytes(1024 ** 4 - 1)).toBe('1 TB');
    });

    it('splits the same way, for the counter on the home page', () => {
        expect(splitBytes(1024 ** 2 - 1)).toEqual({ value: 1, unit: 'MB' });
        expect(splitBytes(1024 ** 3 - 1)).toEqual({ value: 1, unit: 'GB' });
        expect(splitBytes(1024 ** 4 - 1)).toEqual({ value: 1, unit: 'TB' });
    });

    it('stays in TB, the last unit, just under a petabyte', () => {
        expect(formatBytes(1024 ** 5 - 1)).toBe('1024 TB');
        expect(splitBytes(1024 ** 5 - 1)).toEqual({ value: 1024, unit: 'TB' });
    });

    it('leaves a count that rounds below 1024 where it was', () => {
        expect(formatBytes(1000)).toBe('1000 Bytes');
        expect(formatBytes(1023)).toBe('1023 Bytes');
        expect(formatBytes(1048570)).toBe('1023.99 KB');
        expect(formatBytes(1073736581)).toBe('1023.99 MB');
        expect(formatBytes(1099506259066)).toBe('1023.99 GB');
        expect(formatBytes(512 * 1024)).toBe('512 KB');
        expect(formatBytes(1024 ** 4)).toBe('1 TB');
    });
});
