import { describe, it, expect } from 'vitest';
import { PATH_TAIL, PATH_TEXT_MAX, isRtl, splitTail } from './pathTail';
import { displayPath } from './visitorCopy';

describe('splitTail', () => {
    it('keeps the file name and extension in the tail', () => {
        const [head, tail] = splitTail('Wedding photos June 2026 full set/DSC_4000.NEF');
        expect(tail).toBe('t/DSC_4000.NEF');
        expect(tail.endsWith('DSC_4000.NEF')).toBe(true);
        expect(head + tail).toBe('Wedding photos June 2026 full set/DSC_4000.NEF');
    });

    it('leaves a short text whole in the tail', () => {
        expect(splitTail('a.txt')).toEqual(['', 'a.txt']);
        expect(splitTail('x'.repeat(PATH_TAIL))).toEqual(['', 'x'.repeat(PATH_TAIL)]);
        expect(splitTail('')).toEqual(['', '']);
    });

    it('keeps a boundary space on its side, so the row reads the same', () => {
        expect(splitTail('Meeting notes from the planning call.txt', 8)).toEqual([
            'Meeting notes from the planning ',
            'call.txt',
        ]);
        expect(splitTail('abc defgh.txt', 9)).toEqual(['abc ', 'defgh.txt']);
    });

    it('never splits an emoji sequence, a flag or an accent', () => {
        const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
        const flag = '\u{1F1EF}\u{1F1F5}';
        const accent = 'é';
        const text = `${'a'.repeat(20)}${family}${flag}${accent}.jpg`;
        // 4 graphemes from the end: '.', 'j', 'p', 'g'; 7 reaches back through
        // the accent, the flag and the family whole.
        const [head, tail] = splitTail(text, 7);
        expect(tail).toBe(`${family}${flag}${accent}.jpg`);
        expect(head).toBe('a'.repeat(20));
        const [, one] = splitTail(text, 5);
        expect(one).toBe(`${accent}.jpg`);
    });

    it('rows ask displayPath for a text whose own "..." sits past any visible head', () => {
        const long = `${'folder/'.repeat(40)}IMG_20261008_143512.jpg`;
        const shown = displayPath(long, PATH_TEXT_MAX);
        expect(Array.from(shown).length).toBeLessThanOrEqual(PATH_TEXT_MAX);
        const [head, tail] = splitTail(shown);
        expect(tail.endsWith('143512.jpg')).toBe(true);
        // The card row shows at most about 58 characters, the tail included.
        expect(head.indexOf('...')).toBeGreaterThan(58 - PATH_TAIL);
    });
});

describe('isRtl', () => {
    it('follows the first strong character, as dir="auto" does', () => {
        expect(isRtl('report.pdf')).toBe(false);
        expect(isRtl('דוח רבעוני.pdf')).toBe(true);
        expect(isRtl('تقرير مجلس.docx')).toBe(true);
        // Digits, spaces and punctuation are not strong.
        expect(isRtl('2026 - تقرير.pdf')).toBe(true);
        expect(isRtl('2026 - report تقرير.pdf')).toBe(false);
        expect(isRtl('Резюме.txt')).toBe(false);
        expect(isRtl('履歴書.txt')).toBe(false);
        expect(isRtl('2026_10_08.jpg')).toBe(false);
        expect(isRtl('')).toBe(false);
    });
});
