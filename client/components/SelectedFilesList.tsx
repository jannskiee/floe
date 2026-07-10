import type { RefObject } from 'react';
import { CheckCircle2, Loader2, X } from 'lucide-react';
import { FileIcon } from '@/components/FileIcon';
import { formatBytes } from '@/lib/utils';
import type { FileWithId } from '@/hooks/useFileManagement';

interface SelectedFilesListProps {
    files: FileWithId[];
    currentFileIndex: number;
    progress: number;
    generatedLink: string;
    status: string;
    onDeleteFile: (id: string) => void;
    listRef: RefObject<HTMLDivElement | null>;
}

/**
 * Sender-side scrollable list of the files queued for transfer. Before the link
 * exists each row has a delete button; during/after transfer it shows a
 * per-file checkmark or spinner. Purely presentational; the file state and the
 * scroll ref live in P2PTransfer.
 */
export function SelectedFilesList({
    files,
    currentFileIndex,
    progress,
    generatedLink,
    status,
    onDeleteFile,
    listRef,
}: SelectedFilesListProps) {
    return (
        <div
            ref={listRef}
            className="space-y-3 max-h-[300px] overflow-y-auto pr-1 pb-1 custom-scrollbar"
        >
            {files.map((item, i) => (
                <div
                    key={i}
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
                            className={`peer text-sm font-medium truncate cursor-help transition-colors ${i === currentFileIndex && progress > 0 && progress < 100 ? 'text-white' : 'text-zinc-400'}`}
                        >
                            {item.file.name}
                        </span>
                        <div className="absolute top-full left-0 mt-1 opacity-0 peer-hover:opacity-100 z-[9999] w-max max-w-[240px] px-3 py-2 text-xs font-medium text-white bg-zinc-950 rounded-lg border border-zinc-800 shadow-2xl break-all pointer-events-none">
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
                        {!generatedLink ? (
                            <button
                                onClick={() => onDeleteFile(item.id)}
                                className="p-1.5 rounded-md hover:bg-red-500/20 text-zinc-500 hover:text-red-400 transition-all"
                            >
                                <X className="h-4 w-4" strokeWidth={3} />
                            </button>
                        ) : i <
                            currentFileIndex ||
                            status ===
                            'All Files Sent!' ? (
                            <CheckCircle2 className="h-4 w-4 text-green-500" />
                        ) : i ===
                            currentFileIndex &&
                            progress > 0 ? (
                            <Loader2 className="h-4 w-4 animate-spin text-white" />
                        ) : null}
                    </div>
                </div>
            ))}
        </div>
    );
}
