import type { RefObject } from 'react';
import { CheckCircle2, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/lib/utils';
import type { ReceivedFile } from '@/hooks/useDownloadManager';

interface ReceivedFilesListProps {
    receivedFiles: ReceivedFile[];
    listRef: RefObject<HTMLDivElement | null>;
}

/**
 * Receiver-side scrollable list of completed files, each with a per-file
 * download link. Purely presentational; the received-files state and the scroll
 * ref live in P2PTransfer.
 */
export function ReceivedFilesList({ receivedFiles, listRef }: ReceivedFilesListProps) {
    return (
        <div
            ref={listRef}
            className="space-y-3 max-h-[300px] overflow-y-auto pr-1 custom-scrollbar"
        >
            {receivedFiles.map((file) => (
                <div
                    key={file.id}
                    className="relative group/fname flex items-center justify-between rounded-lg bg-white/[0.02] p-3 border border-white/[0.06]"
                >
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-green-500/10 text-green-500">
                            <CheckCircle2 className="h-5 w-5" />
                        </div>
                        <div className="flex flex-col min-w-0 relative">
                            <span className="text-sm font-medium text-white truncate max-w-[140px] sm:max-w-[250px] cursor-help">
                                {file.fileName}
                            </span>
                            <div className="absolute top-full left-0 mt-1 opacity-0 group-hover/fname:opacity-100 z-[9999] w-max max-w-[min(240px,calc(100vw-8rem))] px-3 py-2 text-xs font-medium text-white bg-zinc-950 rounded-lg border border-zinc-800 shadow-2xl break-all pointer-events-none">
                                {file.fileName}
                                <div className="absolute bottom-full left-4 h-0 w-0 border-l-[7px] border-r-[7px] border-b-[7px] border-l-transparent border-r-transparent border-b-zinc-800"></div>
                                <div className="absolute bottom-full left-[17px] mt-[1px] h-0 w-0 border-l-[6px] border-r-[6px] border-b-[6px] border-l-transparent border-r-transparent border-b-zinc-950"></div>
                            </div>
                            <span className="text-xs text-zinc-500">
                                {formatBytes(
                                    file.fileSize
                                )}
                            </span>
                        </div>
                    </div>
                    <Button
                        asChild
                        size="sm"
                        className="relative before:absolute before:-inset-1.5 bg-white text-black hover:bg-zinc-200 shrink-0"
                    >
                        <a
                            href={file.downloadUrl}
                            download={file.fileName}
                        >
                            <Download className="h-4 w-4" />
                        </a>
                    </Button>
                </div>
            ))}
        </div>
    );
}
