import { Progress } from '@/components/ui/progress';

interface TransferProgressBarProps {
    isSender: boolean;
    status: string;
    currentFileIndex: number;
    filesCount: number;
    transferSpeed: string;
    estimatedTime: string;
    progress: number;
}

/**
 * The active-transfer progress row: a label (sender upload / receiver download
 * state), the speed/ETA readout, the percentage, and the bar. Rendered by
 * P2PTransfer only while `progress > 0`. Purely presentational.
 */
export function TransferProgressBar({
    isSender,
    status,
    currentFileIndex,
    filesCount,
    transferSpeed,
    estimatedTime,
    progress,
}: TransferProgressBarProps) {
    return (
        <div className="space-y-2">
            <div className="flex justify-between text-xs text-zinc-400 font-mono">
                <span>
                    {isSender
                        ? status === 'All Files Sent!'
                            ? `Sent ${filesCount} ${filesCount === 1 ? 'file' : 'files'}`
                            : `Sending file ${currentFileIndex + 1} of ${filesCount}...`
                        : status.includes('Receiving')
                            ? status
                            : 'Receiving...'}
                </span>
                <span className="flex items-center gap-2">
                    {transferSpeed && estimatedTime && progress < 100 && (
                        <span className="text-zinc-500">
                            {transferSpeed} · {estimatedTime}
                        </span>
                    )}
                    <span>{progress}%</span>
                </span>
            </div>
            <Progress
                value={progress}
                className="h-1 bg-white/10 [&>div]:bg-ice"
            />
        </div>
    );
}
