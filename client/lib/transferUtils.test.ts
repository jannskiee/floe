import { describe, it, expect } from 'vitest';
import { formatSpeed, formatETA } from './transferUtils';

describe('formatSpeed', () => {
    it('returns empty string for 0', () => expect(formatSpeed(0)).toBe(''));
    it('returns empty string for negative', () => expect(formatSpeed(-1)).toBe(''));
    it('returns empty string for NaN', () => expect(formatSpeed(NaN)).toBe(''));
    it('returns empty string for Infinity', () => expect(formatSpeed(Infinity)).toBe(''));

    it('formats KB/s below 1 MB/s', () => {
        expect(formatSpeed(512 * 1024)).toBe('512.0 KB/s');
    });

    it('formats MB/s at and above 1 MB', () => {
        expect(formatSpeed(1024 * 1024)).toBe('1.0 MB/s');
        expect(formatSpeed(5.5 * 1024 * 1024)).toBe('5.5 MB/s');
    });

    // MB/s from the rate whose KB/s figure rounds to 1024.0. The switch sat at
    // exactly 1048576 bytes a second, so a rate just under it read
    // "1024.0 KB/s". desktop/frontend/src/progress.test.ts and
    // cli/engine/transfer/format_test.go pin the same rows.
    it('formats MB/s once the KB/s figure would round to 1024.0', () => {
        expect(formatSpeed(1048525)).toBe('1.0 MB/s');
        expect(formatSpeed(1024 * 1024 - 1)).toBe('1.0 MB/s');
    });

    it('leaves a rate under that, and every MB/s rate, where it was', () => {
        expect(formatSpeed(1048524)).toBe('1023.9 KB/s');
        expect(formatSpeed(1000 * 1000)).toBe('976.6 KB/s');
        expect(formatSpeed(1024 ** 3)).toBe('1024.0 MB/s'); // there is no GB/s
    });
});

describe('formatETA', () => {
    it('returns empty string for negative', () => expect(formatETA(-1)).toBe(''));
    it('returns empty string for NaN', () => expect(formatETA(NaN)).toBe(''));

    it('formats seconds', () => {
        expect(formatETA(0)).toBe('0s');
        expect(formatETA(30)).toBe('30s');
    });

    it('formats minutes and seconds', () => {
        expect(formatETA(90)).toBe('1m 30s');
        expect(formatETA(3599)).toBe('59m 59s');
    });

    // The carry. Rounding the remainder instead of the whole value let the
    // seconds field reach 60, so these three read "60s", "1m 60s" and
    // "2m 60s". The Go twin truncates and never had it.
    it('never prints a seconds field of 60', () => {
        expect(formatETA(59.9)).toBe('1m 0s');
        expect(formatETA(119.5)).toBe('2m 0s');
        expect(formatETA(179.1)).toBe('3m 0s');
    });

    it('formats hours and minutes', () => {
        expect(formatETA(3600)).toBe('1h 0m');
        expect(formatETA(7500)).toBe('2h 5m');
    });
});
