import { memo, useCallback, useEffect, useRef, type RefObject } from 'react';
import { CheckCircle2, Loader2, X } from 'lucide-react';
import { FileIcon } from '@/components/FileIcon';
import { formatBytes } from '@/lib/utils';
import { fileListScrolls } from '@/lib/fileListScroll';
import { sendRowMark, type SendEnd, type SendRowMark } from '@/lib/sendSummary';
import type { FileWithId } from '@/hooks/useFileManagement';

interface SelectedFilesListProps {
    files: FileWithId[];
    currentFileIndex: number;
    progress: number;
    filesLocked: boolean;
    sendEnd: SendEnd;
    onDeleteFile: (id: string) => void;
    listRef: RefObject<HTMLDivElement | null>;
}

/**
 * Sender-side scrollable list of the files queued for transfer. While the set
 * is still editable each row has a delete button; once it is sealed (Create
 * clicked) it shows a
 * per-file checkmark or spinner, decided by lib/sendSummary.ts from how the
 * send ended and never from the status sentence. Purely presentational; the
 * file state and the scroll ref live in P2PTransfer.
 *
 * The page renders this list again on every progress tick of a send, and at
 * least once per file, so what one render costs is paid once per tick. With
 * every row rendered each time, a send of N files cost N squared row renders
 * (T13-F4). Each row is a memo component given only what decides its look,
 * so a tick renders the one or two rows whose look changed. Measured on
 * 2026-10-16 in jsdom with production React, one render of the list during a
 * send: 9, 46, 239 and 514 ms at 250, 1,000, 4,000 and 10,000 files before,
 * 0.6, 0.9, 3.0 and 7.7 ms after. Still linear per render (every row is
 * still compared), so a long list still costs something per tick.
 */
export function SelectedFilesList({
    files,
    currentFileIndex,
    progress,
    filesLocked,
    sendEnd,
    onDeleteFile,
    listRef,
}: SelectedFilesListProps) {
    // A scroll box only once the rows no longer fit: see lib/fileListScroll.ts.
    const listClass = fileListScrolls(files.length)
        ? 'space-y-3 max-h-[300px] overflow-y-auto pr-1 pb-1 custom-scrollbar'
        : 'space-y-3 pb-1';
    const marks = files.map((_, index) => sendRowMark({ index, currentFileIndex, progress, end: sendEnd }));
    // The page hands a new function on every render, which would render every
    // row again; the rows get one that never changes and calls the latest.
    const deleteRef = useRef(onDeleteFile);
    useEffect(() => {
        deleteRef.current = onDeleteFile;
    });
    const onDelete = useCallback((id: string) => deleteRef.current(id), []);
    return (
        <div
            ref={listRef}
            className={listClass}
        >
            {files.map((item, i) => (
                <FileRow
                    key={item.id}
                    item={item}
                    mark={marks[i]}
                    moving={marks[i] === 'sending' && progress < 100}
                    filesLocked={filesLocked}
                    onDelete={onDelete}
                />
            ))}
        </div>
    );
}

interface FileRowProps {
    item: FileWithId;
    mark: SendRowMark;
    /** The file on its way: its name is drawn white. */
    moving: boolean;
    filesLocked: boolean;
    onDelete: (id: string) => void;
}

const FileRow = memo(function FileRow({ item, mark, moving, filesLocked, onDelete }: FileRowProps) {
    return (
        <div
            className="flex items-center gap-3 bg-white/[0.02] p-2 rounded-lg border border-white/[0.06]"
        >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.04] ring-1 ring-inset ring-white/10">
                <FileIcon
                    fileName={
                        item.file.name
                    }
                />
            </div>
            <div className="flex flex-col min-w-0 relative">
                <span
                    className={`peer text-sm font-medium truncate cursor-help transition-colors ${moving ? 'text-white' : 'text-zinc-400'}`}
                >
                    {item.file.name}
                </span>
                <div
                    aria-hidden="true"
                    className="absolute top-full left-0 mt-1 opacity-0 peer-hover:opacity-100 z-[9999] w-max max-w-[min(240px,calc(100vw-8rem))] px-3 py-2 text-xs font-medium text-white bg-zinc-950 rounded-lg border border-zinc-800 shadow-2xl break-all pointer-events-none"
                >
                    {item.file.name}
                    <div className="absolute bottom-full left-4 h-0 w-0 border-l-[7px] border-r-[7px] border-b-[7px] border-l-transparent border-r-transparent border-b-zinc-800"></div>
                    <div className="absolute bottom-full left-[17px] mt-[1px] h-0 w-0 border-l-[6px] border-r-[6px] border-b-[6px] border-l-transparent border-r-transparent border-b-zinc-950"></div>
                </div>
                <span className="text-xs text-zinc-500 font-mono">
                    {formatBytes(
                        item.file.size
                    )}
                </span>
            </div>
            <div className="ml-auto flex items-center gap-2">
                {!filesLocked ? (
                    <button
                        type="button"
                        aria-label={`Remove ${item.file.name}`}
                        onClick={() => onDelete(item.id)}
                        className="relative before:absolute before:-inset-2 p-1.5 rounded-md hover:bg-red-500/20 text-zinc-500 hover:text-red-400 transition-all"
                    >
                        <X className="h-4 w-4" strokeWidth={3} />
                    </button>
                ) : mark === 'sent' ? (
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                ) : mark === 'sending' ? (
                    <Loader2 className="h-4 w-4 animate-spin text-white" />
                ) : null}
            </div>
        </div>
    );
});
