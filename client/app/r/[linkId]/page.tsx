import React from 'react';
import type { Metadata } from 'next';
import { InAppBrowserGuard } from '@/components/InAppBrowserGuard';
import { RequestShell } from '@/components/request/RequestShell';
import { configuredReportAddress } from '@/lib/request/report';
import { visitorCopy } from '@/lib/request/visitorCopy';
import { sharedOpenGraph, sharedTwitter } from '@/lib/socialMetadata';

/**
 * The request link visitor page: /r/<linkId>#<roomId>.
 *
 * Two things about this file are load-bearing and easy to undo by accident.
 *
 * 1. The metadata below is a STATIC object, not generateMetadata. A
 *    generateMetadata would be handed `params`, and the moment the link id is in
 *    scope in a metadata function it is one interpolation away from a <title>, a
 *    description or an og:title, which are the strings a link preview in a chat
 *    app fetches and renders to everyone in the room. The page component takes
 *    no props for the same reason: there is no id in scope here at all. Every
 *    /r/<id> therefore renders the same head markup, and the id is read on the
 *    client, out of a URL the server never sees the interesting half of. (Two
 *    tags do differ from one request to the next, for the same id as for
 *    another: Sentry's sentry-trace and baggage, a fresh trace id each time.
 *    Neither holds anything of the link.)
 *
 * 2. Every field of `robots` is set. Metadata merging in the App Router is
 *    SHALLOW, so declaring `robots` here replaces the resolver's whole object
 *    rather than merging into it; a half-filled one would quietly drop the rest.
 *    `alternates: {}` is the not-found.tsx pattern: the root layout declares
 *    `canonical: '/'`, and without this override a noindex page would name the
 *    HOME PAGE as its canonical.
 *
 * Rendering mode: this is a dynamic segment with no generateStaticParams, which
 * Next renders on demand per request ("You must always return an array from
 * generateStaticParams, even if it's empty. Otherwise, the route will be
 * dynamically rendered", generate-static-params.md in the shipped Next 16.3.3
 * docs). That is the mode this page wants, and the alternatives were rejected:
 * `dynamic = 'force-static'` and `generateStaticParams: () => []` both mean
 * "statically render all paths the first time they are visited", which puts one
 * cache entry per link id into the ISR store and lets a shared cache hold a
 * per-link response. The id is not enumerable at build time in any case: the
 * desktop app makes ids at run time. See
 * work/14-test-evidence/S1-WEB-01/next-docs-rendering-mode.md.
 *
 * The report address: rendering per request is also what lets the page read one
 * setting of the server it runs on, REQUEST_REPORT_EMAIL, which is where
 * "Report this link" writes on a server that is not floe.one
 * (lib/request/report.ts). The component below reads it, on the server, and
 * hands it down as a prop. It is not fetched: the page makes no request before
 * Send, and e2e/request-privacy.spec.ts holds it to that. It is not a
 * NEXT_PUBLIC_ name: those are inlined at build time, and the published image
 * is built once for every operator. The value is checked before it is handed
 * down, so what reaches the served page is one plain address or nothing, never
 * the text as it was typed. It is the server's setting and not the link's: the
 * component still takes no props, so the link id is still never in scope here.
 * lib/request/visitorBoundaries.test.ts pins each step.
 */
export const metadata: Metadata = {
    title: 'Send files',
    description: 'Send files to the person who made this Floe request link.',
    robots: {
        index: false,
        follow: false,
        nocache: true,
        googleBot: { index: false, follow: false },
    },
    alternates: {},
    referrer: 'no-referrer',
    openGraph: {
        ...sharedOpenGraph,
        title: 'Floe request link',
        description: 'Send files peer to peer. Nothing is stored on a Floe server.',
    },
    twitter: {
        ...sharedTwitter,
        title: 'Floe request link',
        description: 'Send files peer to peer. Nothing is stored on a Floe server.',
    },
};

/**
 * The page canvas, server-rendered OUTSIDE the guard. The guard renders nothing
 * until its mount effect has run, so without this the first frames of every
 * visit were the root layout's white body (measured 0.2 s at 1x CPU and 0.9 s
 * at 4x on next dev), the scrollbar drew in the light scheme, and elastic
 * overscroll showed white bands past the dark shell. Unlayered, so it beats the
 * base layer's `body { bg-background }`. zinc-950 is the shell's own color.
 *
 * It never reaches another page: /r is only ever entered or left by a document
 * load (plain anchors only, see RequestShell's footer), so no client-side
 * navigation carries this <style> along.
 *
 * Not here, on purpose: scrollbar-gutter. It would stop the card's 7.5 px
 * sideways step when a classic scrollbar comes or goes (a 1366 x 768 Ready is
 * taller than the window, Connecting is not), but the reserved gutter sits
 * outside the fixed backdrop and drew a plain band down the window's edges.
 */
const PAGE_CANVAS = 'html,body{background-color:oklch(14.1% 0.005 285.823);color-scheme:dark}';

export default function RequestLinkPage() {
    // The guard wraps the whole shell, not part of it. In-app browsers are where
    // file picking and WebRTC are least reliable, and the guard withholds its
    // children entirely rather than rendering them behind an overlay, which is
    // what stops a page inside a webview from acting on the link at all. Its
    // copy of location.href includes the fragment; that is correct here, because
    // the fragment is the visitor's own link.
    //
    // The notice's last sentence is this page's own. The guard's default says
    // "Chrome or Safari", which is right for a share link and wrong here, where
    // the support line reads "current Chrome and Edge on a computer". The steps
    // for leaving the app's browser stay, under a title of this page's own:
    // they open the phone's browser, which is not what the sentence asked
    // for, so the box says it is the other choice. The page that browser
    // opens states its support under the heading.
    return (
        <>
            <style>{PAGE_CANVAS}</style>
            <InAppBrowserGuard advice={visitorCopy.inAppAdvice} stepsTitle={visitorCopy.inAppStepsTitle}>
                <RequestShell reportAddress={configuredReportAddress(process.env.REQUEST_REPORT_EMAIL)} />
            </InAppBrowserGuard>
        </>
    );
}
