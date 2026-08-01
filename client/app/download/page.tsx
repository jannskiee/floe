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
    ALL_RELEASES_URL,
} from '@/lib/desktopRelease';

// Utility-index download page: one Store badge CTA, one artifact, one quiet
// table, global chrome. The version, date, and every asset URL derive from
// lib/desktopRelease so a release bump touches exactly one file.
export const metadata: Metadata = {
    title: 'Download | Floe',
    description:
        'Get Floe Desktop for Windows from the Microsoft Store (beta), install the CLI, or use Floe in your browser: free, encrypted, peer-to-peer file transfer.',
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
        desc: 'SHA-256 sums for every asset, and the full release history.',
        actions: [
            { name: 'SHA256SUMS.txt', href: DESKTOP_SHA_URL, external: true },
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
                {/* Hero: static server HTML; only the CTA row is a client island */}
                <div className="flex flex-col items-center pt-28 text-center sm:pt-32">
                    <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ice">
                        Download
                    </p>
                    <h1 className="mt-4 text-4xl font-semibold tracking-tight text-zinc-100 sm:text-5xl">
                        Floe Desktop.
                    </h1>
                    <p className="mt-5 max-w-xl text-base leading-relaxed text-zinc-400">
                        The same encrypted, peer-to-peer transfer as floe.one, running as a native
                        Windows app.
                    </p>

                    <div className="mt-8">
                        <DownloadCta />
                    </div>

                    <p className="mt-6 font-mono text-xs text-zinc-500">
                        v{DESKTOP_VERSION} beta <span className="text-zinc-700">·</span>{' '}
                        {DESKTOP_RELEASE_DATE} <span className="text-zinc-700">·</span>{' '}
                        <a
                            href={DESKTOP_RELEASE_NOTES_URL}
                            target="_blank"
                            rel="noreferrer"
                            className="text-zinc-400 underline decoration-white/20 underline-offset-4 transition hover:text-zinc-200 hover:decoration-white/50 focus-visible:outline-2 focus-visible:outline-ice"
                        >
                            Release notes
                        </a>
                    </p>

                    <div className="mt-4 space-y-1 text-[13px] leading-relaxed text-zinc-400">
                        <p>Requires Windows 10 or later, 64-bit, with Microsoft WebView2.</p>
                        <p>
                            Installs from the Microsoft Store: no warnings, and updates arrive
                            automatically.
                        </p>
                    </div>
                </div>

                {/* The artifact: full container width, the fold cuts it */}
                <div className="mt-14 sm:mt-16">
                    <AppWindow
                        priority
                        className="shadow-[0_25px_50px_-12px_rgb(0_0_0/0.4),inset_0_1px_0_1px_rgba(255,255,255,0.024)]"
                    />
                </div>

                {/* The index: whitespace separates, no hairline slab */}
                <section className="mt-36 pb-14 sm:mt-40">
                    <h2 className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                        Other ways to run Floe
                    </h2>
                    <ul className="mt-2 divide-y divide-white/[0.06] border-y border-white/[0.06]">
                        {OTHER_WAYS.map((row) => (
                            <li
                                key={row.label}
                                className="grid gap-y-1.5 py-5 sm:grid-cols-12 sm:items-baseline sm:gap-x-8 sm:py-6"
                            >
                                <span className="text-lg font-semibold tracking-tight text-zinc-100 sm:col-span-3">
                                    {row.label}
                                </span>
                                <span className="text-sm leading-relaxed text-zinc-500 sm:col-span-6">
                                    {row.desc}
                                </span>
                                <span className="flex flex-wrap gap-x-3 gap-y-1 sm:col-span-3 sm:justify-end">
                                    {row.actions.map((action) => (
                                        <a
                                            key={action.name}
                                            href={action.href}
                                            {...(action.external
                                                ? { target: '_blank', rel: 'noreferrer' }
                                                : {})}
                                            {...(action.umami ?? {})}
                                            className="text-sm font-medium text-zinc-300 transition hover:text-ice focus-visible:outline-2 focus-visible:outline-ice"
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
