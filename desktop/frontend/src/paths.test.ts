import {describe, expect, it} from 'vitest';
import {baseName, mergePaths, normPath} from './paths';

// Every case that depends on the platform runs BOTH ways. That is the point of
// the platform being a parameter: this file runs under vitest's node
// environment, where a module-level navigator.userAgent read would report Node
// and silently test the POSIX branch only, on a Windows-first product.

describe('baseName', () => {
    it('splits on either separator, because the Go side sends the host format', () => {
        expect(baseName('C:\\Users\\a\\report.pdf')).toBe('report.pdf');
        expect(baseName('/home/a/report.pdf')).toBe('report.pdf');
        expect(baseName('C:/mixed\\separators/file.txt')).toBe('file.txt');
    });

    it('handles a bare name and an empty string', () => {
        expect(baseName('report.pdf')).toBe('report.pdf');
        expect(baseName('')).toBe('');
    });

    it('returns the empty segment for a trailing separator', () => {
        expect(baseName('C:\\Users\\a\\')).toBe('');
    });
});

describe('normPath', () => {
    it('folds case on Windows only', () => {
        expect(normPath('C:\\Users\\A\\Report.PDF', true)).toBe('c:\\users\\a\\report.pdf');
        expect(normPath('/home/a/Report.PDF', false)).toBe('/home/a/Report.PDF');
    });

    it('is identity on POSIX even for a Windows-looking path', () => {
        expect(normPath('C:\\X', false)).toBe('C:\\X');
    });
});

describe('mergePaths', () => {
    it('appends only what is not already staged', () => {
        expect(mergePaths(['a.txt'], ['b.txt'], false)).toEqual(['a.txt', 'b.txt']);
        expect(mergePaths(['a.txt'], ['a.txt'], false)).toEqual(['a.txt']);
    });

    it('treats a case-different path as a duplicate on Windows, not on POSIX', () => {
        expect(mergePaths(['C:\\a\\File.txt'], ['C:\\A\\file.TXT'], true)).toEqual([
            'C:\\a\\File.txt',
        ]);
        expect(mergePaths(['/a/File.txt'], ['/a/file.TXT'], false)).toEqual([
            '/a/File.txt',
            '/a/file.TXT',
        ]);
    });

    it('keeps the original spelling, never the folded one', () => {
        // normPath is for comparison only; what is displayed and handed to Go
        // must be exactly what the host produced.
        const out = mergePaths([], ['C:\\Users\\A\\Report.PDF'], true);
        expect(out).toEqual(['C:\\Users\\A\\Report.PDF']);
    });

    it('de-duplicates within the incoming batch too', () => {
        expect(mergePaths([], ['a.txt', 'A.TXT', 'b.txt'], true)).toEqual(['a.txt', 'b.txt']);
    });

    it('preserves order and does not mutate its input', () => {
        const prev = ['a.txt', 'b.txt'];
        const out = mergePaths(prev, ['c.txt', 'a.txt'], false);
        expect(out).toEqual(['a.txt', 'b.txt', 'c.txt']);
        expect(prev).toEqual(['a.txt', 'b.txt']);
    });

    it('handles both sides empty', () => {
        expect(mergePaths([], [], false)).toEqual([]);
    });
});
