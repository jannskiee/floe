import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { mergeFiles, type FileWithId } from '@/lib/fileSelection';
import {
    DROP_EMPTY_FOLDERS_SKIPPED,
    DROP_FOLDER_UNREADABLE,
    DROP_PATH_TOO_LONG,
    DROP_TOO_MANY_FILES,
    MAIN_PAGE_MAX_DROP_FILES,
    dropEntries,
    selectionFitsFrames,
} from '@/lib/folderDrop';
import { walkEntries, type EntryLike, type WalkedFile } from '@/lib/request/folderWalk';
import { createPickTracker } from '@/lib/request/pickTracker';
import { FOLDER_DROP_REFUSED, allReadable } from '@/lib/pageGuards';

export type { FileWithId } from '@/lib/fileSelection';

/**
 * Owns the sender's file-selection state: the chosen files, drag-and-drop
 * highlighting, and the running byte total. Pure UI state with no dependency on
 * the signaling or WebRTC layer, so it can be tested and reasoned about on its
 * own. (Which file is *currently sending* is transfer progress, not selection,
 * so it stays with the transfer logic.)
 */
export function useFileManagement() {
    const [files, setFiles] = useState<FileWithId[]>([]);
    const [isDragging, setIsDragging] = useState(false);
    // Why the last drop was refused, until the next add or removal.
    const [dropNotice, setDropNotice] = useState<string | null>(null);
    // True while a dropped folder is walked or a drop is probed, so Create
    // cannot start a send of half a folder.
    const [reading, setReading] = useState(false);
    const [tracker] = useState(createPickTracker);
    // The selection as the last commit left it. A walk finishes after an await,
    // so the frame check has to run against what is really selected.
    const selected = useRef<FileWithId[]>([]);

    const totalBytes = files.reduce((sum, f) => sum + f.file.size, 0);

    // Adds files to the selection, or nothing when one of the whole selection
    // would no longer fit in a control frame (lib/folderDrop.ts).
    const commit = (incoming: readonly (File | WalkedFile)[], emptyFolders = 0) => {
        const merged = mergeFiles(selected.current, incoming);
        if (!selectionFitsFrames(merged)) {
            setDropNotice(DROP_PATH_TOO_LONG);
            return;
        }
        selected.current = merged;
        setFiles(merged);
        setDropNotice(emptyFolders > 0 ? DROP_EMPTY_FOLDERS_SKIPPED : null);
    };

    // Read the list now: handleFileSelection resets the input as soon as this
    // returns.
    const addFiles = (incoming: FileList | File[]) => commit(Array.from(incoming));

    const whileReading = async (read: () => Promise<void>) => {
        tracker.begin();
        setReading(true);
        try {
            await read();
        } finally {
            tracker.end();
            setReading(tracker.reading());
        }
    };

    const addEntries = (entries: EntryLike[]) =>
        whileReading(async () => {
            const walked = await walkEntries(entries, { maxFiles: MAIN_PAGE_MAX_DROP_FILES });
            if (walked.outcome === 'too-many') setDropNotice(DROP_TOO_MANY_FILES);
            else if (walked.outcome === 'unreadable') setDropNotice(DROP_FOLDER_UNREADABLE);
            else commit(walked.files, walked.emptyFolders);
        });

    const handleFileSelection = (e: ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            addFiles(e.target.files);
            // Reset so picking the same file again still fires onChange.
            e.target.value = '';
        }
    };

    const handleDeleteFile = (fileId: string) => {
        setDropNotice(null);
        selected.current = selected.current.filter((f) => f.id !== fileId);
        setFiles(selected.current);
    };

    const handleDragOver = (e: DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const handleDragLeave = (e: DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
    };

    // A drop with a folder in it is walked whole, and added whole or not at
    // all. The item list is read here, synchronously: it is empty once the
    // event is over. Without the entries API a folder cannot be walked, so the
    // files are read instead and a drop with one is refused (lib/pageGuards.ts).
    const handleDrop = (e: DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        const dropped = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
        if (dropped.length === 0) return;
        const entries = dropEntries(e.dataTransfer.items);
        if (entries?.some((entry) => entry.isDirectory)) {
            void addEntries(entries);
            return;
        }
        if (entries) {
            addFiles(dropped);
            return;
        }
        void whileReading(async () => {
            if (await allReadable(dropped)) addFiles(dropped);
            else setDropNotice(FOLDER_DROP_REFUSED);
        });
    };

    return {
        files,
        isDragging,
        dropNotice,
        reading,
        totalBytes,
        handleFileSelection,
        handleDeleteFile,
        handleDragOver,
        handleDragLeave,
        handleDrop,
    };
}
