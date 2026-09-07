import React from 'react';
import type { Metadata } from 'next';
import { ArrowUpRight } from 'lucide-react';
import { Navbar } from '@/components/layout/Navbar';
import { Footer } from '@/components/layout/Footer';
import { RouteFigure } from '@/components/how-it-works/RouteFigure';
import { BADGE_DIRECT, BADGE_RELAY, RELAY_CAP } from '@/lib/howItWorksStrings';
import { sharedOpenGraph, sharedTwitter } from '@/lib/socialMetadata';

// The short version: one drawing, three beats, a pointer to the docs. This
// page summarizes; docs/how-it-works/* carries the depth. Under 300 words of
// visible copy on purpose, and every sentence is literally true of the current
// release (checked against docs/how-it-works/*.mdx, docs/security-privacy.mdx,
// client/lib/relay.ts, server/server.js, server/turn.js and
// cli/engine/transfer/relay.go on 2026-09-07).
//
// A Server Component with no client island: the figure's motion is CSS that
// plays once on paint (see the .hiw-* rules in globals.css), so
// e2e/hydration.spec.ts is satisfied by construction.
export const metadata: Metadata = {
    // Bare title: the "%s - Floe" template in app/layout.tsx adds the suffix.
    title: 'How It Works',
    description:
        "Floe's server introduces two devices, then leaves. What Direct and Relay mean, why relayed transfers are capped at 2 GB, and how every transfer is encrypted.",
    alternates: {
        canonical: '/how-it-works',
    },
    // Spread before overriding: a bare object here would replace the root's
    // whole openGraph block and drop the images with it. Sentence case, the
    // same string as the h1 and the 404's link to this page.
    openGraph: { ...sharedOpenGraph, title: 'How Floe works' },
    twitter: { ...sharedTwitter, title: 'How Floe works' },
};

const DOCS_SIGNALING = 'https://www.floe.one/docs/how-it-works/signaling';

// The six docs pages, in the order the line reads them. Each label is that
// page's own sidebarTitle, not an editorial shortening: a link that names a
// page by a title it does not have is the drift docs-check's `labels` check
// exists to catch, and it can only see a label when the href sits in the same
// object literal, so these are written out in full.
const DOCS_PAGES: { label: string; href: string }[] = [
    { label: 'How a transfer works', href: 'https://www.floe.one/docs/how-it-works/signaling' },
    { label: 'Direct connections', href: 'https://www.floe.one/docs/how-it-works/direct-connection' },
    { label: 'Relay fallback', href: 'https://www.floe.one/docs/how-it-works/relay-connection' },
    { label: 'File size limits', href: 'https://www.floe.one/docs/how-it-works/2gb-limit' },
    { label: 'Encryption', href: 'https://www.floe.one/docs/how-it-works/encryption' },
    { label: 'Known limitations', href: 'https://www.floe.one/docs/how-it-works/known-limitations' },
];

// zinc-400, not the zinc-500 the landing ledgers use for their labels: at 11px
// zinc-500 measures 4.12:1 on zinc-950, under the 4.5:1 AA minimum, and these
// four labels are informative copy. The legal pages made the same lift.
const LABEL = 'font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-400';

// The badge dot the app draws (ConnectionStatusBadge.tsx core dot, no halo):
// green means Direct, amber means Relay, and those are the only two colors on
// the page besides ice.
function Dot({ tone }: { tone: 'direct' | 'relay' }) {
    return (
        <span
            className={`h-1.5 w-1.5 rounded-full ${tone === 'direct' ? 'bg-green-500' : 'bg-amber-500'}`}
            aria-hidden="true"
        />
    );
}

export default function HowItWorks() {
    return (
        // Same centering flex shell as / and /download, so the shared <Footer />
        // gets identical width math on every page that renders it.
        <div className="flex min-h-dvh flex-col items-center bg-zinc-950 font-sans text-zinc-100 px-[max(1rem,env(safe-area-inset-left),env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-[max(1.5rem,env(safe-area-inset-left),env(safe-area-inset-right))] sm:pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            <Navbar />

            <main className="w-full max-w-5xl">
                {/* Left-aligned, unlike the centered /download hero: the line
                    below starts under these words, at YOU. pt-24/28 clears the
                    fixed pill; leading-none on the eyebrow drops its dead
                    half-leading; mt-3 offsets the headline's own leading. */}
                <header className="pt-[calc(6rem_+_env(safe-area-inset-top))] sm:pt-[calc(7rem_+_env(safe-area-inset-top))]">
                    <p className="font-mono text-[11px] leading-none uppercase tracking-[0.2em] text-ice">
                        The short version
                    </p>
                    <h1 className="mt-3 text-4xl font-semibold tracking-tight text-zinc-100 sm:text-5xl lg:text-6xl">
                        How Floe works
                    </h1>
                    <p className="mt-6 max-w-lg text-base leading-relaxed text-balance text-zinc-400">
                        Two devices, one line between them. A server makes the introduction and
                        leaves. Most transfers go straight across. When a network blocks the way, the
                        transfer can take a relay instead, capped at{' '}
                        <span className="whitespace-nowrap">{RELAY_CAP}</span> per session.
                    </p>
                </header>

                <RouteFigure />

                {/* Three beats in the line's order. md, not sm: at 640 three text
                    columns would be a 22ch measure. Below md they stack, and each
                    one keeps the hero lede's max-w-lg so a 719px column at 767 does
                    not set 14px type across 105 characters; from md the grid
                    columns are 218px and the cap never binds. The badge tooltips in
                    the app deep-link to #direct and #relay and the over-limit
                    notice to #size-limit; each scroll margin clears the pill,
                    inset included. */}
                <div className="mt-12 grid gap-8 md:grid-cols-3">
                    <section className="max-w-lg scroll-mt-[calc(7rem_+_env(safe-area-inset-top))]">
                        {/* No spacer standing in for the dot the other two labels
                            carry. It bought a shared left edge across the row and
                            cost this label alignment with the heading directly under
                            it, which is the comparison the eye actually makes: a
                            14px indent under nothing reads as a mistake, while the
                            other two are indented by a dot that explains it. */}
                        <p className={`flex items-center gap-2 ${LABEL}`}>Signaling</p>
                        <h2 className="mt-3 text-base font-medium text-zinc-100">
                            <span className="sr-only">Signaling. </span>The server introduces, then
                            leaves.
                        </h2>
                        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                            It puts your two devices in a room and passes the offer, the answer, and each
                            side&apos;s network addresses between them. Once the connection opens, no file
                            data goes back through it.
                        </p>
                    </section>
                    <section id="direct" className="max-w-lg scroll-mt-[calc(7rem_+_env(safe-area-inset-top))]">
                        <p className={`flex items-center gap-2 ${LABEL}`}>
                            <Dot tone="direct" />
                            {BADGE_DIRECT}
                        </p>
                        <h2 className="mt-3 text-base font-medium text-zinc-100">
                            <span className="sr-only">Direct. </span>Straight across, most of the time.
                        </h2>
                        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                            Device to device, with no server carrying the file. There is no size limit,
                            and speed is whatever the slower of your two connections allows. The badge
                            shows {BADGE_DIRECT} with a green dot.
                        </p>
                    </section>
                    <section id="relay" className="max-w-lg scroll-mt-[calc(7rem_+_env(safe-area-inset-top))]">
                        <p className={`flex items-center gap-2 ${LABEL}`}>
                            <Dot tone="relay" />
                            {BADGE_RELAY}
                        </p>
                        <h2 className="mt-3 text-base font-medium text-zinc-100">
                            <span className="sr-only">Relay. </span>The detour, when the way is blocked.
                        </h2>
                        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                            A TURN relay both devices can reach forwards encrypted packets it cannot read;
                            on floe.one that relay is Cloudflare&apos;s. The badge shows {BADGE_RELAY} with
                            an amber dot.
                        </p>
                        <p id="size-limit" className="mt-3 scroll-mt-[calc(7rem_+_env(safe-area-inset-top))] text-sm leading-relaxed text-zinc-400">
                            Relay bandwidth costs money, so a relayed session is capped at{' '}
                            <span className="whitespace-nowrap">{RELAY_CAP}</span>. The sender checks once,
                            before any file data moves; exactly{' '}
                            <span className="whitespace-nowrap">{RELAY_CAP}</span> passes.
                        </p>
                    </section>
                </div>

                {/* Encryption is not a beat on the line, it is true of every route,
                    so it sits alone, one shade lighter than the captions, with
                    whitespace rather than a hairline separating it. */}
                <div className="mt-14 max-w-lg">
                    <p className={LABEL}>On every route</p>
                    <p className="mt-3 text-base leading-relaxed text-pretty text-zinc-300">
                        Every transfer is encrypted end to end with WebRTC&apos;s DTLS. The keys exist only
                        on the two devices, and no file is stored on any server. The browser, Floe Desktop
                        for Windows, and the CLI all speak the same protocol.
                    </p>
                </div>

                {/* The page's one hairline besides the footer's: the handoff to the
                    docs, which carry the depth this page leaves out. */}
                <section className="mt-28 border-t border-white/[0.06] pt-12 sm:mt-32 sm:pt-14">
                    <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 sm:text-3xl">
                        Want the full technical detail?
                    </h2>
                    <p className="mt-4 max-w-lg text-base leading-relaxed text-zinc-400">
                        Six pages take each stop on the line apart at depth, the known limitations
                        included.
                    </p>
                    <div className="mt-8">
                        <a
                            href={DOCS_SIGNALING}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex min-h-10 items-center gap-1.5 rounded-full bg-white px-4 py-2 text-sm font-bold text-black transition hover:bg-zinc-200 focus-visible:outline-2 focus-visible:outline-ice"
                        >
                            Read the full breakdown
                            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                        </a>
                    </div>
                    {/* role="list": Tailwind's preflight strips list markers and Safari
                        drops list semantics with them. */}
                    <ul role="list" className="mt-8 grid gap-y-3 md:grid-cols-3 md:gap-x-8">
                        {DOCS_PAGES.map((page, i) => (
                            <li key={page.href}>
                                <a
                                    href={page.href}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="group inline-flex min-h-10 items-center gap-3 text-sm font-medium text-zinc-300 transition hover:text-ice focus-visible:outline-2 focus-visible:outline-ice md:min-h-0"
                                >
                                    <span className="font-mono text-xs text-zinc-600" aria-hidden="true">
                                        {String(i + 1).padStart(2, '0')}
                                    </span>
                                    {page.label}
                                    <ArrowUpRight
                                        className="h-3.5 w-3.5 text-zinc-500 transition group-hover:text-ice"
                                        aria-hidden="true"
                                    />
                                </a>
                            </li>
                        ))}
                    </ul>
                </section>
            </main>

            <Footer />
        </div>
    );
}
