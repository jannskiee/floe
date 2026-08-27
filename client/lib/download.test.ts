import { describe, it, expect } from 'vitest';
import { zip, unzipSync } from 'fflate';
import {
    buildZipEntries,
    dedupeFileName,
    sanitizeDisplayText,
    sanitizeFileName,
    sanitizeZipEntryName,
} from './download';

describe('dedupeFileName', () => {
    it('returns the original name when unused', () => {
        const used = new Set<string>();
        expect(dedupeFileName('photo.jpg', used)).toBe('photo.jpg');
    });

    it('adds the name to the used set', () => {
        const used = new Set<string>();
        dedupeFileName('doc.pdf', used);
        expect(used.has('doc.pdf')).toBe(true);
    });

    it('appends (1) on first collision with extension', () => {
        const used = new Set(['photo.jpg']);
        expect(dedupeFileName('photo.jpg', used)).toBe('photo (1).jpg');
    });

    it('appends (2) on second collision with extension', () => {
        const used = new Set(['photo.jpg', 'photo (1).jpg']);
        expect(dedupeFileName('photo.jpg', used)).toBe('photo (2).jpg');
    });

    it('handles files with no extension', () => {
        const used = new Set(['README']);
        expect(dedupeFileName('README', used)).toBe('README (1)');
    });

    it('handles multiple collisions in sequence', () => {
        const used = new Set<string>();
        dedupeFileName('file.txt', used); // file.txt
        dedupeFileName('file.txt', used); // file (1).txt
        dedupeFileName('file.txt', used); // file (2).txt
        expect([...used]).toEqual(['file.txt', 'file (1).txt', 'file (2).txt']);
    });

    it('handles dotfiles (name starts with dot)', () => {
        const used = new Set(['.gitignore']);
        // lastIndexOf('.') === 0 → base='', ext='.gitignore' → ' (1).gitignore'
        // Matches the original inline loop behavior in P2PTransfer.tsx
        const result = dedupeFileName('.gitignore', used);
        expect(result).toBe(' (1).gitignore');
    });
});

describe('sanitizeFileName', () => {
    it('keeps an ordinary name byte for byte', () => {
        expect(sanitizeFileName('photo.jpg')).toBe('photo.jpg');
        expect(sanitizeFileName('\u91cd\u8981\u6587\u4ef6.pdf')).toBe('\u91cd\u8981\u6587\u4ef6.pdf');
    });

    it('keeps only the last path segment', () => {
        expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
        expect(sanitizeFileName('a/b/c.txt')).toBe('c.txt');
        expect(sanitizeFileName('C:\\Windows\\System32\\evil.exe')).toBe('evil.exe');
    });

    it('replaces the characters Windows reserves', () => {
        expect(sanitizeFileName('backup:2026-08-19.log')).toBe('backup_2026-08-19.log');
        expect(sanitizeFileName('report<v2>.pdf')).toBe('report_v2_.pdf');
        expect(sanitizeFileName('a"b|c?d*e.txt')).toBe('a_b_c_d_e.txt');
    });

    it('removes control characters and text-direction overrides', () => {
        expect(sanitizeFileName('re\u0000port\r.pdf')).toBe('report.pdf');
        // Renders as "photoexe.png" in a file manager without the override.
        expect(sanitizeFileName('photo\u202egnp.exe')).toBe('photognp.exe');
    });

    it('trims trailing dots and spaces, which Windows drops while resolving', () => {
        expect(sanitizeFileName('evil.exe ')).toBe('evil.exe');
        expect(sanitizeFileName('report.  ')).toBe('report');
    });

    it('renames device names but not names that merely start with one', () => {
        expect(sanitizeFileName('NUL')).toBe('_NUL');
        expect(sanitizeFileName('nul')).toBe('_nul');
        expect(sanitizeFileName('COM1')).toBe('_COM1');
        expect(sanitizeFileName('CONTRACT.pdf')).toBe('CONTRACT.pdf');
        expect(sanitizeFileName('COM10')).toBe('COM10');
    });

    it('caps a very long name, keeping the extension', () => {
        // fflate rejects an entire archive if one entry name is too long, so an
        // uncapped name would deny the ZIP to every other file in the transfer.
        const got = sanitizeFileName('a'.repeat(500) + '.txt');
        expect(got.length).toBeLessThanOrEqual(200);
        expect(got.endsWith('.txt')).toBe(true);
    });

    it('does not split a surrogate pair when capping', () => {
        const got = sanitizeFileName('\u{1F600}'.repeat(300));
        expect(got.length).toBeLessThanOrEqual(200);
        // A lone high surrogate would make the name unrenderable.
        expect(/[\uD800-\uDBFF]$/.test(got)).toBe(false);
    });

    it('falls back when nothing usable is left', () => {
        for (const bad of ['', '..', '.', '   ', '///', '...']) {
            expect(sanitizeFileName(bad)).toBe('received_file');
        }
    });

    it('falls back for a non-string, which the wire format allows', () => {
        for (const bad of [undefined, null, 42, {}, []]) {
            expect(sanitizeFileName(bad)).toBe('received_file');
        }
    });
});

describe('sanitizeZipEntryName', () => {
    it('preserves folder structure from a CLI folder send', () => {
        expect(sanitizeZipEntryName('project/src/main.go')).toBe('project/src/main.go');
    });

    it('drops segments that would escape the archive', () => {
        expect(sanitizeZipEntryName('../../esc.txt')).toBe('esc.txt');
        expect(sanitizeZipEntryName('a/../../b.txt')).toBe('a/b.txt');
        expect(sanitizeZipEntryName('/etc/passwd')).toBe('etc/passwd');
    });

    it('sanitizes every segment, not just the last', () => {
        expect(sanitizeZipEntryName('fol:der/fi*le.txt')).toBe('fol_der/fi_le.txt');
        expect(sanitizeZipEntryName('a\\b.txt')).toBe('a/b.txt');
    });

    it('renames __proto__, which fflate would otherwise swallow', () => {
        expect(sanitizeZipEntryName('__proto__')).toBe('_proto_');
        expect(sanitizeZipEntryName('d/__proto__')).toBe('d/_proto_');
    });

    it('renames every decorated spelling of __proto__ too', () => {
        // The guard has to run AFTER sanitizing. Checking first let a trailing
        // space, a trailing dot or an invisible character rebuild the exact key
        // during sanitizing, and the file vanished from the archive again.
        for (const decorated of [
            '__proto__ ',
            '__proto__.',
            '__proto__\u0000',
            '__prot\u200eo__',
            '__proto__ . ',
        ]) {
            expect(sanitizeZipEntryName(decorated)).toBe('_proto_');
        }
    });

    it('strips the arabic letter mark, the fourth bidi control', () => {
        expect(sanitizeZipEntryName('a\u061cb.txt')).toBe('ab.txt');
        expect(sanitizeFileName('a\u061cb.txt')).toBe('ab.txt');
    });

    it('caps each segment independently, keeping the folders', () => {
        const got = sanitizeZipEntryName('d/' + 'b'.repeat(500) + '.bin');
        const parts = got.split('/');
        expect(parts).toHaveLength(2);
        expect(parts[0]).toBe('d');
        expect(parts[1].length).toBeLessThanOrEqual(200);
        expect(parts[1].endsWith('.bin')).toBe(true);
    });

    it('never emits a leading, trailing or doubled separator', () => {
        for (const bad of ['/a//b/', 'a/./b', 'a/   /b', '//x//']) {
            const got = sanitizeZipEntryName(bad);
            expect(got.startsWith('/')).toBe(false);
            expect(got.endsWith('/')).toBe(false);
            expect(got.includes('//')).toBe(false);
        }
    });
});

describe('sanitizeDisplayText', () => {
    it('removes the text-direction override and control characters', () => {
        expect(sanitizeDisplayText('photo\u202egnp.exe')).toBe('photognp.exe');
        expect(sanitizeDisplayText('\u001b[2Kfake.txt')).toBe('[2Kfake.txt');
        expect(sanitizeDisplayText('a\rb')).toBe('ab');
    });

    it('keeps characters that are only a problem for a file system', () => {
        // Text in a banner is not a file name: the Windows rules do not apply,
        // and right-to-left script needs no control character.
        expect(sanitizeDisplayText('a:b?c.txt')).toBe('a:b?c.txt');
        expect(sanitizeDisplayText('تقرير.pdf')).toBe('تقرير.pdf');
    });

    it('caps a long string with an ellipsis', () => {
        const got = sanitizeDisplayText('x'.repeat(5000));
        expect(got.length).toBe(200);
        expect(got.endsWith('…')).toBe(true);
    });

    it('never splits a surrogate pair', () => {
        const got = sanitizeDisplayText('\u{1F600}'.repeat(300));
        expect(got.length).toBeLessThanOrEqual(200);
        expect(got.endsWith('…')).toBe(true);
        // A lone high surrogate before the ellipsis would be unrenderable.
        expect(/[\uD800-\uDBFF]…$/.test(got)).toBe(false);
    });

    it('keeps a short extension when capping, so a long name cannot hide what it is', () => {
        const got = sanitizeDisplayText('n'.repeat(250) + '.txt');
        expect(got).toBe('n'.repeat(195) + '….txt');
        expect(got.length).toBe(200);
        // The spoof the cap would otherwise introduce: a long stem in front
        // of .exe must still end in .exe on screen.
        expect(sanitizeDisplayText('a'.repeat(251) + '.exe').endsWith('….exe')).toBe(true);
    });

    it('does not treat a long tail or a leading dot as an extension', () => {
        const longTail = sanitizeDisplayText('n'.repeat(250) + '.' + 'e'.repeat(20));
        expect(longTail.length).toBe(200);
        expect(longTail.endsWith('…')).toBe(true);
        const dotfile = sanitizeDisplayText('.' + 'n'.repeat(250));
        expect(dotfile.length).toBe(200);
        expect(dotfile.endsWith('…')).toBe(true);
    });

    it('keeps the extension without splitting a surrogate pair', () => {
        const got = sanitizeDisplayText('\u{1F600}'.repeat(150) + '.png');
        expect(got.endsWith('….png')).toBe(true);
        expect(got.length).toBeLessThanOrEqual(200);
        const beforeEllipsis = got.charCodeAt(got.length - 6);
        expect(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdbff).toBe(false);
    });

    it('honors a custom cap', () => {
        expect(sanitizeDisplayText('abcdefgh', 4)).toBe('abc…');
        expect(sanitizeDisplayText('abcd', 4)).toBe('abcd');
    });

    it('returns an empty string for a non-string, which the wire format allows', () => {
        for (const bad of [undefined, null, 42, {}, []]) {
            expect(sanitizeDisplayText(bad)).toBe('');
        }
    });
});

describe('buildZipEntries', () => {
    const bytes = (n: number) => new Uint8Array(n).fill(7);

    it('uses a null-prototype container', () => {
        expect(Object.getPrototypeOf(buildZipEntries([]))).toBe(null);
    });

    it('keeps a file named __proto__ instead of losing it', () => {
        const out = buildZipEntries([
            { fileName: 'a.txt', bytes: bytes(3) },
            { fileName: '__proto__', bytes: bytes(3) },
        ]);
        expect(Object.keys(out).sort()).toEqual(['_proto_', 'a.txt']);
    });

    it('keeps a file named "__proto__ " with a trailing space', async () => {
        const out = buildZipEntries([
            { fileName: 'other.txt', bytes: bytes(3) },
            { fileName: '__proto__ ', bytes: bytes(3) },
        ]);
        const archive = await new Promise<Uint8Array>((resolve, reject) => {
            zip(out, (err, data) => (err ? reject(err) : resolve(data)));
        });
        // Round-trip rather than key-count: this exact case produced a
        // plausible-looking archive that was quietly missing a file.
        expect(Object.keys(unzipSync(archive)).sort()).toEqual(['_proto_', 'other.txt']);
    });

    it('does not pollute Object.prototype', () => {
        buildZipEntries([{ fileName: '__proto__', bytes: bytes(3) }]);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(Object.keys({}).length).toBe(0);
    });

    it('keeps both files when two names sanitize to the same thing', () => {
        const out = buildZipEntries([
            { fileName: 'a:b.txt', bytes: bytes(1) },
            { fileName: 'a?b.txt', bytes: bytes(2) },
        ]);
        expect(Object.keys(out).sort()).toEqual(['a_b (1).txt', 'a_b.txt']);
    });

    it('de-duplicates the file, never the directory', () => {
        const out = buildZipEntries([
            { fileName: 'dir.v2/README', bytes: bytes(1) },
            { fileName: 'dir.v2/README', bytes: bytes(1) },
        ]);
        expect(Object.keys(out).sort()).toEqual(['dir.v2/README', 'dir.v2/README (1)']);
    });

    it('produces an archive fflate can read back, with no junk entries', async () => {
        const out = buildZipEntries([
            { fileName: 'a.txt', bytes: bytes(5) },
            { fileName: '__proto__', bytes: bytes(5) },
            { fileName: 'f/nested.bin', bytes: bytes(5) },
        ]);
        const archive = await new Promise<Uint8Array>((resolve, reject) => {
            zip(out, (err, data) => (err ? reject(err) : resolve(data)));
        });
        // A bare {} here yields one bogus directory entry per payload byte.
        expect(Object.keys(unzipSync(archive)).sort()).toEqual([
            '_proto_',
            'a.txt',
            'f/nested.bin',
        ]);
    });
});
