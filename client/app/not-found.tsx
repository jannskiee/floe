import React from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Navbar } from '@/components/layout/Navbar';

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
        // navbar and the footer row get identical width math. It is also what supplies
        // bg-zinc-950: the root layout's <body> carries only the font variables,
        // so a page that omits this renders zinc text on white.
        <div className="flex min-h-dvh flex-col items-center bg-zinc-950 font-sans text-zinc-100 px-[max(1rem,env(safe-area-inset-left),env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-[max(1.5rem,env(safe-area-inset-left),env(safe-area-inset-right))] sm:pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            <Navbar />

            <main className="flex w-full max-w-3xl flex-1 flex-col items-center justify-center pt-24 text-center sm:pt-28">
                {/* The numeral is the page's hero, set like the homepage wordmark
                    (extrabold, tight tracking, no shadow): the owner's pick A on
                    the 404 design canvas (2026-10-08). The heading still names
                    the page; the numeral is the first thing anyone reads. */}
                <p className="text-[clamp(7rem,18vw,14rem)] leading-[0.82] font-extrabold tracking-[-0.065em] text-zinc-100">
                    404
                </p>
                <h1 className="mt-9 text-2xl font-semibold tracking-tight text-zinc-200 sm:text-[2rem]">
                    Page not found
                </h1>
                <p className="mt-4 max-w-md text-base leading-relaxed text-balance text-zinc-400">
                    That link points at nothing here. If you were sent a share link, check that
                    you copied the whole thing.
                </p>
                <div className="mt-9 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
                    <Link
                        href="/"
                        className="inline-flex min-h-11 items-center rounded-full bg-white px-5 py-2 text-sm font-bold text-black transition hover:bg-zinc-200 focus-visible:outline-2 focus-visible:outline-ice"
                    >
                        Send a file
                    </Link>
                    <Link
                        href="/how-it-works"
                        className="inline-flex min-h-11 items-center text-sm font-medium text-zinc-300 transition hover:text-ice focus-visible:outline-2 focus-visible:outline-ice"
                    >
                        How Floe works
                    </Link>
                </div>
            </main>

            {/* A lost visitor needs a way back, not the site map: only the two
                legal pages, centered (the owner's comment on the 404 design
                canvas, 2026-10-08). The full <Footer /> stays on every other
                page. */}
            <footer className="mt-16 flex w-full max-w-6xl flex-wrap items-center justify-center gap-x-6 gap-y-1 border-t border-white/[0.06] pt-4 text-xs">
                <Link
                    href="/privacy"
                    className="inline-flex min-h-11 items-center text-zinc-400 transition hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-ice"
                >
                    Privacy
                </Link>
                <Link
                    href="/terms"
                    className="inline-flex min-h-11 items-center text-zinc-400 transition hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-ice"
                >
                    Terms
                </Link>
            </footer>
        </div>
    );
}
