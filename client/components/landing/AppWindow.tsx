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

// The -2x suffix is part of the contract, not decoration: a re-capture must
// land on a NEW filename or the image optimizer and the CDN keep serving the
// old bytes under the old URL.
const STATES = [
    { src: '/screenshots/desktop-idle-2x.png', caption: 'waiting for files' },
    { src: '/screenshots/desktop-staged-2x.png', caption: '3 files staged' },
    { src: '/screenshots/desktop-share-2x.png', caption: 'room open' },
] as const;

const FINAL = STATES.length - 1;

// Captures are the app's client area at 2280x1368: the 1140x684 layout shot at
// device-pixel-ratio 2 (its own titlebar cropped, since the frame header below
// replaces the window chrome). The intrinsic size must stay 2x the largest CSS
// box this frame is rendered in, or HiDPI displays upscale it. next/image caps
// every srcset candidate at the source width, so a 1x master silently degrades
// to a blurry stretch on any retina screen with no error anywhere.
const SHOT_W = 2280;
const SHOT_H = 1368;

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
    sizes = '100vw',
}: {
    priority?: boolean;
    /** Extra classes merged onto the rounded frame (e.g. a page-specific shadow). */
    className?: string;
    /** Rendered-width hint for next/image; pass the caller's real layout so
     *  phones stop downloading the full 1140px master. */
    sizes?: string;
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
    // The frame painted first, and therefore the one worth preloading.
    const heroIndex = reduced ? FINAL : 0;

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
                        tabIndex={isDone && !reduced ? 0 : -1}
                        // Hidden from AT while it is invisible and pointer-events:none,
                        // otherwise screen readers offer a button nothing can activate.
                        aria-hidden={!(isDone && !reduced)}
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
                            sizes={sizes}
                            // 90, not the default 75: at 75 the WebP re-encode rings around
                            // 10-13px mono glyphs and mangles the QR. Requires the matching
                            // entry in images.qualities (next.config.mjs) or Next rejects it.
                            quality={90}
                            // Preload the frame that is actually shown first. With reduced
                            // motion the sequence renders its FINAL state immediately, so
                            // preloading frame 0 would fetch a frame nobody sees and leave
                            // the real LCP image lazy.
                            priority={priority && i === heroIndex}
                            // Next derives loading/preload from `priority` but never sets
                            // fetchPriority, so the LCP image otherwise races 12 other
                            // requests at default priority.
                            fetchPriority={priority && i === heroIndex ? 'high' : undefined}
                            className={`pointer-events-none absolute inset-0 h-full w-full select-none transition-opacity duration-500 [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] ${
                                i === shownStage ? 'opacity-100' : 'opacity-0'
                            }`}
                        />
                    ))}
                </div>
                {/* flex-wrap + nowrap spans: at 320px this row used to break INSIDE its
                    items, stacking "room"/"open", stranding the separator in the gutter
                    and hyphen-splitting the room code across two lines. */}
                <div
                    className="flex flex-wrap items-center gap-x-2 border-t border-white/[0.06] px-4 py-2.5 font-mono text-[12.5px] text-zinc-500"
                    aria-hidden="true"
                >
                    <span className="whitespace-nowrap">{STATES[shownStage].caption}</span>
                    {shownStage === FINAL && (
                        <>
                            <span className="text-zinc-700">·</span>
                            <span className="whitespace-nowrap">
                                code <span className="text-ice">yacht-metro-poppy</span>
                            </span>
                        </>
                    )}
                </div>
            </div>
            <p className="sr-only">
                Demo of the Floe desktop app: three files are pasted and staged, then a share panel
                opens a live room with the code yacht-metro-poppy, a share link, and a QR code,
                waiting for the receiver.
            </p>
        </div>
    );
}
