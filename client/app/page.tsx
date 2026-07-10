import React from 'react';
import { Navbar } from '@/components/layout/Navbar';
import { HowItWorksSection } from '@/components/landing/HowItWorksSection';
import { PrivacySection } from '@/components/landing/PrivacySection';
import { CliSection } from '@/components/landing/CliSection';
import { CapabilitiesSection } from '@/components/landing/CapabilitiesSection';
import { FAQSection } from '@/components/layout/FAQSection';
import { Footer } from '@/components/layout/Footer';
import { GlobalStats } from '@/components/GlobalStats';
import { P2PTransfer } from '@/components/P2PTransfer';
import { InAppBrowserGuard } from '@/components/InAppBrowserGuard';

export default function Home() {
    return (
        <div className="flex min-h-dvh flex-col items-center bg-zinc-950 font-sans text-zinc-100 px-4 pb-4 sm:px-6 sm:pb-6">
            <Navbar />

            {/* Full-viewport hero: sections below only appear on scroll */}
            <section className="relative flex min-h-dvh w-full flex-col items-center justify-center pb-14 pt-24 sm:pt-28">
                <div className="mx-auto max-w-3xl text-center mb-8 space-y-4">
                    <h1 className="text-5xl sm:text-7xl font-extrabold tracking-tighter text-white lg:text-9xl drop-shadow-2xl">
                        Floe
                    </h1>
                    <p className="mt-4 text-lg leading-8 text-zinc-300 max-w-lg mx-auto">
                        Secure, encrypted P2P file transfer.{' '}
                        <br className="hidden sm:inline" />
                        <span className="text-zinc-500">
                            No accounts, no file storage, and no registration required.
                        </span>
                    </p>
                </div>

                <InAppBrowserGuard>
                    <P2PTransfer />
                </InAppBrowserGuard>
                <GlobalStats />

                {/* Quiet scroll hint: a vertical hairline strengthening downward */}
                <div
                    aria-hidden="true"
                    className="absolute bottom-6 left-1/2 hidden h-10 w-px -translate-x-1/2 bg-gradient-to-b from-transparent to-white/25 sm:block"
                />
            </section>

            <HowItWorksSection />
            <PrivacySection />
            <CliSection />
            <CapabilitiesSection />
            <FAQSection />

            <Footer />
        </div>
    );
}
