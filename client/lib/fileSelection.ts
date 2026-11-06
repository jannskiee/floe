import { v4 as uuidv4 } from 'uuid';
import type { WalkedFile } from './request/folderWalk';

export interface FileWithId {
    id: string;
    file: File;
    /** The file's path inside a dropped folder, such as `photos/day1/a.jpg`.
     *  Absent for a file added on its own. */
    relativePath?: string;
}

/** What the page shows and sends for a file: its path inside a dropped
 *  folder, else its own name. */
export function selectionPath(item: { file: File; relativePath?: string }): string {
    return item.relativePath ?? item.file.name;
}

/**
 * Merge new files into the main page's selection, keeping the first of any
 * repeat, with its id and its place.
 *
 * The browser hands over a new File object on every pick, so the object cannot
 * be the key. A file is known by its path inside a dropped folder, or its name
 * when it has none, with its size and modified time, joined with a NUL, which
 * none of them can hold. So `a/readme.txt` and `b/readme.txt` are both kept.
 * Two different files that match in all three collapse into one, as copies made
 * by a tool that keeps the original times can; the page accepts that.
 *
 * It lives here rather than in hooks/useFileManagement.ts so that
 * fileSelection.test.ts covers it: client/vitest.config.ts collects lib/ and
 * app/ only.
 */
export function mergeFiles(
    previous: FileWithId[],
    incoming: readonly (File | WalkedFile)[]
): FileWithId[] {
    const key = (item: { file: File; relativePath?: string }) =>
        `${selectionPath(item)}\u0000${item.file.size}\u0000${item.file.lastModified}`;

    const seen = new Set(previous.map(key));
    const merged = [...previous];

    for (const candidate of incoming) {
        const item = candidate instanceof File ? { file: candidate } : candidate;
        const fileKey = key(item);

        if (seen.has(fileKey)) continue;

        seen.add(fileKey);
        merged.push({ id: uuidv4(), ...item });
    }

    return merged;
}
