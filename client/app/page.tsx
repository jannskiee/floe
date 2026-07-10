import React from 'react';
import { ChevronDown } from 'lucide-react';
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

                <a
                    href="#about"
                    aria-label="Scroll to learn how Floe works"
                    className="absolute bottom-4 left-1/2 hidden -translate-x-1/2 rounded-full p-2 text-zinc-700 transition hover:text-zinc-400 focus-visible:outline-2 focus-visible:outline-ice sm:block"
                >
                    <ChevronDown className="h-4 w-4 animate-bounce motion-reduce:animate-none" aria-hidden="true" />
                </a>
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
