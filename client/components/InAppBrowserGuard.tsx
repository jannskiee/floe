'use client';

import React, { useEffect, useState } from 'react';
import { ExternalLink, Copy, Check, SquareArrowOutUpRight } from 'lucide-react';

interface UmamiWindow extends Window {
    umami?: {
        track: (event: string, data?: Record<string, unknown>) => void;
    };
}

type DetectedApp =
    | 'Facebook'
    | 'Messenger'
    | 'Instagram'
    | 'TikTok'
    | 'Snapchat'
    | 'LINE'
    | 'Twitter'
    | 'WeChat'
    | 'InAppBrowser';

function detectInAppBrowser(ua: string): DetectedApp | null {
    if (/FBAN|FBAV/i.test(ua)) return 'Facebook';
    if (/FB_IAB.*FBAV/i.test(ua) || /\bMessenger\b/i.test(ua)) return 'Messenger';
    if (/Instagram/i.test(ua)) return 'Instagram';
    if (/musical_ly|TikTok/i.test(ua)) return 'TikTok';
    if (/Snapchat/i.test(ua)) return 'Snapchat';
    if (/\bLine\/\d/i.test(ua)) return 'LINE';
    if (/Twitter/i.test(ua)) return 'Twitter';
    if (/MicroMessenger|WeChat/i.test(ua)) return 'WeChat';
    if (/Android/.test(ua) && /wv\)/.test(ua) && !/Chrome\/\d/.test(ua)) return 'InAppBrowser';
    return null;
}

function isAndroid(ua: string): boolean {
    return /Android/i.test(ua);
}

function copyLinkFallback(url: string) {
    try {
        const textarea = document.createElement('textarea');
        textarea.value = url;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
    } catch {
        // URL is visible on screen so user can copy manually
    }
}

interface Props {
    children: React.ReactNode;
}

export function InAppBrowserGuard({ children }: Props) {
    const [{ detectedApp, android, currentUrl, ready }, setInit] = useState<{
        detectedApp: DetectedApp | null;
        android: boolean;
        currentUrl: string;
        ready: boolean;
    }>({ detectedApp: null, android: false, currentUrl: '', ready: false });
    const [dismissed, setDismissed] = useState(false);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        const ua = navigator.userAgent;
        const app = detectInAppBrowser(ua);
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setInit({ detectedApp: app, android: isAndroid(ua), currentUrl: window.location.href, ready: true });
        if (app) {
            try {
                (window as UmamiWindow).umami?.track('in-app-browser-detected', {
                    app,
                    platform: isAndroid(ua) ? 'android' : 'ios',
                });
            } catch {
                // Analytics failure is non-fatal
            }
        }
    }, []);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(currentUrl);
        } catch {
            copyLinkFallback(currentUrl);
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    // Wait for the one-tick detection effect before mounting children.
    // If we render children immediately (before detection), P2PTransfer's
    // mount effect will emit join-room and steal the receiver slot even
    // while the in-app browser overlay is showing.
    if (!ready) return null;
    if (!detectedApp || dismissed) return <>{children}</>;

    const appName = detectedApp === 'InAppBrowser' ? 'this app' : detectedApp;

    return (
        <>
            {/* Full-screen overlay — children are intentionally NOT rendered
                so P2PTransfer cannot join the room from the in-app browser */}
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/90 p-5 backdrop-blur-md">
                <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-white/[0.08] bg-zinc-900 shadow-[0_32px_64px_-12px_rgba(0,0,0,0.8)]">

                    {/* Top accent strip */}
                    <div className="h-px w-full bg-gradient-to-r from-transparent via-white/20 to-transparent" />

                    <div className="p-6">
                        {/* Icon + heading */}
                        <div className="mb-6 flex flex-col items-center gap-4 text-center">
                            {/* Gradient ring with lucide glyph */}
                            <div className="relative flex h-16 w-16 items-center justify-center">
                                <div className="absolute inset-0 rounded-full bg-gradient-to-br from-white/20 via-white/5 to-transparent" />
                                <div className="absolute inset-[2px] rounded-full bg-zinc-900" />
                                <SquareArrowOutUpRight className="relative h-6 w-6 text-white" strokeWidth={1.75} />
                            </div>

                            <div className="space-y-1.5">
                                <h2 className="text-xl font-bold tracking-tight text-white">
                                    Open in your browser
                                </h2>
                                <p className="text-sm leading-relaxed text-zinc-400">
                                    {appName === 'this app' ? 'This in-app browser' : `${appName}’s browser`} has limited support for file transfers. Open Floe in Chrome or Safari for the best experience.
                                </p>
                            </div>
                        </div>

                        {/* Platform-specific instructions */}
                        <div className="mb-5 rounded-xl border border-white/[0.06] bg-white/[0.03] p-4">
                            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">
                                How to open in your browser
                            </p>
                            {android ? (
                                <ol className="space-y-3">
                                    <li className="flex items-start gap-3 text-sm text-zinc-400">
                                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] font-bold text-zinc-300">
                                            1
                                        </span>
                                        <span>
                                            Tap the{' '}
                                            <kbd className="mx-0.5 inline-flex items-center rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs text-zinc-200">
                                                &#8942;
                                            </kbd>{' '}
                                            menu at the top right
                                        </span>
                                    </li>
                                    <li className="flex items-start gap-3 text-sm text-zinc-400">
                                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] font-bold text-zinc-300">
                                            2
                                        </span>
                                        <span>
                                            Tap{' '}
                                            <span className="font-medium text-zinc-200">&quot;Open in browser&quot;</span>
                                            {' '}or{' '}
                                            <span className="font-medium text-zinc-200">&quot;Open in Chrome&quot;</span>
                                        </span>
                                    </li>
                                </ol>
                            ) : (
                                <ol className="space-y-3">
                                    <li className="flex items-start gap-3 text-sm text-zinc-400">
                                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] font-bold text-zinc-300">
                                            1
                                        </span>
                                        <span>
                                            Tap the{' '}
                                            <ExternalLink className="mx-0.5 inline h-3.5 w-3.5 align-middle text-zinc-300" />
                                            {' '}icon or{' '}
                                            <kbd className="mx-0.5 inline-flex items-center rounded bg-white/10 px-1.5 py-0.5 font-mono text-xs text-zinc-200">
                                                &middot;&middot;&middot;
                                            </kbd>{' '}
                                            menu
                                        </span>
                                    </li>
                                    <li className="flex items-start gap-3 text-sm text-zinc-400">
                                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/10 text-[11px] font-bold text-zinc-300">
                                            2
                                        </span>
                                        <span>
                                            Tap{' '}
                                            <span className="font-medium text-zinc-200">&quot;Open in Safari&quot;</span>
                                            {' '}or{' '}
                                            <span className="font-medium text-zinc-200">&quot;Open in Browser&quot;</span>
                                        </span>
                                    </li>
                                </ol>
                            )}
                        </div>

                        {/* Copy link button */}
                        <button
                            onClick={handleCopy}
                            className="mb-3 flex w-full items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 text-sm font-semibold text-black transition-all duration-150 hover:bg-zinc-100 active:scale-[0.98]"
                        >
                            {copied ? (
                                <>
                                    <Check className="h-4 w-4 text-green-600" strokeWidth={2.5} />
                                    Link copied
                                </>
                            ) : (
                                <>
                                    <Copy className="h-4 w-4" />
                                    Copy link to paste in browser
                                </>
                            )}
                        </button>

                        {/* Continue anyway */}
                        <button
                            onClick={() => setDismissed(true)}
                            className="w-full py-1 text-center text-xs text-zinc-600 transition-colors hover:text-zinc-400"
                        >
                            Continue anyway (some features may not work)
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
}
