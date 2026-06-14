'use client';

import React, { useEffect, useState } from 'react';
import { ExternalLink, Copy, Check } from 'lucide-react';

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
    // Generic Android WebView (non-Chrome)
    if (/Android/.test(ua) && /wv\)/.test(ua) && !/Chrome\/\d/.test(ua)) return 'InAppBrowser';
    return null;
}

function isAndroid(ua: string): boolean {
    return /Android/i.test(ua);
}

function getAppIcon(app: DetectedApp): string {
    const icons: Record<DetectedApp, string> = {
        Facebook: '📘',
        Messenger: '💬',
        Instagram: '📷',
        TikTok: '🎵',
        Snapchat: '👻',
        LINE: '💚',
        Twitter: '🐦',
        WeChat: '💬',
        InAppBrowser: '📱',
    };
    return icons[app] ?? '📱';
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
        // If even this fails, the URL is shown on screen so user can manually copy
    }
}

interface Props {
    children: React.ReactNode;
}

export function InAppBrowserGuard({ children }: Props) {
    const [{ detectedApp, android, currentUrl }, setInit] = useState<{
        detectedApp: DetectedApp | null;
        android: boolean;
        currentUrl: string;
    }>({ detectedApp: null, android: false, currentUrl: '' });
    const [dismissed, setDismissed] = useState(false);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        const ua = navigator.userAgent;
        const app = detectInAppBrowser(ua);
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setInit({ detectedApp: app, android: isAndroid(ua), currentUrl: window.location.href });
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

    if (!detectedApp || dismissed) {
        return <>{children}</>;
    }

    const icon = getAppIcon(detectedApp);
    const appName = detectedApp === 'InAppBrowser' ? 'this app' : detectedApp;

    return (
        <>
            {/* Blurred background content */}
            <div className="pointer-events-none select-none blur-sm opacity-40" aria-hidden>
                {children}
            </div>

            {/* Overlay */}
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/95 p-4 backdrop-blur-sm">
                <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-900 p-6 shadow-2xl">

                    {/* Icon + heading */}
                    <div className="mb-5 flex flex-col items-center gap-3 text-center">
                        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white/5 text-3xl">
                            {icon}
                        </div>
                        <div>
                            <h2 className="text-lg font-semibold text-white">
                                Open in your browser
                            </h2>
                            <p className="mt-1 text-sm text-zinc-400">
                                {appName === 'this app' ? 'This in-app browser' : `${appName}'s browser`} has limited
                                support for file transfers. Open Floe in Chrome or Safari for the best experience.
                            </p>
                        </div>
                    </div>

                    {/* Platform-specific instructions */}
                    <div className="mb-5 rounded-xl bg-white/5 p-4 text-sm">
                        <p className="mb-2 font-medium text-zinc-300">How to open in your browser:</p>
                        {android ? (
                            <ol className="space-y-1.5 text-zinc-400">
                                <li className="flex gap-2">
                                    <span className="shrink-0 font-medium text-zinc-300">1.</span>
                                    Tap the <span className="mx-0.5 rounded bg-white/10 px-1 font-mono text-xs text-zinc-200">⋮</span> three-dot menu at the top right
                                </li>
                                <li className="flex gap-2">
                                    <span className="shrink-0 font-medium text-zinc-300">2.</span>
                                    Tap <span className="font-medium text-zinc-200">&quot;Open in browser&quot;</span> or <span className="font-medium text-zinc-200">&quot;Open in Chrome&quot;</span>
                                </li>
                            </ol>
                        ) : (
                            <ol className="space-y-1.5 text-zinc-400">
                                <li className="flex gap-2">
                                    <span className="shrink-0 font-medium text-zinc-300">1.</span>
                                    Tap the <ExternalLink className="mx-0.5 inline h-3.5 w-3.5 text-zinc-300" /> icon or <span className="mx-0.5 rounded bg-white/10 px-1 font-mono text-xs text-zinc-200">···</span> menu
                                </li>
                                <li className="flex gap-2">
                                    <span className="shrink-0 font-medium text-zinc-300">2.</span>
                                    Tap <span className="font-medium text-zinc-200">&quot;Open in Safari&quot;</span> or <span className="font-medium text-zinc-200">&quot;Open in Browser&quot;</span>
                                </li>
                            </ol>
                        )}
                    </div>

                    {/* Copy link button */}
                    <button
                        onClick={handleCopy}
                        className="mb-3 flex w-full items-center justify-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200 active:scale-[0.98]"
                    >
                        {copied ? (
                            <>
                                <Check className="h-4 w-4 text-green-600" />
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
                        className="w-full text-center text-xs text-zinc-500 transition hover:text-zinc-300"
                    >
                        Continue anyway (some features may not work)
                    </button>
                </div>
            </div>
        </>
    );
}
