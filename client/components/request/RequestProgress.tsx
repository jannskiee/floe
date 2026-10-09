import React, { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { visitorCopy } from '@/lib/request/visitorCopy';
import { ArrivedList, PathText, type PathRow } from '@/components/request/ArrivedList';
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
 *
 * Focus follows the confirmation: the Cancel that opens it unmounts, so focus
 * moves to Keep sending (which also scrolls it into view: at 320 x 568 the
 * question opened below the fold), and back to Cancel when Keep sending closes
 * it. The group's label and description make a screen reader read the
 * question on the way in.
 */
export function RequestProgress(props: RequestProgressProps) {
    const [confirming, setConfirming] = useState(false);
    const headerId = useId();
    const stopTitleId = useId();
    const stopBodyId = useId();
    const keepRef = useRef<HTMLButtonElement>(null);
    const cancelRef = useRef<HTMLButtonElement>(null);
    const opened = useRef(false);
    useEffect(() => {
        if (confirming) {
            opened.current = true;
            keepRef.current?.focus();
        } else if (opened.current) {
            opened.current = false;
            cancelRef.current?.focus();
        }
    }, [confirming]);
    const step = Math.min(100, Math.max(0, Math.floor(props.percent / 10) * 10));
    return (
        <section className="w-full rounded-2xl border border-white/[0.08] bg-zinc-950/85 p-6 shadow-[0_40px_90px_-30px_rgb(0_0_0/0.9)] sm:p-7">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <h1
                    id={headerId}
                    tabIndex={-1}
                    data-card-heading=""
                    className="min-w-0 font-mono text-[0.6875rem] tracking-[0.2em] text-zinc-400 outline-none"
                >
                    {props.header}
                </h1>
                <RouteBadge route={props.route} />
            </div>
            <p className="mt-4 text-sm font-medium text-white">
                <PathText path={props.currentPath} />
            </p>
            <div
                role="progressbar"
                aria-labelledby={headerId}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={step}
                className="mt-3 h-1 w-full overflow-hidden rounded-full bg-white/10"
            >
                {/* Keyed on the file: each ack restarts the bar at 0, and the
                    same element would animate that as a 500 ms rewind. */}
                <div
                    key={props.header}
                    className="h-full rounded-full bg-white transition-[width] duration-500 motion-reduce:transition-none"
                    style={{ width: `${Math.min(100, Math.max(0, props.percent))}%` }}
                />
            </div>
            <p className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[0.6875rem] text-zinc-400">
                {props.parts.map((part) => (
                    <span key={part}>{part}</span>
                ))}
            </p>
            <ArrivedList rows={props.arrived} />
            {confirming ? (
                <div
                    role="group"
                    aria-labelledby={stopTitleId}
                    aria-describedby={stopBodyId}
                    className="mt-5 rounded-xl border border-white/10 p-4"
                >
                    <p id={stopTitleId} className="text-sm font-semibold text-white">
                        {visitorCopy.stopTitle}
                    </p>
                    <p id={stopBodyId} className="mt-1 text-sm leading-relaxed text-zinc-400">
                        {visitorCopy.stopBody}
                    </p>
                    {/* flex-wrap: at 280 px the pair needs 195 px in 164. */}
                    <div className="mt-4 flex flex-wrap gap-2">
                        <Button
                            ref={keepRef}
                            type="button"
                            variant="outline"
                            className="touch-button flex-1 h-auto min-h-9 max-w-full whitespace-normal py-[7px] text-center"
                            onClick={() => setConfirming(false)}
                        >
                            {visitorCopy.keepSending}
                        </Button>
                        <Button type="button" variant="outline" className="touch-button h-auto min-h-9 max-w-full whitespace-normal py-[7px] text-center" onClick={props.onStop}>
                            {visitorCopy.stop}
                        </Button>
                    </div>
                </div>
            ) : (
                <Button
                    ref={cancelRef}
                    type="button"
                    variant="outline"
                    className="touch-button mt-5 w-full h-auto min-h-9 max-w-full whitespace-normal py-[7px] text-center"
                    onClick={() => setConfirming(true)}
                >
                    {visitorCopy.cancel}
                </Button>
            )}
            <p className="mt-4 text-xs leading-relaxed text-zinc-400">{visitorCopy.keepInFront}</p>
            {props.advice?.map((line) => (
                <p key={line} className="mt-2 text-xs leading-relaxed text-zinc-400">
                    {line}
                </p>
            ))}
        </section>
    );
}
