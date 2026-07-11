import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { ServiceWorkerRegistration } from '@/components/ServiceWorkerRegistration';
import Script from 'next/script';

// Public-facing base URL. Defaults to floe.one for the canonical deploy; set
// NEXT_PUBLIC_SITE_URL when self-hosting so canonical/OG/sitemap point at your
// own domain instead.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://www.floe.one';

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
    metadataBase: new URL(siteUrl),
    alternates: {
        canonical: '/',
    },
    openGraph: {
        title: 'Floe — Encrypted P2P File Transfer. No Uploads.',
        description:
            'Send files directly from your device to anyone in the world. No accounts, no file storage, no size limits on direct transfers. Fully end-to-end encrypted with WebRTC.',
        siteName: 'Floe',
        images: [
            {
                // Relative path resolves against metadataBase (siteUrl above).
                url: '/og.png?v=3',
                width: 1200,
                height: 630,
                alt: 'Floe — Encrypted peer-to-peer file transfer',
            },
        ],
        type: 'website',
        locale: 'en_US',
    },
    twitter: {
        card: 'summary_large_image',
        title: 'Floe — Encrypted P2P File Transfer. No Uploads.',
        description:
            'Send files directly from your device to anyone in the world. No accounts, no file storage, fully end-to-end encrypted.',
        images: ['/og.png?v=3'],
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
                            url: siteUrl,
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
