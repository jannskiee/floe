import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { ServiceWorkerRegistration } from '@/components/ServiceWorkerRegistration';
import Script from 'next/script';

import { siteUrl, metadataBase } from '@/lib/siteUrl';

const geistSans = Geist({
    variable: '--font-geist-sans',
    subsets: ['latin'],
});

const geistMono = Geist_Mono({
    variable: '--font-geist-mono',
    subsets: ['latin'],
});

export const metadata: Metadata = {
    title: 'Floe',
    description:
        'Send files directly to anyone. No uploads, no accounts, end-to-end encrypted. Works on any device, any browser.',
    metadataBase,
    // Left unconditional on purpose. Next passes a RELATIVE canonical through
    // verbatim when metadataBase is null, so this stays a valid self-referencing
    // canonical on whatever host serves it.
    alternates: {
        canonical: '/',
    },
    openGraph: {
        title: 'Floe — Encrypted P2P File Transfer. No Uploads.',
        description:
            'Send files directly from your device to anyone in the world. No accounts, no file storage, no size limits on direct transfers. Fully end-to-end encrypted with WebRTC.',
        siteName: 'Floe',
        // Images are the opposite case to canonical: a relative image with no
        // metadataBase resolves against http://localhost:3000, which renders
        // nothing in a link preview. Omitting beats emitting a broken URL.
        //
        // Both image arrays must stay conditional TOGETHER. Next copies the
        // resolved Open Graph images into twitter when twitter declares none, so
        // dropping only one of them still leaks localhost into the other.
        images: siteUrl
            ? [
                  {
                      // Relative path resolves against metadataBase above.
                      url: '/og.png?v=3',
                      width: 1200,
                      height: 630,
                      alt: 'Floe — Encrypted peer-to-peer file transfer',
                  },
              ]
            : undefined,
        type: 'website',
        locale: 'en_US',
    },
    twitter: {
        // Without an image, a large-image card renders as an empty box.
        card: siteUrl ? 'summary_large_image' : 'summary',
        title: 'Floe — Encrypted P2P File Transfer. No Uploads.',
        description:
            'Send files directly from your device to anyone in the world. No accounts, no file storage, fully end-to-end encrypted.',
        images: siteUrl ? ['/og.png?v=3'] : undefined,
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
