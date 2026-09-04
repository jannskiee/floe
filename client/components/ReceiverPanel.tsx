import type { RefObject } from 'react';
import { CheckCircle2, Circle, Download, FileArchive, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StatsContributionToggle } from '@/components/StatsContributionToggle';
import { ReceivedFilesList } from '@/components/ReceivedFilesList';
import { formatBytes } from '@/lib/utils';
import type { ReceivedFile } from '@/hooks/useDownloadManager';

interface ReceiverPanelProps {
    receivedFiles: ReceivedFile[];
    status: string;
    isConnected: boolean;
    reportStatsEnabled: boolean;
    onReportStatsChange: (enabled: boolean) => void;
    isZipping: boolean;
    isDownloading: boolean;
    downloadProgress: { current: number; total: number; label: string };
    onDownloadAll: () => void;
    onDownloadZip: () => void;
    listRef: RefObject<HTMLDivElement | null>;
}

/**
 * Receiver-side card body: the handshake pipeline, the stats opt-out, the bulk
 * download controls, the received-file list and the completion line. Rendered
 * by P2PTransfer only when the page is not the sender.
 *
 * Purely presentational; every piece of state lives in P2PTransfer. listRef is
 * passed rather than created here on purpose: it is P2PTransfer's own ref, and
 * the auto-scroll effect that reads it has sender values in its dependency
 * array, so it cannot move. A local ref would break receiver auto-scroll with
 * no compile error and no failing test.
 */
export function ReceiverPanel({
    receivedFiles,
    status,
    isConnected,
    reportStatsEnabled,
    onReportStatsChange,
    isZipping,
    isDownloading,
    downloadProgress,
    onDownloadAll,
    onDownloadZip,
    listRef,
}: ReceiverPanelProps) {
    return (
        <div className="space-y-3 pt-2">
            {/* Handshake pipeline — shows what has happened and what comes next */}
            {receivedFiles.length === 0 &&
                !status.includes('Receiving') && (
                    <div className="space-y-3 px-1 py-3">
                        <div className={`flex items-center gap-2.5 text-sm ${isConnected ? 'text-zinc-400' : 'text-zinc-200'}`}>
                            {isConnected ? (
                                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" />
                            ) : (
                                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-400" />
                            )}
                            Secure room joined
                        </div>
                        <div className={`flex items-center gap-2.5 text-sm ${isConnected ? 'text-zinc-200' : 'text-zinc-600'}`}>
                            {isConnected ? (
                                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-400" />
                            ) : (
                                <Circle className="h-3.5 w-3.5 shrink-0 text-zinc-700" />
                            )}
                            Waiting for the sender to start
                        </div>
                        <div className="flex items-center gap-2.5 text-sm text-zinc-600">
                            <Circle className="h-3.5 w-3.5 shrink-0 text-zinc-700" />
                            Files stream in below
                        </div>
                    </div>
                )}

            {/* Contribute to global stats toggle — visible while waiting, before any file arrives */}
            {receivedFiles.length === 0 && (
                <StatsContributionToggle enabled={reportStatsEnabled} onChange={onReportStatsChange} />
            )}

            {receivedFiles.length > 1 &&
                !status.includes('Receiving') && (
                    <div className="grid grid-cols-1 xs:grid-cols-2 sm:grid-cols-2 gap-2 mb-3 animate-in fade-in slide-in-from-top-2 duration-300">
                        <Button
                            onClick={onDownloadAll}
                            disabled={isDownloading || isZipping}
                            className="w-full bg-white text-black hover:bg-zinc-200 font-medium transition-colors border-none"
                        >
                            {isDownloading ? (
                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            ) : (
                                <Download className="w-4 h-4 mr-2" />
                            )}
                            {isDownloading ? 'Downloading...' : 'Download All'}
                        </Button>
                        <Button
                            onClick={onDownloadZip}
                            disabled={isZipping || isDownloading}
                            className="w-full bg-zinc-800 text-white hover:bg-zinc-700 font-medium transition-colors border border-zinc-700"
                        >
                            {isZipping ? (
                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            ) : (
                                <FileArchive className="w-4 h-4 mr-2" />
                            )}
                            {isZipping
                                ? 'Zipping...'
                                : 'Download ZIP'}
                        </Button>
                    </div>
                )}

            {(isZipping || isDownloading) && downloadProgress.total > 0 && (
                <div className="bg-zinc-800/50 rounded-lg p-3 border border-zinc-700 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                        <span className="text-zinc-400 truncate max-w-[120px] sm:max-w-[180px]">
                            {downloadProgress.label}
                        </span>
                        <span className="text-white font-mono">
                            {downloadProgress.current}/{downloadProgress.total}
                        </span>
                    </div>
                    <div className="bg-white/20 relative h-2 w-full overflow-hidden rounded-full">
                        <div
                            className="bg-white h-full transition-all"
                            style={{ width: `${(downloadProgress.current / downloadProgress.total) * 100}%` }}
                        />
                    </div>
                    <div className="text-xs text-zinc-500 text-center">
                        {Math.round((downloadProgress.current / downloadProgress.total) * 100)}% complete
                    </div>
                </div>
            )}
            <ReceivedFilesList receivedFiles={receivedFiles} listRef={listRef} />

            {receivedFiles.length > 0 && (
                <div className="pt-1 pb-0.5 px-0.5">
                    <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">
                        {receivedFiles.length} {receivedFiles.length === 1 ? 'file' : 'files'} ({formatBytes(receivedFiles.reduce((s, f) => s + f.fileSize, 0))})
                    </span>
                </div>
            )}

            {typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent) && receivedFiles.length > 0 && (
                <p className="text-[10px] text-zinc-600 text-center mt-1">Tip: Use &quot;Download ZIP&quot; for the best experience on iOS.</p>
            )}

            {status.includes('Receiving') ? (
                <div className="flex w-full items-center justify-center gap-2 text-xs text-zinc-400 animate-pulse pt-2">
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                    <span className="truncate max-w-[200px] sm:max-w-[280px]">
                        {status}
                    </span>
                </div>
            ) : receivedFiles.length > 0 && (
                <div className="flex w-full items-center justify-center gap-2 text-xs text-zinc-400 pt-2">
                    <CheckCircle2 className="h-3 w-3 shrink-0 text-green-500" />
                    <span>
                        {receivedFiles.length} {receivedFiles.length === 1 ? 'file' : 'files'} received
                    </span>
                </div>
            )}
        </div>
    );
}
