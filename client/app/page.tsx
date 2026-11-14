import { Navbar } from '@/components/layout/Navbar';
import { HowItWorksSection } from '@/components/landing/HowItWorksSection';
import { PrivacySection } from '@/components/landing/PrivacySection';
import { CliSection } from '@/components/landing/CliSection';
import { DesktopSection } from '@/components/landing/DesktopSection';
import { CapabilitiesSection } from '@/components/landing/CapabilitiesSection';
import { FAQSection } from '@/components/layout/FAQSection';
import { Footer } from '@/components/layout/Footer';
import { GlobalStats } from '@/components/GlobalStats';
import { P2PTransfer } from '@/components/P2PTransfer';
import { InAppBrowserGuard } from '@/components/InAppBrowserGuard';
import { siteUrl } from '@/lib/siteUrl';
import { webApplicationJsonLd } from '@/lib/structuredData';

export default function Home() {
    return (
        // *:[--ring:...] draws keyboard focus on this page in ice, as
        // RequestShell does on /r (the owner chose option B, 2026-11-15).
        // The page has no .dark, so --ring is :root's gray. The Buttons, drop
        // zones and checkboxes name ice themselves (#913, #942); this reaches
        // the rest. A control with no focus style of its own (the Learn more
        // links, a file's Remove, the error's Dismiss) shows the browser's
        // outline in the base outline-ring/50: gray is about 2.7:1 against
        // the card, ice about 4:1. Chromium draws that outline (style auto)
        // with a white outer ring of its own, so there the change is the
        // tint. It is set on the children, as on /r, so it still holds if
        // this element ever takes .dark, whose unlayered rule would beat any
        // utility on the element itself.
        <div className="*:[--ring:var(--color-ice)] flex min-h-dvh flex-col items-center bg-zinc-950 font-sans text-zinc-100 px-[max(1rem,env(safe-area-inset-left),env(safe-area-inset-right))] pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-[max(1.5rem,env(safe-area-inset-left),env(safe-area-inset-right))] sm:pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            <Navbar />

            {/* Near-full-viewport hero: the next section's top hairline peeks at the
                fold as the scroll cue, while its content stays below it */}
            <section className="relative flex min-h-[calc(100dvh-2rem)] w-full flex-col items-center justify-center pb-14 pt-24 sm:pt-28">
                <div className="mx-auto max-w-3xl text-center mb-8 space-y-4">
                    <h1 className="text-5xl sm:text-7xl font-extrabold tracking-tighter text-white lg:text-9xl drop-shadow-2xl">
                        Floe
                    </h1>
                    <p className="mt-4 text-lg leading-8 text-zinc-300 max-w-lg mx-auto">
                        Secure, encrypted P2P file transfer.
                        <span className="block text-zinc-500">
                            No accounts, no file storage, and no registration required.
                        </span>
                    </p>
                </div>

                <InAppBrowserGuard>
                    <P2PTransfer />
                </InAppBrowserGuard>
                <GlobalStats />

            </section>

            <HowItWorksSection />
            <PrivacySection />
            <CliSection />
            <DesktopSection />
            <CapabilitiesSection />
            <FAQSection />

            <Footer />

            {/* JSON-LD: tells a search engine this page is a free web
                application. On the home page only: it describes the site,
                and in the root layout it also went out on the request link
                page, which is noindex and kept bare on purpose. */}
            <script
                type="application/ld+json"
                dangerouslySetInnerHTML={{ __html: webApplicationJsonLd(siteUrl) }}
            />
        </div>
    );
}
