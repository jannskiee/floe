import { describe, it, expect } from 'vitest';
import { walkEntries, type EntryLike } from './folderWalk';
import { MAX_REQUEST_FILES } from './constants';

// Fake FileSystemEntry trees. The real ones only exist in a browser during a
// drop event, and client/vitest.config.ts runs with environment: 'node', so the
// module takes them as an interface and these build them by hand.
//
// `readEntries` here behaves like Chromium's: it hands back a BATCH and has to
// be called again until it returns an empty array. `batchSize` is what lets a
// test choose where those batch boundaries fall.

function fileEntry(fullPath: string, size = 0): EntryLike {
    const name = fullPath.slice(fullPath.lastIndexOf('/') + 1);
    return {
        isFile: true,
        isDirectory: false,
        fullPath,
        name,
        file: (ok) => ok(new File(size > 0 ? [new Uint8Array(size)] : [], name)),
        createReader: () => {
            throw new Error('not a directory');
        },
    };
}

function dirEntry(fullPath: string, children: EntryLike[], batchSize = 100): EntryLike {
    const name = fullPath.slice(fullPath.lastIndexOf('/') + 1);
    return {
        isFile: false,
        isDirectory: true,
        fullPath,
        name,
        file: () => {
            throw new Error('not a file');
        },
        createReader: () => {
            let cursor = 0;
            return {
                readEntries: (ok) => {
                    const batch = children.slice(cursor, cursor + batchSize);
                    cursor += batch.length;
                    ok(batch);
                },
            };
        },
    };
}

/** A directory whose reader fails on its first call. */
function unreadableDir(fullPath: string): EntryLike {
    return {
        ...dirEntry(fullPath, []),
        createReader: () => ({
            readEntries: (_ok, err) => {
                (err ?? (() => {}))(new Error('NotReadableError'));
            },
        }),
    };
}

const CAP = { maxFiles: MAX_REQUEST_FILES };

describe('walkEntries', () => {
    it('drains readEntries batches of 100, 100, 37 then empty', async () => {
        // The regression this exists for: one readEntries call looks correct on
        // every folder small enough to test by hand and silently truncates the
        // first folder of 101 a visitor drops.
        const children = Array.from({ length: 237 }, (_, i) => fileEntry(`/shoot/f${i}.mov`));
        const reads: number[] = [];
        const root = dirEntry('/shoot', children);
        const realCreateReader = root.createReader;
        root.createReader = () => {
            const reader = realCreateReader();
            return {
                readEntries: (ok, err) =>
                    reader.readEntries((batch) => {
                        reads.push(batch.length);
                        ok(batch);
                    }, err),
            };
        };

        const result = await walkEntries([root], CAP);

        expect(result.outcome).toBe('ok');
        expect(result.files).toHaveLength(237);
        // Four calls: three that return entries and the empty one that ends it.
        expect(reads).toEqual([100, 100, 37, 0]);
    });

    it('drains 150 entries in one directory', async () => {
        const children = Array.from({ length: 150 }, (_, i) => fileEntry(`/a/f${i}.txt`));
        const result = await walkEntries([dirEntry('/a', children)], CAP);

        expect(result.outcome).toBe('ok');
        expect(result.files).toHaveLength(150);
        expect(result.files[149].relativePath).toBe('a/f149.txt');
    });

    it('walks a 33-deep chain without refusing', async () => {
        // The page does not enforce depth. The host does, because only the host
        // knows the Save-to folder the relative path will be joined onto.
        const dirs = Array.from({ length: 33 }, (_, i) => `d${i}`);
        const leafPath = `/${dirs.join('/')}/leaf.txt`;
        let node: EntryLike = fileEntry(leafPath);
        for (let i = dirs.length - 1; i >= 0; i--) {
            node = dirEntry(`/${dirs.slice(0, i + 1).join('/')}`, [node]);
        }

        const result = await walkEntries([node], CAP);

        expect(result.outcome).toBe('ok');
        expect(result.files).toHaveLength(1);
        expect(result.files[0].relativePath).toBe(`${dirs.join('/')}/leaf.txt`);
    });

    it('skips and counts empty folders', async () => {
        const root = dirEntry('/shoot', [
            fileEntry('/shoot/a.mov'),
            dirEntry('/shoot/empty-one', []),
            dirEntry('/shoot/empty-two', []),
            // A folder holding only an empty folder is not itself empty: its
            // own readEntries returned something.
            dirEntry('/shoot/holds-one', [dirEntry('/shoot/holds-one/empty-three', [])]),
        ]);

        const result = await walkEntries([root], CAP);

        expect(result.outcome).toBe('ok');
        expect(result.files).toHaveLength(1);
        expect(result.emptyFolders).toBe(3);
    });

    it('builds relativePath from fullPath without the leading slash', async () => {
        const result = await walkEntries(
            [
                dirEntry('/shoot', [
                    fileEntry('/shoot/A004/C001.mov'),
                    fileEntry('/shoot/notes.txt'),
                ]),
            ],
            CAP
        );

        expect(result.files.map((f) => f.relativePath)).toEqual([
            'shoot/A004/C001.mov',
            'shoot/notes.txt',
        ]);
    });

    it('an unreadable entry adds nothing', async () => {
        // A partial folder is not what the visitor asked to send, so a failure
        // anywhere in the tree discards the whole walk rather than sending the
        // reachable part.
        const root = dirEntry('/shoot', [
            fileEntry('/shoot/a.mov'),
            unreadableDir('/shoot/locked'),
            fileEntry('/shoot/b.mov'),
        ]);

        const result = await walkEntries([root], CAP);

        expect(result.outcome).toBe('unreadable');
        expect(result.files).toEqual([]);
        expect(result.emptyFolders).toBe(0);
    });

    it('stops at 10,001 files with too-many', async () => {
        // Reading is counted, not just the result: a walk that collected the
        // whole tree and then compared lengths would freeze the page on a
        // dropped home directory.
        let produced = 0;
        const endless: EntryLike = {
            isFile: false,
            isDirectory: true,
            fullPath: '/huge',
            name: 'huge',
            file: () => {
                throw new Error('not a file');
            },
            createReader: () => ({
                readEntries: (ok) => {
                    const batch = Array.from({ length: 100 }, () =>
                        fileEntry(`/huge/f${produced++}.bin`)
                    );
                    ok(batch);
                },
            }),
        };

        const result = await walkEntries([endless], { maxFiles: MAX_REQUEST_FILES });

        expect(result.outcome).toBe('too-many');
        expect(result.files).toHaveLength(MAX_REQUEST_FILES + 1);
        // It stopped inside the batch that crossed the line, not after some
        // later one: the reader never got past the batch holding file 10,000.
        expect(produced).toBeLessThanOrEqual(MAX_REQUEST_FILES + 100);
    });
});
