import { useState, type ChangeEvent, type DragEvent } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { FOLDER_DROP_REFUSED, allReadable, dropHasFolder } from '@/lib/pageGuards';

export interface FileWithId {
    id: string;
    file: File;
}

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
    // Why the last drop was refused, until the selection next changes.
    const [dropNotice, setDropNotice] = useState<string | null>(null);

    const totalBytes = files.reduce((sum, f) => sum + f.file.size, 0);

    const addFiles = (incoming: FileList | File[]) => {
        const mapped = Array.from(incoming).map((file) => ({
            id: uuidv4(),
            file,
        }));
        setDropNotice(null);
        setFiles((prev) => [...prev, ...mapped]);
    };

    const handleFileSelection = (e: ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files.length > 0) {
            addFiles(e.target.files);
            // Reset so picking the same file again still fires onChange.
            e.target.value = '';
        }
    };

    const handleDeleteFile = (fileId: string) => {
        setDropNotice(null);
        setFiles((prev) => prev.filter((f) => f.id !== fileId));
    };

    const handleDragOver = (e: DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const handleDragLeave = (e: DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
    };

    // A drop with a folder in it is refused whole, so nothing of it is half
    // added (lib/pageGuards.ts). The item list is read here, synchronously:
    // it is empty once the event is over. Without the entries API the files
    // are read instead, which is slower and only that browser pays for it.
    const handleDrop = (e: DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        const dropped = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
        if (dropped.length === 0) return;
        const folder = dropHasFolder(e.dataTransfer.items);
        if (folder === true) {
            setDropNotice(FOLDER_DROP_REFUSED);
            return;
        }
        if (folder === false) {
            addFiles(dropped);
            return;
        }
        void allReadable(dropped).then((readable) => {
            if (readable) addFiles(dropped);
            else setDropNotice(FOLDER_DROP_REFUSED);
        });
    };

    return {
        files,
        isDragging,
        dropNotice,
        totalBytes,
        handleFileSelection,
        handleDeleteFile,
        handleDragOver,
        handleDragLeave,
        handleDrop,
    };
}
