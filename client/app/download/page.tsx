import React from 'react';
import type { Metadata } from 'next';
import { Navbar } from '@/components/layout/Navbar';
import { Footer } from '@/components/layout/Footer';
import { AppWindow } from '@/components/landing/AppWindow';
import { DownloadCta } from './DownloadCta';
import {
    DESKTOP_VERSION,
    DESKTOP_RELEASE_DATE,
    DESKTOP_SETUP_URL,
    DESKTOP_ZIP_URL,
    DESKTOP_SHA_URL,
    DESKTOP_RELEASE_NOTES_URL,
    DESKTOP_RELEASE_PAGE_URL,
    ALL_RELEASES_URL,
} from '@/lib/desktopRelease';

// Utility-index download page: one Store badge CTA, one artifact, one quiet
// table, global chrome. The version, date, and every asset URL derive from
// lib/desktopRelease so a release bump touches exactly one file.
export const metadata: Metadata = {
    title: 'Download | Floe',
    // No "or use Floe in your browser" clause: the page's only CTA is the Store
    // badge and its body carries no route to "/", so promising a browser option
    // here would be advertising something this page does not offer.
    description:
        'Get Floe Desktop for Windows from the Microsoft Store (beta), or install the floe CLI: free, encrypted, peer-to-peer file transfer.',
    alternates: { canonical: '/download' },
};

const OTHER_WAYS: {
    label: string;
    desc: React.ReactNode;
    actions: { name: string; href: string; external?: boolean; umami?: Record<string, string> }[];
}[] = [
    {
        label: 'GitHub release',
        desc: (
            <>
                For machines without Store access: the installer and a portable zip (unzip and
                run <span className="font-mono text-[13px] text-zinc-400">floe-desktop.exe</span>).
                These builds are unsigned, so SmartScreen warns on first run: choose &quot;More
                info&quot;, then &quot;Run anyway&quot;.
            </>
        ),
        actions: [
            {
                name: 'Installer .exe',
                href: DESKTOP_SETUP_URL,
                external: true,
                umami: {
                    'data-umami-event': 'download-desktop',
                    'data-umami-event-file': 'installer',
                },
            },
            {
                name: 'Portable .zip',
                href: DESKTOP_ZIP_URL,
                external: true,
                umami: {
                    'data-umami-event': 'download-desktop',
                    'data-umami-event-file': 'zip',
                },
            },
        ],
    },
    {
        label: 'Command line',
        desc: 'A single static binary for servers, scripts, and headless machines.',
        actions: [
            {
                name: 'Install guide',
                href: 'https://www.floe.one/docs/cli/installation',
                external: true,
                umami: { 'data-umami-event': 'download-page-cli' },
            },
        ],
    },
    {
        label: 'Checksums',
        desc: 'SHA-256 sums for every asset, this release on GitHub, and the full release history.',
        actions: [
            { name: 'SHA256SUMS.txt', href: DESKTOP_SHA_URL, external: true },
            { name: 'This release', href: DESKTOP_RELEASE_PAGE_URL, external: true },
            { name: 'All releases', href: ALL_RELEASES_URL, external: true },
        ],
    },
    {
        label: 'Feedback',
        desc: 'Found a bug in the beta? A report is the most useful thing you can send.',
        actions: [
            {
                name: 'Open an issue',
                href: 'https://github.com/jannskiee/floe/issues',
                external: true,
            },
        ],
    },
];

export default function Download() {
    return (
        <div className="flex min-h-dvh flex-col items-center bg-zinc-950 font-sans text-zinc-100 px-[max(1rem,env(safe-area-inset-left),env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-[max(1.5rem,env(safe-area-inset-left),env(safe-area-inset-right))] sm:pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            <Navbar />

            <main className="w-full max-w-5xl">
                {/* Hero: static server HTML throughout. The CTA row used to be a
                    client island so it could sniff the OS and lead non-Windows
                    visitors with a web-app pill; that pill is gone, so the whole
                    page is server-rendered again. */}
                {/* pt-24/28, not 28/32: the fixed navbar ends around 74px, so the old
                    values left ~55px of dead space before the first word. */}
                <div className="flex flex-col items-center pt-24 text-center sm:pt-28">
                    {/* text-ice, not zinc-100: every other eyebrow on the site is either the
                        ice accent (SectionHeader, and the privacy/terms page hero) or quiet
                        zinc-500. At zinc-100 this one rendered the exact same value as the h1
                        four pixels below it, so the eye met two headlines instead of a label
                        and its subject, and the hero carried no accent at all.
                        pl-[0.2em] repays the letter-space that tracking adds AFTER the final
                        glyph: centred letterspaced text otherwise sits half a space left of
                        true centre (measured 2.25px off the headline's ink). */}
                    {/* leading-none: an 11px label otherwise sits in a 16.5px line box, and
                        that dead half-leading reads as extra gap under the label. */}
                    <p className="pl-[0.2em] font-mono text-[11px] leading-none uppercase tracking-[0.2em] text-ice">
                        Download
                    </p>
                    {/* lg:text-6xl only: 320-1023px renders exactly as before, while on the
                        wide screens where the 1024px container leaves the most air the
                        headline gains the presence it was missing. */}
                    {/* mt-3, not mt-4: the headline's line box already carries ~14px of
                        leading above its caps, so the margin reads about double its value. */}
                    <h1 className="mt-3 text-4xl font-semibold tracking-tight text-zinc-100 sm:text-5xl lg:text-6xl">
                        Floe Desktop
                    </h1>
                    {/* max-w-lg + text-balance: at max-w-xl this set as a 540px line over a
                        102px orphan ("Windows app."), which under a centred headline is the
                        most visible flaw in the block. Balanced it resolves into two even
                        lines. mt-6 also tiers the rhythm 16/24/32 down to the CTA, so the
                        eyebrow binds to the headline instead of floating between beats. */}
                    <p className="mt-6 max-w-lg text-base leading-relaxed text-balance text-zinc-400">
                        The same encrypted, peer-to-peer transfer as floe.one, running as a native
                        Windows app.
                    </p>

                    <div className="mt-8">
                        <DownloadCta />
                    </div>

                    <p className="mt-6 font-mono text-xs text-zinc-500">
                        v{DESKTOP_VERSION} beta <span className="text-zinc-700">·</span>{' '}
                        {DESKTOP_RELEASE_DATE} <span className="text-zinc-700">·</span>{' '}
                        {/* whitespace-nowrap: when the meta line wraps at 320px the link
                            drops to the next line whole instead of splitting mid-label */}
                        <a
                            href={DESKTOP_RELEASE_NOTES_URL}
                            target="_blank"
                            rel="noreferrer"
                            className="whitespace-nowrap text-zinc-400 underline decoration-white/20 underline-offset-4 transition hover:text-zinc-200 hover:decoration-white/50 focus-visible:outline-2 focus-visible:outline-ice"
                        >
                            Release notes
                        </a>
                    </p>

                    <div className="mt-4 space-y-1 text-[13px] leading-relaxed text-zinc-400">
                        {/* Name the channel: the no-warnings/auto-update promise is true of
                            the Store build only, and this same page tells visitors two
                            sections later that the GitHub builds trip SmartScreen. The
                            version floor is what the MSIX manifest actually declares
                            (MinVersion 10.0.19041), not a generic "Windows 10 or later". */}
                        <p>From the Microsoft Store it installs with no warnings, and updates arrive automatically.</p>
                        <p>Requires Windows 10 version 2004 (build 19041) or later, 64-bit, with Microsoft WebView2.</p>
                    </div>
                </div>

                {/* The artifact: full container width, the fold cuts it */}
                <div className="mt-14 sm:mt-16">
                    <AppWindow
                        priority
                        // The shell pads 1.5rem from sm up, so the fallback is 100vw-3rem.
                        // Written as a bare vw term because Next's sizes parser only
                        // matches NNvw at a word boundary: inside calc(100vw - 2rem) it
                        // saw no vw at all and emitted all 15 candidates, down to 32w.
                        sizes="(min-width: 1072px) 1024px, 100vw"
                        className="shadow-[0_25px_50px_-12px_rgb(0_0_0/0.4),inset_0_1px_0_1px_rgba(255,255,255,0.024)]"
                    />
                </div>

                {/* The index: whitespace separates, no hairline slab */}
                <section className="mt-36 pb-14 sm:mt-40">
                    <h2 className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                        Other ways to run Floe
                    </h2>
                    <ul className="mt-2 divide-y divide-white/[0.06] border-y border-white/[0.06]">
                        {/* The 12-col rows wait for md: at 640 the side columns are only
                            ~124px, one font-metric wobble from clipping SHA256SUMS.txt;
                            every other grid on the site also splits at md or later. */}
                        {OTHER_WAYS.map((row) => (
                            <li
                                key={row.label}
                                className="grid gap-y-1.5 py-5 sm:py-6 md:grid-cols-12 md:items-baseline md:gap-x-8"
                            >
                                <span className="text-lg font-semibold tracking-tight text-zinc-100 md:col-span-3">
                                    {row.label}
                                </span>
                                <span className="text-sm leading-relaxed text-zinc-500 md:col-span-6">
                                    {row.desc}
                                </span>
                                <span className="flex flex-wrap gap-x-4 gap-y-1 md:col-span-3 md:justify-end">
                                    {row.actions.map((action) => (
                                        <a
                                            key={action.name}
                                            href={action.href}
                                            {...(action.external
                                                ? { target: '_blank', rel: 'noreferrer' }
                                                : {})}
                                            {...(action.umami ?? {})}
                                            className="inline-flex min-h-10 items-center text-sm font-medium text-zinc-300 transition hover:text-ice focus-visible:outline-2 focus-visible:outline-ice md:min-h-0"
                                        >
                                            {action.name}
                                        </a>
                                    ))}
                                </span>
                            </li>
                        ))}
                    </ul>
                </section>
            </main>

            <Footer />
        </div>
    );
}
