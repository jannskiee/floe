import { describe, it, expect } from 'vitest';
import { formatBytes, splitBytes } from './utils';
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
