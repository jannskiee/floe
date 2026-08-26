import React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Navbar } from '@/components/layout/Navbar';
import { Footer } from '@/components/layout/Footer';

// This file exists for its <title> as much as for its body.
//
// Without it, Next serves its built-in NotFound, which renders a bare
// <title>404: This page could not be found.</title> as JSX in the component
// body. React hoists that into <head>, where it lands AFTER the title the
// Metadata API already emitted from app/layout.tsx. Two <title> elements in one
// document: document.title is the FIRST in tree order, so the tab read "Floe"
// and the useful string sat inert two nodes later. Measured in
// .next/server/app/_not-found.html before this file existed.
//
// The built-in also injects `body{color:#000;background:#fff}`, which is why the
// old 404 was a white page in the middle of an otherwise zinc-950 site.
//
// The bare title below picks up the "%s - Floe" template from the root layout.
// That is worth stating because it is not obvious: Next builds /_not-found as a
// real route whose leaf page is this module, so the tree has three items and the
// parent template reaches it, exactly as it does for /download.
export const metadata: Metadata = {
    title: 'Page Not Found',
    description: 'That page does not exist. Send a file from the Floe home page instead.',
    // The root sets `alternates: { canonical: '/' }`, and metadata merging is
    // shallow, so without this a 404 declares the HOME PAGE as its canonical.
    // An empty object replaces that block and emits no <link> at all. The
    // noindex comes from the renderer rather than from here, keyed off the 404
    // status code, so it survives this override.
    alternates: {},
};

export default function NotFound() {
    return (
        // Same centering flex shell as /, /download and /how-it-works, so the
        // shared <Footer /> gets identical width math. It is also what supplies
        // bg-zinc-950: the root layout's <body> carries only the font variables,
        // so a page that omits this renders zinc text on white.
        <div className="flex min-h-dvh flex-col items-center bg-zinc-950 font-sans text-zinc-100 px-[max(1rem,env(safe-area-inset-left),env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-[max(1.5rem,env(safe-area-inset-left),env(safe-area-inset-right))] sm:pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            <Navbar />

            <main className="flex w-full max-w-3xl flex-1 flex-col items-center justify-center pt-24 text-center sm:pt-28">
                <p className="pl-[0.2em] font-mono text-[11px] leading-none uppercase tracking-[0.2em] text-ice">
                    404
                </p>
                <h1 className="mt-3 text-4xl font-semibold tracking-tight text-zinc-100 sm:text-5xl">
                    Page not found
                </h1>
                <p className="mt-6 max-w-md text-base leading-relaxed text-balance text-zinc-400">
                    That link points at nothing here. If you were sent a share link, check that
                    you copied the whole thing.
                </p>
                <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
                    <Link
                        href="/"
                        className="inline-flex min-h-10 items-center rounded-full bg-white px-4 py-2 text-sm font-bold text-black transition hover:bg-zinc-200 focus-visible:outline-2 focus-visible:outline-ice"
                    >
                        Send a file
                    </Link>
                    <Link
                        href="/how-it-works"
                        className="inline-flex min-h-10 items-center text-sm font-medium text-zinc-300 transition hover:text-ice focus-visible:outline-2 focus-visible:outline-ice"
                    >
                        How Floe works
                    </Link>
                </div>
            </main>

            <Footer />
        </div>
    );
}
