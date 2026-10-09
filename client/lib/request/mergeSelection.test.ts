import { describe, it, expect } from 'vitest';
import { mergeSelection, type RequestFile } from './mergeSelection';

// The dedupe rule mergeSelection argues from the host's behavior: the host
// never overwrites, so a repeated relative path of the same size would arrive
// as a second numbered copy of one file. It lived in hooks/, which the vitest
// globs do not collect, until the S1-WEB-02 review asked for it to move here.

function fileOf(size: number, name = 'f.bin'): File {
    return new File([new Uint8Array(size)], name);
}

function pick(relativePath: string, size: number) {
    return { file: fileOf(size), relativePath };
}

describe('mergeSelection', () => {
    it('keeps the first of a repeated relative path and size', () => {
        const first = mergeSelection([], [pick('shoot/a.mov', 10)]);
        const again = mergeSelection(first, [pick('shoot/a.mov', 10), pick('shoot/b.mov', 5)]);
        expect(again.map((f) => f.relativePath)).toEqual(['shoot/a.mov', 'shoot/b.mov']);
        // The survivor is the ORIGINAL entry, id and File object both.
        expect(again[0]).toBe(first[0]);
    });

    it('keeps both files when the same path arrives with a different size', () => {
        const merged = mergeSelection([], [pick('a.txt', 1), pick('a.txt', 2)]);
        expect(merged.map((f) => f.file.size)).toEqual([1, 2]);
    });

    it('dedupes inside one pick as well as across picks', () => {
        const merged = mergeSelection([], [pick('x', 3), pick('x', 3), pick('x', 3)]);
        expect(merged).toHaveLength(1);
    });

    it('never mutates the previous selection', () => {
        const previous: RequestFile[] = mergeSelection([], [pick('a', 1)]);
        const snapshot = [...previous];
        mergeSelection(previous, [pick('b', 2)]);
        expect(previous).toEqual(snapshot);
        expect(previous).toHaveLength(1);
    });

    it('gives every new file its own id', () => {
        const merged = mergeSelection([], [pick('a', 1), pick('b', 1), pick('c', 1)]);
        const ids = new Set(merged.map((f) => f.id));
        expect(ids.size).toBe(3);
        for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('does not treat a path and a size that concatenate alike as a repeat', () => {
        // The key separates size and path with a NUL, so "1" + "2x" and
        // "12" + "x" are different keys.
        const merged = mergeSelection([], [pick('2x', 1), pick('x', 12)]);
        expect(merged).toHaveLength(2);
    });
});
