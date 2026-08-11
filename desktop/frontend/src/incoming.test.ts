import {describe, expect, it} from 'vitest';
import {fmtBytes, formatIncoming} from './incoming';

describe('formatIncoming', () => {
    it('single file shows its name and size', () => {
        expect(formatIncoming({files: 1, totalBytes: 31457280, firstName: 'video.mp4'})).toBe(
            'Incoming: video.mp4 · 30.0 MB',
        );
    });

    it('a single zero-byte file shows 0 B, matching the CLI box', () => {
        expect(formatIncoming({files: 1, totalBytes: 0, firstName: 'empty.bin'})).toBe('Incoming: empty.bin · 0 B');
    });

    it('batch shows the count and total', () => {
        expect(formatIncoming({files: 3, totalBytes: 851443712, firstName: 'a.jpg'})).toBe(
            'Incoming: 3 files · 812.0 MB',
        );
    });

    it('batch without a total shows the count only', () => {
        expect(formatIncoming({files: 5, totalBytes: 0, firstName: 'a.jpg'})).toBe('Incoming: 5 files');
    });

    it('an empty first name falls back to a generic word', () => {
        expect(formatIncoming({files: 1, totalBytes: 4, firstName: ''})).toBe('Incoming: file · 4 B');
    });
});

describe('fmtBytes', () => {
    it('matches the app-wide rendering', () => {
        expect(fmtBytes(0)).toBe('0 B');
        expect(fmtBytes(1023)).toBe('1023 B');
        expect(fmtBytes(1536)).toBe('1.5 KB');
        expect(fmtBytes(1048576)).toBe('1.0 MB');
    });
});
