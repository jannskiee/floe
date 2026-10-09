'use client';

import Script from 'next/script';
import { usePathname } from 'next/navigation';
import { UMAMI_BEFORE_SEND, loadsUmami, umamiBeforeSend } from '@/lib/analyticsPath';

// The tracker looks the data-before-send hook up on window before every send,
// and a missing hook means nothing is filtered, so it is installed when this
// module first runs in the browser: before any render can append the script,
// on every page, and never torn down.
if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>)[UMAMI_BEFORE_SEND] = umamiBeforeSend;
}

interface Props {
    /** NEXT_PUBLIC_UMAMI_WEBSITE_ID, read in the root layout. It is inlined at
     *  build time, so it is passed in rather than read here, which keeps the one
     *  read of it in one place. */
    websiteId?: string;
}

/**
 * The Umami tracker, and the paths it may not load on.
 *
 * This is a client component for one reason: the tracker reports
 * location.href, and data-exclude-hash and data-exclude-search strip the
 * fragment and the query but NOT the path. A request link carries its link id
 * in the path, so on /r the tracker is not reconfigured, it is not loaded at
 * all. usePathname() is the only way to know the path, and that is a client
 * hook.
 *
 * usePathname does not make a route dynamic: components/layout/Navbar.tsx has
 * used it on every statically prerendered page for as long as those pages have
 * existed, so this costs the site nothing in rendering mode.
 */
export function UmamiScript({ websiteId }: Props) {
    const pathname = usePathname();

    if (!websiteId) return null;
    if (!loadsUmami(pathname)) return null;

    return (
        <Script
            defer
            src="https://cloud.umami.is/script.js"
            data-website-id={websiteId}
            // The two exclude flags are load-bearing privacy settings, not tidiness.
            // The tracker reports location.href and only strips the fragment
            // when exclude-hash is set, so without this a receiver opening
            // /?s=nonce#room=<uuid> would POST the room secret to Umami, which
            // is exactly what the privacy page promises never happens.
            data-exclude-hash="true"
            data-exclude-search="true"
            // Honor the browser's Do Not Track signal: with this set the
            // tracker sends nothing at all for that visitor. The live
            // cloud.umami.is script reads data-do-not-track and checks
            // navigator.doNotTrack, msDoNotTrack and window.doNotTrack
            // (verified 2026-09-05); the privacy page states this.
            data-do-not-track="true"
            // Every payload passes umamiBeforeSend first, which drops any
            // whose url or referrer is a /r path (lib/analyticsPath.ts).
            data-before-send={UMAMI_BEFORE_SEND}
            strategy="afterInteractive"
        />
    );
}
