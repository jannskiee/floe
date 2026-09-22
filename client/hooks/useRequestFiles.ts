import { useCallback, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { walkEntries, type EntryLike, type WalkedFile } from '@/lib/request/folderWalk';
import { checkPick } from '@/lib/request/metadataBudget';
import { MAX_REQUEST_FILES } from '@/lib/request/constants';
import { visitorCopy } from '@/lib/request/visitorCopy';

export interface RequestFile {
    id: string;
    file: File;
    /** What goes on the wire as `fileName`. The host treats it as untrusted and
     *  sanitizes every component before it creates anything. */
    relativePath: string;
}

/**
 * The visitor's file selection.
 *
 * Deliberately NOT useFileManagement. That hook belongs to "/" and reads only
 * `dataTransfer.files`, which is top-level files and, on Chrome, a directory
 * pseudo-File that blows up mid-batch when the sender tries to read it. Teaching
 * it folders would put a second set of rules into the one place both pages
 * depend on, for a page that also needs relative paths, a file cap and a
 * frame-size check that "/" has no use for. So this is a separate hook and
 * useFileManagement is untouched.
 *
 * Everything with a rule in it lives in lib/request/ with a test beside it (the
 * walk, the byte budget, the constants, the copy); what is left here is React
 * state and the one thing that cannot move, which is the drop handler's
 * synchronous read of the item list.
 */
export function useRequestFiles() {
    const [files, setFiles] = useState<RequestFile[]>([]);
    const [isDragging, setIsDragging] = useState(false);
    /** A refusal, in the approved copy, or null. Never a place for free text: no
     *  path, no name and no error string from the machine reaches it. */
    const [notice, setNotice] = useState<string | null>(null);
    /** Folders the last accepted pick skipped, for the quiet C-35 line. */
    const [emptyFolders, setEmptyFolders] = useState(0);

    // The selection as the LAST commit left it. A pick finishes after an await,
    // by which time the closure's `files` can be a render behind, and the check
    // below has to run against what is really selected.
    const selected = useRef<RequestFile[]>([]);

    const totalBytes = files.reduce((sum, f) => sum + f.file.size, 0);

    /** Add files to the selection, or refuse the whole pick.
     *
     *  The check runs over the MERGED selection, not over what is being added:
     *  `total` and `totalBytes` are inputs to every file's frame size, so a pick
     *  that is fine on its own can push an earlier file over the cap. A refusal
     *  leaves the selection exactly as it was. */
    const commit = useCallback((incoming: WalkedFile[], skippedFolders: number) => {
        const merged = mergeSelection(selected.current, incoming);
        const verdict = checkPick(merged);
        if (!verdict.ok) {
            setNotice(
                verdict.cause === 'too-many' ? visitorCopy.tooManyFiles : visitorCopy.pathTooLong
            );
            return;
        }
        selected.current = merged;
        setFiles(merged);
        setNotice(null);
        setEmptyFolders(skippedFolders);
    }, []);

    const ingestEntries = useCallback(
        async (entries: EntryLike[]) => {
            const walked = await walkEntries(entries, { maxFiles: MAX_REQUEST_FILES });
            if (walked.outcome === 'too-many') {
                setNotice(visitorCopy.tooManyFiles);
                return;
            }
            if (walked.outcome === 'unreadable') {
                setNotice(visitorCopy.folderUnreadable);
                return;
            }
            commit(walked.files, walked.emptyFolders);
        },
        [commit]
    );

    /** The fallback path, for a browser with no entries API.
     *
     *  A dropped folder can arrive in `.files` as a pseudo-File (Chrome gives it
     *  type '' and size 4096, Firefox size 0) whose read fails later, which is
     *  how a whole batch used to die halfway through a send. Reading the first
     *  byte now is what tells a real file from one of those, and a folder on
     *  this path means the browser cannot take folders at all, which is what
     *  C-30 says. */
    const ingestPlainFiles = useCallback(
        async (list: File[]) => {
            // The same stop the walk has, for the same reason. Without it a
            // drop of 200,000 files would run 200,000 sequential reads before
            // checkPick ever got to refuse on count, and the tab would sit
            // there doing it. Refuse on count first, then do per-file work.
            if (list.length > MAX_REQUEST_FILES) {
                setNotice(visitorCopy.tooManyFiles);
                return;
            }
            for (const file of list) {
                if (!(await firstByteReadable(file))) {
                    setNotice(visitorCopy.foldersUnsupported);
                    return;
                }
            }
            commit(
                list.map((file) => ({ file, relativePath: file.name })),
                0
            );
        },
        [commit]
    );

    const handleDragOver = (e: DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const handleDragLeave = (e: DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
    };

    const handleDrop = (e: DragEvent) => {
        e.preventDefault();
        setIsDragging(false);

        // Synchronous, and it has to stay that way. A DataTransferItemList is
        // only usable while the drop event is being dispatched: read it after
        // the first await and it is empty, which looks exactly like a drop of
        // nothing. Both lists are copied out here, and only then does any
        // asynchronous work start.
        const entries: EntryLike[] = [];
        const items = e.dataTransfer.items;
        for (let i = 0; i < (items?.length ?? 0); i++) {
            const item = items[i];
            if (item.kind !== 'file') continue;
            const entry =
                typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
            if (entry) entries.push(entry as unknown as EntryLike);
        }
        const plain = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];

        if (entries.length > 0) {
            void ingestEntries(entries);
            return;
        }
        if (plain.length > 0) void ingestPlainFiles(plain);
    };

    /** Choose files: a flat pick, so the relative path is the file's own name. */
    const handleFileSelection = (e: ChangeEvent<HTMLInputElement>) => {
        const picked = e.target.files ? Array.from(e.target.files) : [];
        // Reset first, so picking the same file again still fires onChange.
        e.target.value = '';
        if (picked.length === 0) return;
        commit(
            picked.map((file) => ({ file, relativePath: file.name })),
            0
        );
    };

    /** Choose folder: the browser supplies the path inside the chosen folder.
     *  `webkitRelativePath` is empty on a browser that accepts the attribute and
     *  ignores it, and the name is the only honest fallback there. */
    const handleFolderSelection = (e: ChangeEvent<HTMLInputElement>) => {
        const picked = e.target.files ? Array.from(e.target.files) : [];
        e.target.value = '';
        if (picked.length === 0) return;
        commit(
            picked.map((file) => ({ file, relativePath: file.webkitRelativePath || file.name })),
            0
        );
    };

    const handleDeleteFile = (fileId: string) => {
        selected.current = selected.current.filter((f) => f.id !== fileId);
        setFiles(selected.current);
        setNotice(null);
    };

    const clear = () => {
        selected.current = [];
        setFiles([]);
        setNotice(null);
        setEmptyFolders(0);
    };

    return {
        files,
        isDragging,
        notice,
        emptyFolders,
        totalBytes,
        handleDragOver,
        handleDragLeave,
        handleDrop,
        handleFileSelection,
        handleFolderSelection,
        handleDeleteFile,
        clear,
    };
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
 * Exported for the view and for a future test: client/vitest.config.ts collects
 * lib/ and app/ only, so nothing under hooks/ is covered today.
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

/** True when the first byte of this File can actually be read. A directory
 *  pseudo-File cannot, which is the only reliable way to tell one apart before
 *  a send begins. */
async function firstByteReadable(file: File): Promise<boolean> {
    try {
        await file.slice(0, 1).arrayBuffer();
        return true;
    } catch {
        return false;
    }
}
