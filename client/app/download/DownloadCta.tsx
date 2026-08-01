'use client';

import React, { useSyncExternalStore } from 'react';
import Link from 'next/link';
import { detectOs, type VisitorOs } from '@/lib/detectOs';
import { DESKTOP_SETUP_URL } from '@/lib/desktopRelease';

/**
 * The hero CTA row: one filled pill and one de-emphasized secondary. Detection
 * swaps which action leads, never the geometry: the server renders the Windows
 * arrangement (the only OS the beta runs on), the client corrects on hydration,
 * and both arrangements share the same single-row flex container, so the swap
 * never reflows the page.
 */

type NavigatorWithUAData = Navigator & { userAgentData?: { platform?: string } };

// The visitor's OS never changes during a visit, so this "store" never emits:
// useSyncExternalStore is used purely for its SSR-safe snapshot split, the same
// idiom CliTerminal uses for prefers-reduced-motion.
const subscribeNever = () => () => {};
const getOsSnapshot = (): VisitorOs => {
    const nav = navigator as NavigatorWithUAData;
    return detectOs(navigator.userAgent, nav.userAgentData?.platform);
};
const getServerOsSnapshot = (): VisitorOs => 'windows';

const pillClass =
    'inline-flex items-center justify-center rounded-full bg-white px-4 py-2 text-sm font-bold text-black transition hover:bg-zinc-200 focus-visible:outline-2 focus-visible:outline-ice';

// The Obsidian de-emphasis recipe: same weight as the primary, one size step
// down, dimmed white rather than the accent, no box, no underline, no arrow.
// White keeps the pair monochrome, so the filled pill stays the only thing
// competing for the eye.
const secondaryClass =
    'text-[13px] font-bold text-white/70 transition hover:text-white focus-visible:outline-2 focus-visible:outline-ice';

export function DownloadCta() {
    const os = useSyncExternalStore(subscribeNever, getOsSnapshot, getServerOsSnapshot);
    const windowsArrangement = os === 'windows';

    return (
        <div className="flex min-h-10 flex-wrap items-baseline justify-center gap-x-5 gap-y-3">
            {windowsArrangement ? (
                <>
                    <a
                        href={DESKTOP_SETUP_URL}
                        data-umami-event="download-desktop"
                        data-umami-event-file="installer"
                        data-umami-event-source="hero-primary"
                        className={pillClass}
                    >
                        Download for Windows
                    </a>
                    <Link
                        href="/"
                        data-umami-event="download-page-webapp"
                        data-umami-event-source="hero-secondary"
                        className={secondaryClass}
                    >
                        or use the web app
                    </Link>
                </>
            ) : (
                <>
                    <Link
                        href="/"
                        data-umami-event="download-page-webapp"
                        data-umami-event-source="hero-primary"
                        className={pillClass}
                    >
                        Open the web app
                    </Link>
                    <a
                        href={DESKTOP_SETUP_URL}
                        data-umami-event="download-desktop"
                        data-umami-event-file="installer"
                        data-umami-event-source="hero-secondary"
                        className={secondaryClass}
                    >
                        or download the Windows beta
                    </a>
                </>
            )}
        </div>
    );
}
