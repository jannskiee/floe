// Walking a dropped folder into a flat list of files with relative paths.
//
// Pure over injected interfaces, because client/vitest.config.ts runs with
// environment: 'node' and there is no FileSystemEntry there. The caller hands in
// whatever `DataTransferItem.webkitGetAsEntry()` returned; this module never
// touches a global.
//
// Two facts drive the shape of the loop below.
//
// 1. `FileSystemDirectoryReader.readEntries` is not "read the directory". It
//    returns a BATCH, at most 100 entries in Chromium, and the only way to know
//    a directory is exhausted is to call it again until it hands back an empty
//    array. A single call looks correct on every folder a developer tests with
//    and silently truncates the first folder of 101 a visitor drops.
// 2. The walk has to be able to stop. A visitor can drop a home directory, and
//    walking it to the end to then refuse the pick would freeze the page for as
//    long as the drive takes. So the count is checked between every entry and
//    the walk returns the moment it has one more file than the cap allows,
//    which is exactly the evidence needed to say "over the cap" and nothing
//    more.

/** The slice of `FileSystemEntry` this module uses. Structural on purpose: a
 *  test passes plain objects, and the real DOM entries satisfy it as they are. */
export interface EntryLike {
    isFile: boolean;
    isDirectory: boolean;
    /** The path inside the dropped tree, with a leading slash: `/shoot/a.mov`. */
    fullPath: string;
    name: string;
    file(ok: (file: File) => void, err?: (error: unknown) => void): void;
    createReader(): {
        readEntries(ok: (entries: EntryLike[]) => void, err?: (error: unknown) => void): void;
    };
}

export interface WalkedFile {
    file: File;
    /** `fullPath` without its leading slash. This is what goes on the wire as
     *  `fileName`, and the host treats it as untrusted: it sanitizes every
     *  component and checks depth and length before creating anything. */
    relativePath: string;
}

export interface WalkResult {
    /** On `ok`, the selection. On `too-many`, exactly `maxFiles + 1` entries,
     *  which is the proof the walk stopped rather than a usable pick. On
     *  `unreadable`, empty: a partial folder is not a thing the visitor asked
     *  to send. */
    files: WalkedFile[];
    /** Directories whose own `readEntries` returned nothing. They are not
     *  delivered, and the page says so (C-35). A directory holding only empty
     *  directories is not itself empty and is not counted. */
    emptyFolders: number;
    outcome: 'ok' | 'too-many' | 'unreadable';
}

function readEntriesOnce(
    reader: ReturnType<EntryLike['createReader']>
): Promise<EntryLike[]> {
    return new Promise((resolve, reject) => {
        reader.readEntries(resolve, reject);
    });
}

function readFile(entry: EntryLike): Promise<File> {
    return new Promise((resolve, reject) => {
        entry.file(resolve, reject);
    });
}

function relativePathOf(entry: EntryLike): string {
    // `fullPath` is the documented source. `name` is the fallback for an entry
    // that arrives without one rather than a second supported shape.
    const raw = entry.fullPath || entry.name;
    return raw.startsWith('/') ? raw.slice(1) : raw;
}

export async function walkEntries(
    roots: EntryLike[],
    opts: { maxFiles: number }
): Promise<WalkResult> {
    const files: WalkedFile[] = [];
    // One MORE than the cap: holding maxFiles + 1 files is what proves the
    // selection is over the cap, and it is where the walk stops.
    const stopAt = opts.maxFiles + 1;
    let emptyFolders = 0;

    const walk = async (entry: EntryLike): Promise<void> => {
        if (files.length >= stopAt) return;

        if (entry.isFile) {
            files.push({ file: await readFile(entry), relativePath: relativePathOf(entry) });
            return;
        }
        // Neither a file nor a directory: nothing to do with it. Real entries
        // are always one or the other.
        if (!entry.isDirectory) return;

        const reader = entry.createReader();
        let seen = 0;
        for (;;) {
            const batch = await readEntriesOnce(reader);
            if (batch.length === 0) break;
            seen += batch.length;
            for (const child of batch) {
                await walk(child);
                if (files.length >= stopAt) return;
            }
        }
        if (seen === 0) emptyFolders += 1;
    };

    try {
        for (const root of roots) {
            await walk(root);
            if (files.length >= stopAt) break;
        }
    } catch {
        // A failed readEntries or file() means the tree cannot be read whole.
        // Adding what was reachable would send a folder the visitor believes
        // they sent completely, so nothing is added and the page says so.
        return { files: [], emptyFolders: 0, outcome: 'unreadable' };
    }

    if (files.length >= stopAt) return { files, emptyFolders, outcome: 'too-many' };
    return { files, emptyFolders, outcome: 'ok' };
}
