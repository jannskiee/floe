import {describe, expect, it} from 'vitest';
import {histKey, loadHistory, fmtWhen} from './history';

describe('histKey', () => {
    // The whole point of the key: it must not encode list position, so a
    // removal above an expanded row cannot change which row reads as open.
    it('is position-independent and stable for the same entry', () => {
        const h = {at: 1755200000000, names: ['a.txt', 'b.txt'], count: 2};
        expect(histKey(h)).toBe(histKey({...h}));
        expect(histKey(h)).toBe('1755200000000-a.txt-2');
    });
    it('separates same-timestamp entries by name and count', () => {
        const at = 1755200000000;
        expect(histKey({at, names: ['a.txt'], count: 1}))
            .not.toBe(histKey({at, names: ['b.txt'], count: 1}));
        expect(histKey({at, names: ['a.txt'], count: 1}))
            .not.toBe(histKey({at, names: ['a.txt', 'c'], count: 2}));
    });
    it('tolerates entries with no names', () => {
        expect(histKey({at: 5, names: [], count: 0})).toBe('5--0');
    });
});

describe('loadHistory', () => {
    it('parses a stored list', () => {
        const raw = JSON.stringify([{kind: 'send', names: ['a.txt'], count: 1, at: 1}]);
        expect(loadHistory(() => raw)).toHaveLength(1);
    });

    it('returns empty for an absent store', () => {
        expect(loadHistory(() => null)).toEqual([]);
    });

    it('returns empty for corrupt JSON rather than throwing', () => {
        // The caller's persist effect is separately guarded so the unreadable
        // bytes stay on disk; this only has to not break the app.
        expect(loadHistory(() => '{not json')).toEqual([]);
    });

    it('returns empty when the stored value is valid JSON but not a list', () => {
        expect(loadHistory(() => '{"kind":"send"}')).toEqual([]);
        expect(loadHistory(() => '"a string"')).toEqual([]);
        expect(loadHistory(() => 'null')).toEqual([]);
    });
});

describe('fmtWhen', () => {
    // Timestamps are built from LOCAL components on purpose: the hh:mm half of
    // the output is local time, so an epoch or a UTC string would make these
    // assertions pass here and fail in CI's UTC.
    const now = new Date(2026, 6, 20, 12, 0);

    it('names today and yesterday by calendar day, not a 24h window', () => {
        expect(fmtWhen(new Date(2026, 6, 20, 19, 55).getTime(), now)).toBe('Today, 19:55');
        expect(fmtWhen(new Date(2026, 6, 19, 9, 12).getTime(), now)).toBe('Yesterday, 09:12');
        // 23:00 yesterday is 13 hours ago, inside a 24h window, but still
        // "Yesterday" because the comparison is by date.
        expect(fmtWhen(new Date(2026, 6, 19, 23, 0).getTime(), now)).toBe('Yesterday, 23:00');
    });

    it('falls back to a short month and day', () => {
        expect(fmtWhen(new Date(2026, 6, 18, 19, 55).getTime(), now)).toBe('Jul 18, 19:55');
    });

    it('crosses a month boundary correctly', () => {
        const firstOfAugust = new Date(2026, 7, 1, 8, 5);
        expect(fmtWhen(new Date(2026, 6, 31, 22, 30).getTime(), firstOfAugust)).toBe(
            'Yesterday, 22:30'
        );
    });

    it('zero-pads both fields', () => {
        expect(fmtWhen(new Date(2026, 6, 20, 5, 7).getTime(), now)).toBe('Today, 05:07');
    });
});
