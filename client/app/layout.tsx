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
    metadataBase: new URL('https://floe.one'),
    alternates: {
        canonical: '/',
    },
    openGraph: {
        title: 'Floe — Encrypted P2P File Transfer. No Uploads.',
        description:
            'Send files directly from your device to anyone in the world. No accounts, no file storage, no size limits on direct transfers. Fully end-to-end encrypted with WebRTC.',
        url: 'https://floe.one',
        siteName: 'Floe',
        images: [
            {
                url: 'https://floe.one/og.png',
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
        title: 'Floe \u2014 Encrypted P2P File Transfer. No Uploads.',
        description:
            'Send files directly from your device to anyone in the world. No accounts, no file storage, fully end-to-end encrypted.',
        images: ['https://floe.one/og.png'],
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
            </body>
        </html>
    );
}
