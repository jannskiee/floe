'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { parseRequestLink } from '@/lib/request/requestLink';
import { hasDataChannelSupport } from '@/lib/request/browserSupport';
import { visitorCopy } from '@/lib/request/visitorCopy';
import { ReadyHeader } from '@/components/request/ReadyHeader';
import { NoticeCard } from '@/components/request/NoticeCard';

type VisitorState = 'checking' | 'incomplete' | 'unsupported' | 'ready';

/** Which of the three states this load is in.
 *
 *  Link shape first, browser second. A visitor holding a truncated link gets the
 *  remedy that is actually theirs to apply, and the browser message would be a
 *  detour for them; a visitor with a whole link in an old browser reaches the
 *  browser message either way. Neither check touches the network.
 *
 *  `typeof window`, not `Window`: RTCPeerConnection is declared as a global var
 *  rather than as a property of the Window interface, so a plain `Window` shares
 *  no property with SupportWindow and TypeScript rejects the call below as a
 *  weak-type mismatch. */
function readVisitorState(win: typeof window): VisitorState {
    const link = parseRequestLink(win.location.pathname, win.location.hash);
    if ('error' in link) return 'incomplete';
    return hasDataChannelSupport(win) ? 'ready' : 'unsupported';
}

/**
 * The /r visitor page shell, and the three states that need no network.
 *
 * Page chrome is deliberately not the site's Navbar and Footer (Checkpoint C,
 * O6): a bare wordmark and a minimal Privacy and Terms footer, so nothing pulls
 * the visitor away in the middle of a drop.
 *
 * Nothing here opens a socket, fetches ICE credentials or constructs an
 * RTCPeerConnection. That is the point of the card this component lands in: a
 * link scanner, a preview fetcher or a curious forward can open /r and take
 * nothing away with it, not the room seat and not an IP address. S1-WEB-03 adds
 * the Ready controls and the connection states below the header; until then the
 * Ready state is a header, an intro and a support line.
 *
 * The state is decided in one mount effect rather than during render, because
 * both of its inputs (location.hash and window.RTCPeerConnection) exist only in
 * the browser. Until that effect runs the chrome is drawn and the state slot is
 * empty, so the server render and the first client render agree and the page
 * never hydration-mismatches its way into announcing the link shape in the
 * console. (In practice the served HTML holds neither: InAppBrowserGuard above
 * this component withholds its children until its own detection tick, so the
 * whole page body arrives on the client.)
 */
export function RequestShell() {
    const [state, setState] = useState<VisitorState>('checking');

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setState(readVisitorState(window));
    }, []);

    return (
        // The same centering shell as /, /download and not-found: the root
        // layout's <body> carries only the font variables, so a page that omits
        // this renders zinc text on white.
        <div className="flex min-h-dvh flex-col items-center bg-zinc-950 font-sans text-zinc-100 px-[max(1rem,env(safe-area-inset-left),env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-[max(1.5rem,env(safe-area-inset-left),env(safe-area-inset-right))] sm:pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            {/* A wordmark, not a link. It tells the visitor where they are,
                which is half of why the links live on floe.one at all, and it
                goes nowhere: one task on this page. */}
            <p className="pt-8 text-sm font-extrabold tracking-tighter text-white sm:pt-10">
                Floe
            </p>

            <main className="flex w-full max-w-xl flex-1 flex-col items-center justify-center">
                {state === 'ready' && <ReadyHeader />}
                {state === 'incomplete' && (
                    <NoticeCard
                        title={visitorCopy.incompleteTitle}
                        body={visitorCopy.incompleteBody}
                    />
                )}
                {state === 'unsupported' && (
                    <NoticeCard
                        title={visitorCopy.unsupportedTitle}
                        body={visitorCopy.unsupportedBody}
                    />
                )}
            </main>

            <RequestFooter />
        </div>
    );
}

/** Privacy and Terms, and nothing else.
 *
 *  rel="noreferrer" on both. They are same-origin today and the no-referrer
 *  response header already covers them, so this is the belt to that header's
 *  braces: a page whose whole point is that its URL does not travel should not
 *  depend on one mechanism for it. */
function RequestFooter() {
    return (
        <footer className="flex items-center justify-center gap-6 pb-8 pt-10 text-xs text-zinc-500 sm:pb-10">
            <Link
                href="/privacy"
                rel="noreferrer"
                className="transition hover:text-zinc-300 focus-visible:outline-2 focus-visible:outline-ice"
            >
                Privacy
            </Link>
            <Link
                href="/terms"
                rel="noreferrer"
                className="transition hover:text-zinc-300 focus-visible:outline-2 focus-visible:outline-ice"
            >
                Terms
            </Link>
        </footer>
    );
}
