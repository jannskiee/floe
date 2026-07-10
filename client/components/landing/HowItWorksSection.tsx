import React, { ReactNode } from 'react';
import { SectionHeader, sectionClass } from './SectionHeader';

const steps: { index: string; title: string; body: ReactNode }[] = [
    {
        index: '01',
        title: 'Drop your files',
        body: (
            <>
                You get a link and a short code like{' '}
                <code className="font-mono text-[12px] text-zinc-300">olive-tiger-castle</code>. The
                room secret lives in the URL fragment, so it never reaches the server.
            </>
        ),
    },
    {
        index: '02',
        title: 'Share either one',
        body: 'Your peer opens the link in any browser, or types the code into the CLI. No account on either side.',
    },
    {
        index: '03',
        title: 'Watch it stream',
        body: 'Bytes move device to device over the encrypted channel. Close the tab and the transfer stops. Nothing is left behind.',
    },
];

export function HowItWorksSection() {
    return (
        <section id="about" className={sectionClass}>
            <SectionHeader
                eyebrow="How it works"
                headline="Your files never make a stop."
                lede="Two devices open an encrypted WebRTC channel and stream bytes directly to each other. The signaling server brokers the handshake, then steps out of the way."
            />
            <div className="mt-12 grid gap-10 sm:grid-cols-3 sm:gap-8">
                {steps.map((step) => (
                    <div key={step.index} className="border-l border-white/10 pl-5">
                        <span className="font-mono text-xs text-zinc-600">{step.index}</span>
                        <h3 className="mt-3 text-base font-medium text-zinc-100">{step.title}</h3>
                        <p className="mt-2 text-sm leading-relaxed text-zinc-400">{step.body}</p>
                    </div>
                ))}
            </div>
        </section>
    );
}
