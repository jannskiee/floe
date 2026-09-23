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
 * Two picks of the same folder, or a folder and then a file inside it, produce
 * the same relative path twice. Keeping the first is the answer that matches
 * what the host does with them: it never overwrites, so a duplicate would arrive
 * as a second numbered copy of a file the visitor picked once. Size is part of
 * the key because two genuinely different files share a path only if one changed
 * on disk between picks, and then the visitor does mean both.
 *
 * It lives here rather than in hooks/useRequestFiles.ts so that
 * mergeSelection.test.ts covers it: client/vitest.config.ts collects lib/ and
 * app/ only.
 */
export function mergeSelection(
    previous: RequestFile[],
    incoming: { file: File; relativePath: string }[]
): RequestFile[] {
    const key = (relativePath: string, size: number) => `${size}\u0000${relativePath}`;
    const seen = new Set(previous.map((f) => key(f.relativePath, f.file.size)));
    const merged = [...previous];

    for (const candidate of incoming) {
        const k = key(candidate.relativePath, candidate.file.size);
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push({ id: uuidv4(), file: candidate.file, relativePath: candidate.relativePath });
    }
    return merged;
}
