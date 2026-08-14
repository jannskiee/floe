import {describe, expect, it} from 'vitest';
import {histKey} from './history';

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
