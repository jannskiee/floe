import React from 'react';
import { Navbar } from '@/components/layout/Navbar';
import { AboutSection } from '@/components/layout/AboutSection';
import { FAQSection } from '@/components/layout/FAQSection';
import { Footer } from '@/components/layout/Footer';
import { GlobalStats } from '@/components/GlobalStats';
import { P2PTransfer } from '@/components/P2PTransfer';
import { InAppBrowserGuard } from '@/components/InAppBrowserGuard';

export default function Home() {
    return (
        <div className="flex min-h-screen flex-col items-center bg-zinc-950 font-sans text-zinc-100 p-4 sm:p-6 pt-28 sm:pt-32">
            <Navbar />

            <div className="mx-auto max-w-3xl text-center mb-8 space-y-4">
                <h1 className="text-5xl sm:text-7xl font-extrabold tracking-tighter text-white lg:text-9xl drop-shadow-2xl">
                    Floe
                </h1>
                <p className="mt-4 text-lg leading-8 text-zinc-400 max-w-lg mx-auto">
                    Secure, encrypted P2P file transfer.{' '}
                    <br className="hidden sm:inline" />
                    No accounts, no file storage, and no registration required.
                </p>
            </div>

            <InAppBrowserGuard>
                <P2PTransfer />
            </InAppBrowserGuard>
            <GlobalStats />
            <AboutSection />
            <FAQSection />

            <Footer />
        </div>
    );
}
