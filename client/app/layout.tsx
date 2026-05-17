import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { ServiceWorkerRegistration } from '@/components/ServiceWorkerRegistration';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/next';

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
    metadataBase: new URL('https://www.floe.one'),
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
                url: 'https://www.floe.one/og.png?v=3',
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
        images: ['https://www.floe.one/og.png?v=3'],
    },
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body
                suppressHydrationWarning={true}
                className={`${geistSans.variable} ${geistMono.variable} antialiased`}
            >
                <ServiceWorkerRegistration />
                {children}
                <Analytics />
                <SpeedInsights />
                {/* JSON-LD structured data: tells Google this is a free web application */}
                <script
                    type="application/ld+json"
                    dangerouslySetInnerHTML={{
                        __html: JSON.stringify({
                            '@context': 'https://schema.org',
                            '@type': 'WebApplication',
                            name: 'Floe',
                            url: 'https://www.floe.one',
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
