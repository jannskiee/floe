import React from 'react';
import Image from 'next/image';
import { DESKTOP_STORE_URL } from '@/lib/desktopRelease';

/**
 * The hero CTA row: the official Microsoft Store badge, alone, on every
 * platform.
 *
 * A web-app pill used to lead here for non-Windows visitors, which meant the
 * primary action on the download page sent them back to the page they had just
 * come from. Removing it also removes the reason this file was a client
 * island: the OS sniff, the useSyncExternalStore snapshot split it needed to
 * stay hydration-safe, and the two-arrangement swap all existed only to decide
 * whether to render that pill.
 *
 * The badge is Microsoft's own "Get it from Microsoft" asset (en-US dark
 * variant), self-hosted from /public so the page makes no external requests.
 * Brand rules: never recolor or redraw it, keep it at its native aspect ratio,
 * and do not shrink it below ~120px wide. The Store page URL works in any
 * browser on any OS, so the badge stays clickable everywhere.
 */

// The badge ships at 161x44 and is rendered at 220x60 (same ratio): the hero
// action of the page, so it carries more weight than the pill it replaced.
// `unoptimized` serves the raw SVG vector, so it stays crisp at any size and
// DPI. Opacity lift on hover mirrors the old pill's hover shift without
// recoloring Microsoft's artwork.
const badgeClass =
    'inline-flex items-center opacity-95 transition hover:opacity-100 focus-visible:outline-2 focus-visible:outline-ice';

export function DownloadCta() {
    return (
        <div className="flex items-center justify-center">
            <a
                href={DESKTOP_STORE_URL}
                target="_blank"
                rel="noreferrer"
                data-umami-event="download-desktop"
                data-umami-event-file="store"
                data-umami-event-source="hero-primary"
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
        </div>
    );
}
