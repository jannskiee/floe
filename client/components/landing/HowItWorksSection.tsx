import React, { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { SectionHeader, sectionClass } from './SectionHeader';

const steps: { index: string; title: string; body: ReactNode }[] = [
    {
        index: '01',
        title: 'Drop your files',
        body: 'You get a share link and a QR code. The room id rides the URL fragment, which never appears in page requests, server logs, or analytics.',
    },
    {
        index: '02',
        title: 'Share either one',
        body: 'Your peer opens the link in any browser, scans the QR, or pastes the link into the desktop app or the CLI. No account on either side.',
    },
    {
        index: '03',
        title: 'Watch it stream',
        body: 'Bytes move device to device over the encrypted channel. Close the tab and the transfer stops. Nothing is left behind.',
    },
];

export function HowItWorksSection() {
    return (
        // mt-0!: this section's top hairline sits at the hero's fold as the scroll cue
        <section id="about" className={`${sectionClass} mt-0!`}>
            <SectionHeader
                eyebrow="How it works"
                headline="Your files never make a stop."
                lede="Two devices open an encrypted WebRTC channel and stream bytes to each other. The signaling server brokers the handshake, then steps out of the way."
            />
            {/* md, not sm: 640-767px would give ~155px text columns (a ~22ch measure)
                while PrivacySection next door is still single-column; every landing
                grid now splits at md or later. */}
            <div className="mt-12 grid gap-10 md:grid-cols-3 md:gap-8">
                {steps.map((step) => (
                    <div key={step.index} className="border-l border-white/10 pl-5">
                        <span className="font-mono text-xs text-zinc-600">{step.index}</span>
                        <h3 className="mt-3 text-base font-medium text-zinc-100">{step.title}</h3>
                        <p className="mt-2 text-sm leading-relaxed text-zinc-400">{step.body}</p>
                    </div>
                ))}
            </div>
            {/* The route this section summarizes had exactly one way in from the
                site chrome, a footer link far below the fold: the navbar pill
                labeled About scrolls to this section rather than to the page.
                ArrowRight, not the ArrowUpRight the Privacy link next door
                carries. Every ArrowUpRight in the client sits on a link that
                leaves the site, six for six, so it has come to mean exactly
                that; this one stays on floe.one, and a forward arrow says so. */}
            <div className="mt-10">
                <Link
                    href="/how-it-works"
                    className="group inline-flex min-h-10 items-center gap-1.5 text-sm text-zinc-300 transition hover:text-ice focus-visible:outline-2 focus-visible:outline-ice md:min-h-0"
                >
                    Read the overview
                    <ArrowRight className="h-3.5 w-3.5 text-zinc-500 transition group-hover:text-ice" />
                </Link>
            </div>
        </section>
    );
}
