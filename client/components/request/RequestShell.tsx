'use client';

import React from 'react';
import { RequestVisitor } from '@/components/RequestVisitor';

/**
 * The /r visitor page shell: the chrome around the visitor.
 *
 * Page chrome is deliberately not the site's Navbar and Footer (Checkpoint C,
 * O6): a bare wordmark and a minimal Privacy and Terms footer, so nothing pulls
 * the visitor away in the middle of a drop.
 *
 * Everything inside it is RequestVisitor, which reads the link and the browser
 * in a mount effect (their inputs exist only in the browser, so the server
 * render and the first client render agree), and which opens no socket, fetches
 * no ICE list and builds no RTCPeerConnection until the visitor presses Send. A
 * link scanner, a preview fetcher or a curious forward can open /r and take
 * nothing away with it, not the room seat and not an IP address.
 */
export function RequestShell() {
    return (
        // The same centering shell as /, /download and not-found: the root
        // layout's <body> carries only the font variables, so a page that omits
        // this renders zinc text on white.
        //
        // dark and scheme-dark put everything inside in the dark theme. Nothing
        // above sets .dark, so without them the shadcn Button read the light
        // tokens (near-white outline buttons under near-white text, a
        // near-black Send on the near-black card) and the native Hide my IP
        // checkbox drew white (R4 F1, F2).
        <div className="dark scheme-dark flex min-h-dvh flex-col items-center bg-zinc-950 font-sans text-zinc-100 px-[max(1rem,env(safe-area-inset-left),env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-[max(1.5rem,env(safe-area-inset-left),env(safe-area-inset-right))] sm:pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            {/* A wordmark, not a link. It tells the visitor where they are,
                which is half of why the links live on floe.one at all, and it
                goes nowhere: one task on this page. */}
            <p className="pt-8 text-sm font-extrabold tracking-tighter text-white sm:pt-10">
                Floe
            </p>

            <main className="flex w-full max-w-xl flex-1 flex-col items-center justify-center">
                <RequestVisitor />
            </main>

            <RequestFooter />
        </div>
    );
}

/** Privacy and Terms, and nothing else.
 *
 *  Plain anchors, never next/link, so leaving /r is a page load. A next/link
 *  keeps the /r document alive and was measured leaking the link id three
 *  ways (CP-QA F3-01, F3-02): its in-viewport prefetches send
 *  Next-Url: /r/<linkId> to the server with no click at all; the Umami tracker
 *  the next page loads stays in the document, so Back reports /r/<linkId> as a
 *  pageview and the following page reports it as the referrer. The same soft
 *  hop also skips beforeunload, so the Stop confirmation never shows mid-drop
 *  (F5-02), and it carries the socket singleton the page disconnected over to
 *  / (F5-04).
 *
 *  rel="noreferrer" on both. They are same-origin today and the no-referrer
 *  response header already covers them, so this is the belt to that header's
 *  braces: a page whose whole point is that its URL does not travel should not
 *  depend on one mechanism for it. */
function RequestFooter() {
    return (
        <footer className="flex items-center justify-center gap-6 pb-8 pt-10 text-xs text-zinc-500 sm:pb-10">
            <a
                href="/privacy"
                rel="noreferrer"
                className="transition hover:text-zinc-300 focus-visible:outline-2 focus-visible:outline-ice"
            >
                Privacy
            </a>
            <a
                href="/terms"
                rel="noreferrer"
                className="transition hover:text-zinc-300 focus-visible:outline-2 focus-visible:outline-ice"
            >
                Terms
            </a>
        </footer>
    );
}
