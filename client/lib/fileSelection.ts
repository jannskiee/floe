import { v4 as uuidv4 } from 'uuid';

export interface FileWithId {
    id: string;
    file: File;
}

/**
 * Merge new files into the main page's selection, keeping the first of any
 * repeat, with its id and its place.
 *
 * The browser hands over a new File object on every pick, so the object cannot
 * be the key, and the main page has no relative path. A file is known by its
 * name, size and modified time, joined with a NUL, which none of them can hold.
 * Two different files that match in all three collapse into one, as copies made
 * by a tool that keeps the original times can; the page accepts that.
 *
 * It lives here rather than in hooks/useFileManagement.ts so that
 * fileSelection.test.ts covers it: client/vitest.config.ts collects lib/ and
 * app/ only.
 */
export function mergeFiles(
    previous: FileWithId[],
    incoming: File[]
): FileWithId[] {
    const key = (file: File) =>
        `${file.name}\u0000${file.size}\u0000${file.lastModified}`;

    const seen = new Set(previous.map(({ file }) => key(file)));
    const merged = [...previous];

    for (const file of incoming) {
        const fileKey = key(file);

        if (seen.has(fileKey)) continue;

        seen.add(fileKey);
        merged.push({ id: uuidv4(), file });
    }

    return merged;
}
