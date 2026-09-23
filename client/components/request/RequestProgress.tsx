import React, { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { displayPath, visitorCopy } from '@/lib/request/visitorCopy';
import { ArrivedList, type PathRow } from '@/components/request/ArrivedList';
import { RouteBadge } from '@/components/request/RouteBadge';

export interface RequestProgressProps {
    /** C-90, from the sender's own index. */
    header: string;
    route: 'direct' | 'relay' | null;
    /** C-91: the visitor's own relative path of the file being sent. */
    currentPath: string;
    /** This file's progress, 0 to 100. */
    percent: number;
    /** C-92, laid out side by side. */
    parts: string[];
    arrived: PathRow[];
    /** Extra advice lines under C-94 (the whole-drop ETA lines). */
    advice?: string[];
    /** Called when the visitor confirms Stop. */
    onStop: () => void;
}

/**
 * V10, Sending (W6).
 *
 * Cancel here asks first (D-091 Q-C14 option a, wording D-096), because after
 * the first ack a stop uses up the one-time link. The confirmation replaces
 * the Cancel button inline: Keep sending wide on the left, Stop on the right.
 *
 * The progress bar reports in 10% steps so a screen reader is not flooded, and
 * the ARRIVED list stays outside the live region.
 */
export function RequestProgress(props: RequestProgressProps) {
    const [confirming, setConfirming] = useState(false);
    const headerId = useId();
    const step = Math.min(100, Math.max(0, Math.floor(props.percent / 10) * 10));
    return (
        <section className="w-full rounded-2xl border border-white/[0.08] bg-white/[0.02] p-6 sm:p-7">
            <div className="flex items-center justify-between gap-4">
                <h1 id={headerId} className="font-mono text-[11px] tracking-[0.2em] text-zinc-400">
                    {props.header}
                </h1>
                <RouteBadge route={props.route} />
            </div>
            <p className="mt-4 truncate text-sm font-medium text-white">{displayPath(props.currentPath)}</p>
            <div
                role="progressbar"
                aria-labelledby={headerId}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={step}
                className="mt-3 h-1 w-full overflow-hidden rounded-full bg-white/10"
            >
                <div
                    className="h-full rounded-full bg-white transition-[width] duration-500"
                    style={{ width: `${Math.min(100, Math.max(0, props.percent))}%` }}
                />
            </div>
            <p className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-zinc-400">
                {props.parts.map((part) => (
                    <span key={part}>{part}</span>
                ))}
            </p>
            <ArrivedList rows={props.arrived} />
            {confirming ? (
                <div className="mt-5 rounded-xl border border-white/10 p-4">
                    <p className="text-sm font-semibold text-white">{visitorCopy.stopTitle}</p>
                    <p className="mt-1 text-sm leading-relaxed text-zinc-400">{visitorCopy.stopBody}</p>
                    <div className="mt-4 flex gap-2">
                        <Button type="button" variant="outline" className="flex-1" onClick={() => setConfirming(false)}>
                            {visitorCopy.keepSending}
                        </Button>
                        <Button type="button" variant="outline" onClick={props.onStop}>
                            {visitorCopy.stop}
                        </Button>
                    </div>
                </div>
            ) : (
                <Button type="button" variant="outline" className="mt-5 w-full" onClick={() => setConfirming(true)}>
                    {visitorCopy.cancel}
                </Button>
            )}
            <p className="mt-4 text-xs leading-relaxed text-zinc-500">{visitorCopy.keepInFront}</p>
            {props.advice?.map((line) => (
                <p key={line} className="mt-2 text-xs leading-relaxed text-zinc-500">
                    {line}
                </p>
            ))}
        </section>
    );
}
