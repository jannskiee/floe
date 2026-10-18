import {describe, expect, it} from 'vitest';
import {baseName, displayCols, mergePaths, normPath, shortDropFolder, shortPath} from './paths';

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

describe('shortPath', () => {
    const DROP = 'D:\\Footage\\Floe requests\\Acme footage 2026-09-14 1405';

    it('returns a path that fits unchanged', () => {
        expect(shortPath(DROP, DROP.length)).toBe(DROP);
        expect(shortPath('Acme footage 2026-09-14 1405', 40)).toBe('Acme footage 2026-09-14 1405');
        expect(shortPath('', 10)).toBe('');
    });

    it('keeps the drive root and as many last folders as fit', () => {
        expect(shortPath(DROP, 40)).toBe('D:\\...\\Acme footage 2026-09-14 1405');
        expect(shortPath(DROP, 49)).toBe('D:\\...\\Floe requests\\Acme footage 2026-09-14 1405');
        expect(shortPath('\\\\nas\\share\\Floe requests\\Acme footage 2026-09-14 1405', 45)).toBe('\\\\nas\\share\\...\\Acme footage 2026-09-14 1405');
        expect(shortPath('/home/a/Floe requests/Acme footage 2026-09-14 1405', 40)).toBe('/.../Acme footage 2026-09-14 1405');
    });

    it('cuts the middle of a name too long for the row, keeping its distinctive end', () => {
        const name = `${'A'.repeat(64)} 2026-09-14 1405`;
        const short = shortPath(name, 34);
        expect(short).toHaveLength(34);
        expect(short.startsWith('AAAAAAAAAAAAAAA...')).toBe(true);
        expect(short.endsWith(' 2026-09-14 1405')).toBe(true);
        // In a path whose last folder alone is too long: the root and the end.
        const deep = shortPath(`D:\\Footage\\Floe requests\\${name}`, 46);
        expect(deep).toHaveLength(46);
        expect(deep.startsWith('D:\\Footage')).toBe(true);
        expect(deep.endsWith(' 2026-09-14 1405')).toBe(true);
    });

    it('is never longer than asked, whatever the path', () => {
        const paths = [DROP, `D:\\${'x'.repeat(200)}`, 'x'.repeat(300), '\\\\a\\b\\c', '/a/b/c/d/e/f/g/h', 'C:\\a\\\\b\\c.txt'];
        for (const p of paths) {
            for (let max = 5; max <= 60; max++) expect(shortPath(p, max).length, `${p} at ${max}`).toBeLessThanOrEqual(max);
        }
    });
});

describe('displayCols (R5-11)', () => {
    it('counts East Asian Wide, Fullwidth and emoji as two, marks and joiners as none', () => {
        expect(displayCols('Acme 2026')).toBe(9);
        expect(displayCols('日本語')).toBe(6);
        expect(displayCols('한국')).toBe(4);
        expect(displayCols('ＡＢ')).toBe(4); // fullwidth A and B
        expect(displayCols('📁🎬')).toBe(4);
        expect(displayCols('é')).toBe(1); // e and a combining acute
        expect(displayCols('❤')).toBe(1); // a text-style heart
        expect(displayCols('❤️')).toBe(2); // the same heart asked for as emoji
        expect(displayCols('a\u200Db')).toBe(2);
        expect(displayCols('')).toBe(0);
        // A keycap is drawn as an emoji: two, never the one cell of its digit.
        expect(displayCols('1️⃣')).toBe(2);
        expect(displayCols('#️⃣*️⃣')).toBe(4);
    });
});

describe('shortDropFolder (R5-11)', () => {
    // Half a surrogate pair, which a cut by UTF-16 units can leave.
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    it('returns a name that fits unchanged', () => {
        expect(shortDropFolder('Acme footage 2026-09-14 1405', 32)).toBe('Acme footage 2026-09-14 1405');
        expect(shortDropFolder('日本語 2026-10-08 1405 (2)', 32)).toBe('日本語 2026-10-08 1405 (2)');
    });

    it('keeps " (2)" with the date and time, and cuts only the label', () => {
        expect(shortDropFolder('Acme footage for the October shoot 2026-10-08 1405 (2)', 32)).toBe('Acme ...hoot 2026-10-08 1405 (2)');
        expect(shortDropFolder(`${'A'.repeat(64)} 2026-09-14 1405`, 32)).toBe('AAAAAAA...AAAAAA 2026-09-14 1405');
    });

    it('cuts a CJK label by display columns', () => {
        const s = shortDropFolder('日本語のフォルダ名がとても長いです 2026-10-08 1405', 32);
        expect(s).toBe('日本語...いです 2026-10-08 1405');
        expect(displayCols(s)).toBeLessThanOrEqual(32);
    });

    it('cuts an emoji label by whole characters, never half a surrogate pair', () => {
        const s = shortDropFolder('📁🎬📷🎵📁🎬📷🎵📁🎬📷🎵 2026-10-08 1405', 32);
        expect(s).toBe('📁🎬📷...🎬📷🎵 2026-10-08 1405');
        expect(loneSurrogate.test(s)).toBe(false);
    });

    it('never starts the kept end of a label with a mark cut off from its letter', () => {
        const s = shortDropFolder(`${'á'.repeat(30)} 2026-10-08 1405`, 32);
        const end = s.slice(s.indexOf('...') + 3);
        expect(end.startsWith('a')).toBe(true);
        expect(displayCols(s)).toBeLessThanOrEqual(32);
    });

    it('keeps every flag, emoji sequence, skin tone, keycap and marked letter whole', () => {
        const seg = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
        const clusters = (s: string) => Array.from(seg.segment(s), (g) => g.segment);
        const leaf = ' 2026-10-08 1405';
        for (const label of [
            '🇯🇵🇺🇸🇫🇷🇩🇪🇮🇹🇪🇸🇬🇧🇨🇦🇧🇷🇲🇽', // flags: two regional indicators each
            '👨\u200D👩\u200D👧👨\u200D👩\u200D👧👨\u200D👩\u200D👧👨\u200D👩\u200D👧', // family sequences joined by U+200D
            '👍🏽'.repeat(10), // a skin tone modifier after its hand
            '1️⃣2️⃣3️⃣'.repeat(5), // keycaps
            'Café résumé déjà vu encore', // letters with combining accents
            '한글'.repeat(6), // Hangul in conjoining jamo
        ]) {
            const s = shortDropFolder(`${label}${leaf}`, 32);
            expect(s.endsWith(leaf), s).toBe(true);
            expect(displayCols(s), s).toBeLessThanOrEqual(32);
            const cut = s.slice(0, s.length - leaf.length);
            const at = cut.indexOf('...');
            expect(at, s).toBeGreaterThan(0);
            const whole = clusters(label);
            const head = clusters(cut.slice(0, at));
            const tail = clusters(cut.slice(at + 3));
            expect(head, s).toEqual(whole.slice(0, head.length));
            expect(tail, s).toEqual(whole.slice(whole.length - tail.length));
        }
    });

    it('cuts a name with no date and time in its middle', () => {
        expect(shortDropFolder('x'.repeat(50), 32)).toBe(`${'x'.repeat(15)}...${'x'.repeat(14)}`);
    });

    it('never passes the column budget, and keeps the whole ending whenever a label fits beside it', () => {
        const labels = ['Acme footage', '日本語のフォルダ名', '📁🎬📷🎵📁🎬', '👨\u200D👩\u200D👧 family', 'Ｆｕｌｌｗｉｄｔｈ', 'x'.repeat(200), '漢'.repeat(120)];
        for (const label of labels) {
            for (const leaf of [' 2026-10-08 1405', ' 2026-10-08 1405 (2)', ' 2026-10-08 1405 (99)']) {
                for (let max = 22; max <= 60; max++) {
                    const s = shortDropFolder(`${label}${leaf}`, max);
                    expect(displayCols(s), `${label}${leaf} at ${max}`).toBeLessThanOrEqual(max);
                    expect(loneSurrogate.test(s), `${label}${leaf} at ${max}`).toBe(false);
                    if (max - displayCols(leaf) >= 5) expect(s.endsWith(leaf), `${label}${leaf} at ${max}`).toBe(true);
                }
            }
        }
    });
});
