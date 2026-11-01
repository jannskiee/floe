'use client';

import Script from 'next/script';
import { usePathname } from 'next/navigation';
import { UMAMI_BEFORE_SEND, loadsUmami, umamiBeforeSend } from '@/lib/analyticsPath';
import { UMAMI_INTEGRITY, UMAMI_SRC } from '@/lib/umamiPin';

// The tracker runs as first-party script on the page that holds a transfer's
// link, so this is a pinned copy and not Umami's live file: whatever that file
// becomes, floe.one runs the bytes that were read, and the browser refuses any
// others. The file is same-origin, so integrity needs no crossorigin, and the
// site's CSP (next.config.mjs) has no script-src or connect-src to change. What
// it reports still goes to Umami's collector, which data-host-url names.
//
// To refresh the copy:
// 1. GET https://cloud.umami.is/script.js. A GET only: nothing here may post a
//    page view to the collector.
// 2. Read the whole script: every network call, every attribute, what each
//    payload holds, and that data-exclude-hash, data-exclude-search,
//    data-do-not-track and data-before-send still do what the comments below
//    say. A copy that changes any of them does not ship as it is.
// 3. Save the bytes untouched as public/vendor/umami-<first 8 hex of its
//    sha256>.js and delete the old copy.
// 4. Update UMAMI_SRC, UMAMI_INTEGRITY (sha384- then the base64 sha384) and the
//    review note in lib/umamiPin.ts, the note in lib/analyticsPath.ts, and the
//    reviewed length in lib/umamiPin.test.ts.
// 5. Run pnpm test, then make a build with a website id and run
//    E2E_EXPECT_UMAMI=1 pnpm test:e2e request-privacy.spec.ts on it.

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
            src={UMAMI_SRC}
            integrity={UMAMI_INTEGRITY}
            data-host-url="https://gateway.umami.is"
            data-website-id={websiteId}
            // The two exclude flags are load-bearing privacy settings, not tidiness.
            // The tracker reports location.href and only strips the fragment
            // when exclude-hash is set, so without this a receiver opening
            // /?s=nonce#room=<uuid> would POST the room secret to Umami, which
            // is exactly what the privacy page promises never happens.
            data-exclude-hash="true"
            data-exclude-search="true"
            // Honor the browser's Do Not Track signal: with this set the
            // tracker sends nothing at all for that visitor. The pinned copy
            // reads data-do-not-track and checks navigator.doNotTrack,
            // msDoNotTrack and window.doNotTrack (read 2026-11-01); the
            // privacy page states this.
            data-do-not-track="true"
            // Every payload passes umamiBeforeSend first, which drops any
            // whose url or referrer is a /r path and takes the page title out
            // of the rest (lib/analyticsPath.ts).
            data-before-send={UMAMI_BEFORE_SEND}
            strategy="afterInteractive"
        />
    );
}
