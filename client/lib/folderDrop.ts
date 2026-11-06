// A folder dropped on the main page, sent with its structure (#795).
//
// The walk, the frame measure and the pick tracker are the request page's
// (lib/request/), imported as they are. Its words are not: visitorCopy.ts is
// frozen to that page, so the four sentences the main page shares with it are
// copied here.

import { CONTROL_MSG_MAX } from './transfer/protocol';
import { metadataFrameBytes } from './request/metadataBudget';
import type { EntryLike } from './request/folderWalk';
import { selectionPath, type FileWithId } from './fileSelection';

/** A drop that holds a folder is refused whole past this many files, so a
 *  dropped home folder cannot freeze the page. Files added on their own have
 *  no cap. */
export const MAIN_PAGE_MAX_DROP_FILES = 10_000;

/** Fixed copy, shown under the drop area. */
export const DROP_TOO_MANY_FILES = 'This drop has more than 10,000 files. Zip them first.';
export const DROP_PATH_TOO_LONG = 'A file name or folder path is too long to send. Shorten it or zip it first.';
export const DROP_FOLDER_UNREADABLE = 'Some files in this folder could not be read. Nothing was added.';
export const DROP_EMPTY_FOLDERS_SKIPPED = 'Empty folders are not sent.';

interface ItemLike {
    kind: string;
    webkitGetAsEntry?: () => unknown;
}

/**
 * The entries of a drop, or null when the browser hands out none (the caller
 * then reads the files instead). Must run during the drop event: the item list
 * is empty after it.
 */
export function dropEntries(items: ArrayLike<ItemLike> | null | undefined): EntryLike[] | null {
    if (!items) return null;
    const entries: EntryLike[] = [];
    let sawEntryApi = false;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind !== 'file' || typeof item.webkitGetAsEntry !== 'function') continue;
        sawEntryApi = true;
        const entry = item.webkitGetAsEntry() as EntryLike | null;
        if (entry) entries.push(entry);
    }
    return sawEntryApi ? entries : null;
}

/**
 * Whether every file of the whole selection fits in a control frame. Every
 * receiver stops at a frame over CONTROL_MSG_MAX, and `total` and `totalBytes`
 * are in every frame, so a pick can push a file added earlier over. This is
 * checkPick without its count rule. Depth and length are the Go receiver's to
 * refuse: a browser receiver takes deeper paths.
 */
export function selectionFitsFrames(files: readonly FileWithId[]): boolean {
    const total = files.length;
    const totalBytes = files.reduce((sum, f) => sum + f.file.size, 0);
    return files.every(
        (f) => metadataFrameBytes(selectionPath(f), f.file.size, total, totalBytes) <= CONTROL_MSG_MAX
    );
}
