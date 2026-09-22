import Script from 'next/script';

interface Props {
    /** NEXT_PUBLIC_UMAMI_WEBSITE_ID, read in the root layout. It is inlined at
     *  build time, so it is passed in rather than read here, which keeps the one
     *  read of it in one place. */
    websiteId?: string;
}

/**
 * The Umami tracker.
 *
 * Lifted out of app/layout.tsx with its attributes and its comments unchanged,
 * so the layout reads as page structure and the tracker's own rules live in one
 * file. The empty-id check came with it: an absent website id still renders
 * nothing at all.
 */
export function UmamiScript({ websiteId }: Props) {
    if (!websiteId) return null;

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
            strategy="afterInteractive"
        />
    );
}
