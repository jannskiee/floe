import { describe, expect, it } from 'vitest';
import { mergeFiles, selectionPath, type FileWithId } from './fileSelection';

function fileOf(name: string, size: number, lastModified: number): File {
    return new File([new Uint8Array(size)], name, { lastModified });
}

describe('mergeFiles', () => {
    it('adds a new file with an id and preserves its File object', () => {
        const file = fileOf('report.pdf', 3, 1);
        const merged = mergeFiles([], [file]);

        expect(merged).toHaveLength(1);
        expect(merged[0].file).toBe(file);
        expect(merged[0].id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('ignores a repeat across selections, even when it is a new File object', () => {
        const first = mergeFiles([], [fileOf('report.pdf', 3, 1)]);
        const second = mergeFiles(first, [fileOf('report.pdf', 3, 1)]);

        expect(second).toHaveLength(1);
        expect(second[0]).toBe(first[0]);
    });

    it('deduplicates repeated files within a single selection', () => {
        const merged = mergeFiles([], [
            fileOf('a.txt', 3, 1),
            fileOf('a.txt', 3, 1),
            fileOf('b.txt', 2, 2),
            fileOf('b.txt', 2, 2),
        ]);

        expect(merged.map(({ file }) => file.name)).toEqual(['a.txt', 'b.txt']);
    });

    it('keeps files with the same name but different sizes', () => {
        const merged = mergeFiles([], [
            fileOf('report.pdf', 3, 1),
            fileOf('report.pdf', 4, 1),
        ]);

        expect(merged.map(({ file }) => file.size)).toEqual([3, 4]);
    });

    it('keeps files with the same name and size but different modification times', () => {
        const merged = mergeFiles([], [
            fileOf('report.pdf', 3, 1),
            fileOf('report.pdf', 3, 2),
        ]);

        expect(merged.map(({ file }) => file.lastModified)).toEqual([1, 2]);
    });

    it('keeps files with different names even when size and modification time match', () => {
        const merged = mergeFiles([], [
            fileOf('a.txt', 3, 1),
            fileOf('b.txt', 3, 1),
        ]);

        expect(merged.map(({ file }) => file.name)).toEqual(['a.txt', 'b.txt']);
    });

    it('preserves the existing order and appends only new files in incoming order', () => {
        const previous = mergeFiles([], [
            fileOf('a.txt', 1, 1),
            fileOf('b.txt', 2, 2),
        ]);

        const merged = mergeFiles(previous, [
            fileOf('b.txt', 2, 2),
            fileOf('c.txt', 3, 3),
            fileOf('a.txt', 1, 1),
            fileOf('d.txt', 4, 4),
            fileOf('c.txt', 3, 3),
        ]);

        expect(merged.map(({ file }) => file.name)).toEqual([
            'a.txt', 'b.txt', 'c.txt', 'd.txt',
        ]);

        expect(merged[0]).toBe(previous[0]);
        expect(merged[1]).toBe(previous[1]);
    });

    it('does not mutate the previous selection', () => {
        const previous: FileWithId[] = mergeFiles([], [
            fileOf('a.txt', 1, 1),
        ]);
        const snapshot = [...previous];

        const merged = mergeFiles(previous, [fileOf('b.txt', 2, 2)]);

        expect(previous).toEqual(snapshot);
        expect(previous).toHaveLength(1);
        expect(merged).toHaveLength(2);
    });

    it('gives distinct ids to newly added files', () => {
        const merged = mergeFiles([], [
            fileOf('a.txt', 1, 1),
            fileOf('b.txt', 1, 1),
            fileOf('c.txt', 1, 1),
        ]);

        expect(new Set(merged.map(({ id }) => id)).size).toBe(3);
    });

    it('does not confuse metadata combinations that would collide without separators', () => {
        const merged = mergeFiles([], [
            fileOf('a1', 2, 3),
            fileOf('a', 12, 3),
        ]);

        expect(merged).toHaveLength(2);
    });

    it('documents the trade-off: distinct contents with identical metadata collapse', () => {
        const first = new File(['abc'], 'same.txt', { lastModified: 1 });
        const second = new File(['xyz'], 'same.txt', { lastModified: 1 });

        const merged = mergeFiles([], [first, second]);

        expect(merged).toHaveLength(1);
        expect(merged[0].file).toBe(first);
    });

    it('handles empty incoming selections', () => {
        const previous = mergeFiles([], [fileOf('a.txt', 1, 1)]);

        expect(mergeFiles([], [])).toEqual([]);
        expect(mergeFiles(previous, [])).toEqual(previous);
    });
});

describe('mergeFiles with folder paths', () => {
    it('keeps two files of the same name in different folders', () => {
        const merged = mergeFiles([], [
            { file: fileOf('readme.txt', 3, 1), relativePath: 'a/readme.txt' },
            { file: fileOf('readme.txt', 3, 1), relativePath: 'b/readme.txt' },
        ]);

        expect(merged.map((f) => f.relativePath)).toEqual(['a/readme.txt', 'b/readme.txt']);
    });

    it('ignores the same folder dropped twice', () => {
        const first = mergeFiles([], [{ file: fileOf('readme.txt', 3, 1), relativePath: 'a/readme.txt' }]);
        const second = mergeFiles(first, [{ file: fileOf('readme.txt', 3, 1), relativePath: 'a/readme.txt' }]);

        expect(second).toEqual(first);
    });

    it('keeps a file added on its own beside the same file inside a folder', () => {
        const merged = mergeFiles([], [
            fileOf('readme.txt', 3, 1),
            { file: fileOf('readme.txt', 3, 1), relativePath: 'a/readme.txt' },
        ]);

        expect(merged.map((f) => selectionPath(f))).toEqual(['readme.txt', 'a/readme.txt']);
        expect(merged[0].relativePath).toBeUndefined();
    });
});
