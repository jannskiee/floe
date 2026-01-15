import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { ServiceWorkerRegistration } from '@/components/ServiceWorkerRegistration';

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
    description: 'Secure, serverless P2P file transfer. No size limits, no registration, end-to-end encrypted.',
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
            </body>
        </html>
    );
}
