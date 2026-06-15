import { describe, it, expect } from 'vitest';
import { formatBytes } from './utils';

describe('formatBytes', () => {
    it('returns "0 Bytes" for 0', () => expect(formatBytes(0)).toBe('0 Bytes'));

    it('formats bytes', () => expect(formatBytes(500)).toBe('500 Bytes'));

    it('formats KB', () => expect(formatBytes(1024)).toBe('1 KB'));
    it('formats fractional KB', () => expect(formatBytes(1536)).toBe('1.5 KB'));

    it('formats MB', () => expect(formatBytes(1024 * 1024)).toBe('1 MB'));
    it('formats fractional MB', () => expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB'));

    it('formats GB', () => expect(formatBytes(1024 ** 3)).toBe('1 GB'));
});
