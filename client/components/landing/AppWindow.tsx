'use client';

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Image from 'next/image';
import { RotateCcw } from 'lucide-react';
import { DESKTOP_VERSION } from '@/lib/desktopRelease';

/**
 * The desktop counterpart of CliTerminal: real screenshots of Floe Desktop
 * performing a send, sequenced inside the house chrome frame. Only a real
 * capture can prove the app's actual pitch (the same design, native), so
 * this is the one place the site ships raster imagery. The captures' own
 * zinc-950 canvas continues the page background inside a frame the site
 * already owns.
 *
 * The states replay a real session: files staged via paste, then a live room
 * with the code the server actually issued.
 */

const STATES = [
    { src: '/screenshots/desktop-idle.png', caption: 'waiting for files' },
    { src: '/screenshots/desktop-staged.png', caption: '3 files staged' },
    { src: '/screenshots/desktop-share.png', caption: 'room open' },
] as const;

const FINAL = STATES.length - 1;

// Captures are the app's client area at 1140x684 (its own titlebar cropped:
// the frame header below replaces the window chrome).
const SHOT_W = 1140;
const SHOT_H = 684;

const HOLD_MS = [1200, 1600];

function subscribeReducedMotion(callback: () => void) {
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    mql.addEventListener('change', callback);
    return () => mql.removeEventListener('change', callback);
}
const getReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const getServerReducedMotion = () => false;

export function AppWindow({
    priority = false,
    className = '',
}: {
    priority?: boolean;
    /** Extra classes merged onto the rounded frame (e.g. a page-specific shadow). */
    className?: string;
}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const reduced = useSyncExternalStore(subscribeReducedMotion, getReducedMotion, getServerReducedMotion);
    // 0 = waiting for the section to scroll into view; increments re-run the sequence (replay)
    const [playToken, setPlayToken] = useState(0);
    const [stage, setStage] = useState(0);
    const [done, setDone] = useState(false);

    useEffect(() => {
        if (reduced) return;
        const el = containerRef.current;
        if (!el) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting) {
                    setPlayToken((t) => (t === 0 ? 1 : t));
                    observer.disconnect();
                }
            },
            { threshold: 0.35 }
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [reduced]);

    useEffect(() => {
        if (reduced || playToken === 0) return;
        let cancelled = false;
        const timers: ReturnType<typeof setTimeout>[] = [];
        let elapsed = 0;
        for (let s = 1; s <= FINAL; s++) {
            elapsed += HOLD_MS[s - 1];
            timers.push(
                setTimeout(() => {
                    if (!cancelled) setStage(s);
                }, elapsed)
            );
        }
        timers.push(
            setTimeout(() => {
                if (!cancelled) setDone(true);
            }, elapsed + 700)
        );
        return () => {
            cancelled = true;
            timers.forEach(clearTimeout);
        };
    }, [reduced, playToken]);

    const replay = () => {
        setStage(0);
        setDone(false);
        setPlayToken((t) => t + 1);
    };

    // With reduced motion the finished session renders statically, no timers.
    const shownStage = reduced ? FINAL : stage;
    const isDone = reduced || done;

    return (
        <div ref={containerRef} className="w-full">
            <div className={`overflow-hidden rounded-xl border border-white/10 bg-black/60 ${className}`}>
                <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
                    <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-600">
                        floe desktop · {DESKTOP_VERSION}
                    </span>
                    <button
                        type="button"
                        onClick={replay}
                        aria-label="Replay the desktop demo"
                        className={`relative before:absolute before:-inset-3 rounded p-1 text-zinc-600 transition hover:text-zinc-300 focus-visible:outline-2 focus-visible:outline-ice ${
                            isDone && !reduced ? 'opacity-100' : 'pointer-events-none opacity-0'
                        }`}
                    >
                        <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                </div>
                <div className="relative aspect-[1140/684]" aria-hidden="true">
                    {STATES.map((state, i) => (
                        <Image
                            key={state.src}
                            src={state.src}
                            alt=""
                            width={SHOT_W}
                            height={SHOT_H}
                            priority={priority && i === 0}
                            className={`pointer-events-none absolute inset-0 h-full w-full select-none transition-opacity duration-500 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] ${
                                i === shownStage ? 'opacity-100' : 'opacity-0'
                            }`}
                        />
                    ))}
                </div>
                <div
                    className="flex items-center gap-2 border-t border-white/[0.06] px-4 py-2.5 font-mono text-[12.5px] text-zinc-500"
                    aria-hidden="true"
                >
                    <span>{STATES[shownStage].caption}</span>
                    {shownStage === FINAL && (
                        <>
                            <span className="text-zinc-700">·</span>
                            <span>
                                code <span className="text-ice">spray-turf-finch</span>
                            </span>
                        </>
                    )}
                </div>
            </div>
            <p className="sr-only">
                Demo of the Floe desktop app: three files are pasted and staged, then a share panel
                opens a live room with the code spray-turf-finch, a share link, and a QR code, waiting
                for the receiver.
            </p>
        </div>
    );
}
