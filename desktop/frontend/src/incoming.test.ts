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

    // The unit is chosen after rounding. Chosen from the raw count, a count
    // just under the next unit rounded up to 1024.0 in the unit below: from
    // 1048525 bytes (1023.95 KB) up, it read "1024.0 KB".
    // client/lib/utils.test.ts and cli/engine/transfer/format_test.go pin the
    // same boundaries.
    it('reads a count just under the next unit in that unit', () => {
        expect(fmtBytes(1048525)).toBe('1.0 MB');
        expect(fmtBytes(1024 ** 2 - 1)).toBe('1.0 MB');
        expect(fmtBytes(1073689396)).toBe('1.0 GB');
        expect(fmtBytes(1024 ** 3 - 1)).toBe('1.0 GB');
        expect(fmtBytes(1099457940685)).toBe('1.0 TB');
        expect(fmtBytes(1024 ** 4 - 1)).toBe('1.0 TB');
    });

    it('stays in TB, the last unit, just under a petabyte', () => {
        expect(fmtBytes(1024 ** 5 - 1)).toBe('1024.0 TB');
        expect(fmtBytes(1024 ** 5)).toBe('1024.0 TB');
    });

    it('leaves a count that rounds below 1024 where it was', () => {
        expect(fmtBytes(1000)).toBe('1000 B');
        expect(fmtBytes(1048524)).toBe('1023.9 KB');
        expect(fmtBytes(1073689395)).toBe('1023.9 MB');
        expect(fmtBytes(1099457940684)).toBe('1023.9 GB');
        expect(fmtBytes(512 * 1024)).toBe('512.0 KB');
        expect(fmtBytes(1024 ** 3)).toBe('1.0 GB');
        expect(fmtBytes(1024 ** 4)).toBe('1.0 TB');
    });
});
