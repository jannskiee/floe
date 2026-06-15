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
});

describe('formatETA', () => {
    it('returns empty string for negative', () => expect(formatETA(-1)).toBe(''));
    it('returns empty string for NaN', () => expect(formatETA(NaN)).toBe(''));

    it('formats seconds', () => {
        expect(formatETA(0)).toBe('0s');
        expect(formatETA(30)).toBe('30s');
        expect(formatETA(59.9)).toBe('60s');
    });

    it('formats minutes and seconds', () => {
        expect(formatETA(90)).toBe('1m 30s');
        expect(formatETA(3599)).toBe('59m 59s'); // Math.ceil(3599 % 60) = ceil(59) = 59
    });

    it('formats hours and minutes', () => {
        expect(formatETA(3600)).toBe('1h 0m');
        expect(formatETA(7500)).toBe('2h 5m');
    });
});
