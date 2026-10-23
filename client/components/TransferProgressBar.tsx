import { useId } from 'react';
import { Progress } from '@/components/ui/progress';
import { sendProgressLabel, type SendEnd } from '@/lib/sendSummary';

interface TransferProgressBarProps {
    isSender: boolean;
    /** The receiver's own status sentence. A sender's label never reads it. */
    status: string;
    /** How the send ended. Only read on a sender. */
    sendEnd: SendEnd;
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
    sendEnd,
    currentFileIndex,
    filesCount,
    transferSpeed,
    estimatedTime,
    progress,
}: TransferProgressBarProps) {
    const labelId = useId();
    return (
        <div className="space-y-2">
            <div className="flex justify-between text-xs text-zinc-400 font-mono">
                <span id={labelId}>
                    {/* A refusal that lands after the last byte leaves this row
                        on screen, and "Sending file X of N..." would then be a
                        false claim about a transfer that stopped. A failed send
                        drops the label rather than inventing a new string; the
                        banner above already says what happened. The sender's
                        words come from how the send ended, not from the status
                        sentence: see lib/sendSummary.ts. */}
                    {isSender
                        ? sendProgressLabel({ end: sendEnd, currentFileIndex, filesCount })
                        : status.includes('Receiving') || status.includes('Verifying')
                            ? status
                            : 'Receiving...'}
                </span>
                <span className="flex items-center gap-2">
                    {/* A send that has ended is not moving: its last speed and
                        time remaining are not shown beside it. */}
                    {transferSpeed && estimatedTime && progress < 100 && (!isSender || sendEnd === 'open') && (
                        <span className="text-zinc-500">
                            {transferSpeed} · {estimatedTime}
                        </span>
                    )}
                    <span>{progress}%</span>
                </span>
            </div>
            <Progress
                value={progress}
                aria-labelledby={labelId}
                className="h-1 bg-white/10 [&>div]:bg-white"
            />
        </div>
    );
}
