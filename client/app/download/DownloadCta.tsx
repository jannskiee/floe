'use client';

import React, { useSyncExternalStore } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { detectOs, type VisitorOs } from '@/lib/detectOs';
import { DESKTOP_STORE_URL } from '@/lib/desktopRelease';

/**
 * The hero CTA row: the official Microsoft Store badge and one de-emphasized
 * secondary. Detection swaps which action leads, never the geometry: the
 * server renders the Windows arrangement (the only OS the beta runs on), the
 * client corrects on hydration, and both arrangements share the same
 * single-row flex container, so the swap never reflows the page.
 *
 * The badge is Microsoft's own "Get it from Microsoft" asset (en-US dark
 * variant), self-hosted from /public so the page makes no external requests.
 * Brand rules: never recolor or redraw it, keep it at its native aspect
 * ratio, and do not shrink it below ~120px wide. The Store page URL works in
 * any browser on any OS, so the badge stays clickable everywhere.
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
const secondaryClass =
    'text-[13px] font-bold text-white/70 transition hover:text-white focus-visible:outline-2 focus-visible:outline-ice';

// The badge ships at 161x44 and is rendered at 220x60 (same ratio): the hero
// action of the page, so it carries more weight than the pill it replaced.
// `unoptimized` serves the raw SVG vector, so it stays crisp at any size and
// DPI. Opacity lift on hover mirrors the old pill's hover shift without
// recoloring Microsoft's artwork.
const badgeClass =
    'inline-flex items-center opacity-95 transition hover:opacity-100 focus-visible:outline-2 focus-visible:outline-ice';

function StoreBadge({ source }: { source: string }) {
    return (
        <a
            href={DESKTOP_STORE_URL}
            target="_blank"
            rel="noreferrer"
            data-umami-event="download-desktop"
            data-umami-event-file="store"
            data-umami-event-source={source}
            className={badgeClass}
        >
            <Image
                src="/ms-store-badge.svg"
                alt="Get Floe Desktop from the Microsoft Store"
                width={220}
                height={60}
                priority
                unoptimized
            />
        </a>
    );
}

export function DownloadCta() {
    const os = useSyncExternalStore(subscribeNever, getOsSnapshot, getServerOsSnapshot);
    const windowsArrangement = os === 'windows';

    return (
        <div className="flex min-h-[60px] flex-wrap items-center justify-center gap-x-5 gap-y-3">
            {windowsArrangement ? (
                <>
                    <StoreBadge source="hero-primary" />
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
                    <StoreBadge source="hero-secondary" />
                </>
            )}
        </div>
    );
}
