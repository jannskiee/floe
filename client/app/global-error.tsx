'use client';

import * as Sentry from '@sentry/nextjs';
import { Geist } from 'next/font/google';
import { useEffect } from 'react';
import './globals.css';

// The screen for an error nothing below the root layout caught. It replaces
// the root layout, <html> and all, so it brings the site's stylesheet, font
// and dark shell itself. It used to render Next's built-in, a white page with
// Next's own words and a "Try again" that re-rendered the same failure, in the
// middle of a dark site (A9-B12). The navbar is left out on purpose: the error
// may have come from it.
//
// The action is a reload, not reset(): a transfer page that failed this badly
// has nothing worth keeping, and a fresh load is what clears it.
const geistSans = Geist({
    variable: '--font-geist-sans',
    subsets: ['latin'],
});

export default function GlobalError({
    error,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        Sentry.captureException(error);
    }, [error]);

    return (
        <html lang="en">
            <body className={`${geistSans.variable} antialiased`}>
                {/* A layout cannot name this page: it has none. React moves
                    the title into <head>, and the " - Floe" suffix is written
                    out here for the same reason. */}
                <title>Something Went Wrong - Floe</title>
                <main className="flex min-h-dvh flex-col items-center justify-center bg-zinc-950 px-[max(1rem,env(safe-area-inset-left),env(safe-area-inset-right))] text-center font-sans text-zinc-100">
                    <h1 className="text-2xl font-semibold tracking-tight text-zinc-200 sm:text-[2rem]">
                        Something went wrong
                    </h1>
                    <p className="mt-4 max-w-md text-base leading-relaxed text-balance text-zinc-400">
                        Reload the page to try again.
                    </p>
                    <button
                        type="button"
                        onClick={() => window.location.reload()}
                        className="mt-9 inline-flex min-h-11 items-center rounded-full bg-white px-5 py-2 text-sm font-bold text-black transition hover:bg-zinc-200 focus-visible:outline-2 focus-visible:outline-ice"
                    >Reload page</button>
                </main>
            </body>
        </html>
    );
}
