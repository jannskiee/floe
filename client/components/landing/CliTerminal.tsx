'use client';

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RotateCcw } from 'lucide-react';

// Mirrors the real `floe send` output format (cli/cmd/floe): keep this session
// consistent with what the CLI actually prints.
const COMMAND = 'floe send vacation-photos/';
const DIVIDER = '─'.repeat(44);
const BAR_WIDTH = 16;
const FINAL_STAGE = 11;

const FILES = [
    { name: 'IMG_2041.jpg', sizeMB: 5.2, total: '5.2 MB' },
    { name: 'IMG_2042.jpg', sizeMB: 4.9, total: '4.9 MB' },
    { name: 'notes.txt', sizeMB: 0.014, total: '14 KB' },
];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function bar(fraction: number) {
    const filled = Math.round(fraction * BAR_WIDTH);
    return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

function partial(fraction: number, file: (typeof FILES)[number]) {
    if (file.sizeMB < 1) return `${Math.round(fraction * file.sizeMB * 1000)} KB`;
    return `${(fraction * file.sizeMB).toFixed(1)} MB`;
}

function subscribeReducedMotion(callback: () => void) {
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    mql.addEventListener('change', callback);
    return () => mql.removeEventListener('change', callback);
}
const getReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const getServerReducedMotion = () => false;

export function CliTerminal() {
    const containerRef = useRef<HTMLDivElement>(null);
    const reduced = useSyncExternalStore(subscribeReducedMotion, getReducedMotion, getServerReducedMotion);
    // 0 = waiting for the section to scroll into view; increments re-run the timeline (replay)
    const [playToken, setPlayToken] = useState(0);
    const [typed, setTyped] = useState('');
    const [stage, setStage] = useState(0);
    const [progress, setProgress] = useState<number[]>([0, 0, 0]);
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
        if (playToken === 0 || reduced) return;
        let cancelled = false;
        (async () => {
            await sleep(350);
            for (let i = 1; i <= COMMAND.length; i++) {
                if (cancelled) return;
                setTyped(COMMAND.slice(0, i));
                await sleep(24);
            }
            await sleep(450);
            for (let s = 1; s <= 8; s++) {
                if (cancelled) return;
                setStage(s);
                await sleep(s === 6 ? 1000 : s === 7 ? 550 : 140);
            }
            for (let f = 0; f < FILES.length; f++) {
                const ticks = f === 2 ? 4 : 13;
                for (let t = 1; t <= ticks; t++) {
                    if (cancelled) return;
                    const fraction = t / ticks;
                    setProgress((prev) => prev.map((p, i) => (i === f ? fraction : i < f ? 1 : p)));
                    await sleep(70);
                }
            }
            await sleep(350);
            for (let s = 9; s <= FINAL_STAGE; s++) {
                if (cancelled) return;
                setStage(s);
                await sleep(150);
            }
            if (!cancelled) setDone(true);
        })();
        return () => {
            cancelled = true;
        };
    }, [playToken, reduced]);

    const replay = () => {
        setTyped('');
        setStage(0);
        setProgress([0, 0, 0]);
        setDone(false);
        setPlayToken((t) => t + 1);
    };

    // With reduced motion the completed session renders statically, no timers.
    const shownTyped = reduced ? COMMAND : typed;
    const shownStage = reduced ? FINAL_STAGE : stage;
    const shownProgress = reduced ? [1, 1, 1] : progress;
    const isDone = reduced || done;

    return (
        <div ref={containerRef} className="w-full">
            <div className="overflow-hidden rounded-xl border border-white/10 bg-black/60">
                <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
                    <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-600">
                        terminal
                    </span>
                    <button
                        type="button"
                        onClick={replay}
                        aria-label="Replay the transfer demo"
                        className={`rounded p-1 text-zinc-600 transition hover:text-zinc-300 focus-visible:outline-2 focus-visible:outline-ice ${
                            done && !reduced ? 'opacity-100' : 'pointer-events-none opacity-0'
                        }`}
                    >
                        <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                </div>
                {/* min-height matches the completed session so replay does not shift the layout */}
                <div className="custom-scrollbar min-h-[480px] overflow-x-auto px-4 py-4" aria-hidden="true">
                    <div className="min-w-max whitespace-pre font-mono text-[12.5px] leading-[1.7] text-zinc-300">
                        <div>
                            <span className="text-ice">$ </span>
                            <span className="text-zinc-100">{shownTyped}</span>
                            {!isDone && <span className="animate-blink text-ice">▍</span>}
                        </div>
                        {shownStage >= 1 && (
                            <>
                                <div> </div>
                                <div>
                                    <span className="text-zinc-500">{'  Sending'}</span>
                                    {'   3 files · 11.8 MB'}
                                </div>
                            </>
                        )}
                        {shownStage >= 2 && <div className="text-zinc-700">{`  ${DIVIDER}`}</div>}
                        {shownStage >= 3 && (
                            <div>
                                <span className="text-zinc-500">{'  Code'}</span>
                                {'   '}
                                <span className="text-ice">olive-tiger-castle</span>
                            </div>
                        )}
                        {shownStage >= 4 && (
                            <div>
                                <span className="text-zinc-500">{'  Link'}</span>
                                {'   https://floe.one/#room=7f3a…'}
                            </div>
                        )}
                        {shownStage >= 5 && (
                            <>
                                <div className="text-zinc-700">{`  ${DIVIDER}`}</div>
                                <div> </div>
                            </>
                        )}
                        {shownStage >= 6 && <div className="text-zinc-500">{'  Waiting for peer...'}</div>}
                        {shownStage >= 7 && <div className="text-zinc-500">{'  Connecting...'}</div>}
                        {shownStage >= 8 && (
                            <>
                                <div className="text-green-400">{'  Connected'}</div>
                                <div> </div>
                            </>
                        )}
                        {FILES.map(
                            (file, i) =>
                                shownProgress[i] > 0 && (
                                    <div key={file.name}>
                                        {`  [${i + 1}/3] ${file.name.padEnd(14)}[${bar(shownProgress[i])}] ${partial(shownProgress[i], file)}/${file.total}`}
                                    </div>
                                )
                        )}
                        {shownStage >= 9 && (
                            <>
                                <div> </div>
                                <div className="text-zinc-700">{`  ${DIVIDER}`}</div>
                            </>
                        )}
                        {shownStage >= 10 && (
                            <div>
                                <span className="text-zinc-500">{'  Sent'}</span>
                                {'   3 files (11.8 MB)'}
                            </div>
                        )}
                        {shownStage >= 11 && (
                            <>
                                <div>
                                    <span className="text-zinc-500">{'  Time'}</span>
                                    {'   8s · avg 1.4 MB/s'}
                                </div>
                                <div className="text-zinc-700">{`  ${DIVIDER}`}</div>
                            </>
                        )}
                        {isDone && (
                            <div>
                                <span className="text-ice">$ </span>
                                {!reduced && <span className="animate-blink text-ice">▍</span>}
                            </div>
                        )}
                    </div>
                </div>
            </div>
            <p className="sr-only">
                Example terminal session: floe send shares three files totaling 11.8 MB, prints the
                short code olive-tiger-castle and a link, connects to the peer, and completes the
                transfer in 8 seconds at an average of 1.4 MB per second.
            </p>
        </div>
    );
}
