import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { ServiceWorkerRegistration } from '@/components/ServiceWorkerRegistration';
import Script from 'next/script';

import { siteUrl, metadataBase } from '@/lib/siteUrl';
import { sharedOpenGraph, sharedTwitter } from '@/lib/socialMetadata';

const geistSans = Geist({
    variable: '--font-geist-sans',
    subsets: ['latin'],
});

const geistMono = Geist_Mono({
    variable: '--font-geist-mono',
    subsets: ['latin'],
});

export const metadata: Metadata = {
    // A template object, not a plain string. Two distinct jobs:
    //   default  what "/" renders (app/page.tsx exports no metadata of its own),
    //            AND the fallback for any future segment that forgets a title.
    //   template applied to CHILD segments only, never to the segment that
    //            declares it, so "/" renders `default` verbatim rather than
    //            "Floe - Floe". Next stashes the parent template only for items
    //            before the last two, and "/" resolves to just
    //            [root layout, page], so it never sees one.
    //
    // The separator is " - " and it is not a free choice. The docs at /docs are
    // a Mintlify deployment (see the rewrite in next.config.mjs) that renders
    // "{page title} - {name}" from docs/docs.json and offers no way to configure
    // it. Any other separator here splits the site's tab titles across two
    // conventions at the exact boundary a visitor crosses most often. Before
    // this template existed every page hand-wrote its own suffix, and they
    // drifted: /download and /how-it-works shipped "| Floe" while /privacy and
    // /terms shipped "· Floe" (U+00B7 MIDDLE DOT).
    //
    // Pages below set a bare title and let this apply the suffix. A page that
    // ever needs to opt out entirely should use `title: { absolute: '...' }`.
    title: {
        default: 'Floe',
        template: '%s - Floe',
    },
    description:
        'Send files directly to anyone. No uploads, no accounts, end-to-end encrypted. Works in your browser, as a Windows desktop app, or from the CLI.',
    metadataBase,
    // Left unconditional on purpose. Next passes a RELATIVE canonical through
    // verbatim when metadataBase is null, so this stays a valid self-referencing
    // canonical on whatever host serves it.
    alternates: {
        canonical: '/',
    },
    // siteName, type, locale and the conditional images now live in
    // lib/socialMetadata so the four child pages can spread them back in. They
    // have to: metadata merging is shallow, so a page that declares openGraph
    // replaces this whole object rather than merging into it.
    openGraph: {
        ...sharedOpenGraph,
        title: 'Floe: Encrypted P2P File Transfer. No Uploads.',
        description:
            'Send files directly from your device to anyone in the world. No accounts, no file storage, no size limits on direct transfers. Fully end-to-end encrypted with WebRTC.',
    },
    twitter: {
        ...sharedTwitter,
        title: 'Floe: Encrypted P2P File Transfer. No Uploads.',
        description:
            'Send files directly from your device to anyone in the world. No accounts, no file storage, fully end-to-end encrypted.',
    },
};

export const viewport: Viewport = {
    themeColor: '#0a0a0a',
    // Extend the dark backdrop under notches and rounded corners; safe-area
    // padding on the navbar and page root keeps content clear of them.
    viewportFit: 'cover',
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en" suppressHydrationWarning className="scroll-smooth">
            <body
                suppressHydrationWarning={true}
                className={`${geistSans.variable} ${geistMono.variable} antialiased`}
            >
                <ServiceWorkerRegistration />
                {children}
                {process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID && (
                    <Script
                        defer
                        src="https://cloud.umami.is/script.js"
                        data-website-id={process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID}
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
                )}
                {/* JSON-LD structured data: tells Google this is a free web application */}
                <script
                    type="application/ld+json"
                    dangerouslySetInnerHTML={{
                        __html: JSON.stringify({
                            '@context': 'https://schema.org',
                            '@type': 'WebApplication',
                            name: 'Floe',
                            // Omitted entirely when the origin is unknown. This
                            // block is hand-rolled rather than part of the
                            // Metadata API, so nothing else would strip it.
                            ...(siteUrl && { url: siteUrl }),
                            description: 'Secure, encrypted P2P file transfer. No accounts, no file storage, no registration required.',
                            applicationCategory: 'UtilitiesApplication',
                            operatingSystem: 'Any',
                            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
                            browserRequirements: 'Requires a modern browser with WebRTC support',
                        }),
                    }}
                />
            </body>
        </html>
    );
}
