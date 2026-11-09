import { v4 as uuidv4 } from 'uuid';

export interface RequestFile {
    id: string;
    file: File;
    /** What goes on the wire as `fileName`. The host treats it as untrusted and
     *  sanitizes every component before it creates anything. */
    relativePath: string;
}

/**
 * Merge new files into a selection, keeping the first of any repeat.
 *
 * A file picked again keeps its relative path, size and modified time, so all
 * three key the merge, the main page's rule with the path in place of the
 * name. Two different files can share a path and a size: one name picked from
 * two folders with Choose files, where the path is the bare name, or two
 * folders with one name, such as two scanners' Scans. Keeping both is the
 * answer that matches what the host does with them: it never overwrites, so a
 * second file of the same path arrives as a numbered copy rather than
 * replacing the first. Two different files that match in all three still
 * collapse into one, as the main page accepted (#692).
 *
 * It lives here rather than in hooks/useRequestFiles.ts so that
 * mergeSelection.test.ts covers it: client/vitest.config.ts collects lib/ and
 * app/ only.
 */
export function mergeSelection(
    previous: RequestFile[],
    incoming: { file: File; relativePath: string }[]
): RequestFile[] {
    const key = (relativePath: string, size: number, lastModified: number) =>
        `${relativePath}\u0000${size}\u0000${lastModified}`;
    const seen = new Set(
        previous.map((f) => key(f.relativePath, f.file.size, f.file.lastModified))
    );
    const merged = [...previous];

    for (const candidate of incoming) {
        const k = key(candidate.relativePath, candidate.file.size, candidate.file.lastModified);
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push({ id: uuidv4(), file: candidate.file, relativePath: candidate.relativePath });
    }
    return merged;
}
