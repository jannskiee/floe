import { describe, expect, it } from 'vitest';
import {
    DROP_EMPTY_FOLDERS_SKIPPED,
    DROP_FOLDER_UNREADABLE,
    DROP_PATH_TOO_LONG,
    DROP_TOO_MANY_FILES,
    MAIN_PAGE_MAX_DROP_FILES,
    dropEntries,
    selectionFitsFrames,
} from './folderDrop';
import { mergeFiles } from './fileSelection';
import { CONTROL_MSG_MAX } from './transfer/protocol';
import { metadataFrameBytes } from './request/metadataBudget';

function walked(relativePath: string, size = 1) {
    return { file: new File([new Uint8Array(size)], relativePath.split('/').pop()!), relativePath };
}

/** The longest ASCII path whose frame fits a selection of `total` files
 *  totalling `totalBytes`, each part of it `size` bytes. */
function longestFittingPath(size: number, total: number, totalBytes: number): string {
    let path = 'p/';
    while (metadataFrameBytes(path + 'x', size, total, totalBytes) <= CONTROL_MSG_MAX) path += 'x';
    return path;
}

describe('dropEntries', () => {
    const file = { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false, isFile: true, name: 'a' }) };
    const folder = { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true, isFile: false, name: 'b' }) };

    it('hands back every entry the drop has', () => {
        expect(dropEntries([file, folder])?.map((e) => e.name)).toEqual(['a', 'b']);
    });

    it('is null without the entries API', () => {
        expect(dropEntries([{ kind: 'file' }])).toBeNull();
        expect(dropEntries(undefined)).toBeNull();
    });

    it('skips items that are not files, and an entry the browser could not give', () => {
        expect(
            dropEntries([
                { kind: 'string', webkitGetAsEntry: () => ({ isDirectory: true }) },
                { kind: 'file', webkitGetAsEntry: () => null },
                file,
            ])?.map((e) => e.name)
        ).toEqual(['a']);
    });
});

describe('selectionFitsFrames', () => {
    it('measures a file by its path, not its name', () => {
        const fits = longestFittingPath(1, 1, 1);
        expect(selectionFitsFrames(mergeFiles([], [walked(fits)]))).toBe(true);
        expect(selectionFitsFrames(mergeFiles([], [walked(fits + 'x')]))).toBe(false);
    });

    it('refuses a pick that pushes a path added earlier over', () => {
        const earlier = mergeFiles([], [walked(longestFittingPath(1, 1, 1))]);
        expect(selectionFitsFrames(earlier)).toBe(true);

        const later = new File([new Uint8Array(1_000_000)], 'big.bin');
        expect(selectionFitsFrames(mergeFiles(earlier, [later]))).toBe(false);
    });

    it('takes an empty selection', () => {
        expect(selectionFitsFrames([])).toBe(true);
    });
});

describe('main-page drop copy', () => {
    it('pins the words the main page shows', () => {
        expect(DROP_TOO_MANY_FILES).toBe('This drop has more than 10,000 files. Zip them first.');
        expect(DROP_PATH_TOO_LONG).toBe('A file name or folder path is too long to send. Shorten it or zip it first.');
        expect(DROP_FOLDER_UNREADABLE).toBe('Some files in this folder could not be read. Nothing was added.');
        expect(DROP_EMPTY_FOLDERS_SKIPPED).toBe('Empty folders are not sent.');
    });

    it('caps a folder drop at the number its sentence names', () => {
        expect(MAIN_PAGE_MAX_DROP_FILES).toBe(10_000);
        expect(DROP_TOO_MANY_FILES).toContain('10,000');
    });
});
