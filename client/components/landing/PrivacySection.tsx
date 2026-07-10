import React, { ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { SectionHeader, sectionClass } from './SectionHeader';

const handled: ReactNode[] = [
    'WebRTC offers, answers, and ICE candidates',
    'A short room code that expires after 10 minutes',
    'Short-lived TURN relay credentials',
    'One anonymous running total of bytes for the public counter',
];

const neverSees: ReactNode[] = [
    'Your files, file names, or folder structure',
    <>
        The room secret. The <code className="font-mono text-[12px] text-zinc-300">#room</code>{' '}
        fragment stays in your browser
    </>,
    'Who is sending and who is receiving',
    'Relayed traffic in the clear. Relay packets stay encrypted end to end',
];

function LedgerColumn({
    label,
    marker,
    markerClass,
    items,
}: {
    label: string;
    marker: string;
    markerClass: string;
    items: ReactNode[];
}) {
    return (
        <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">{label}</p>
            <ul className="mt-5 border-t border-white/[0.06]">
                {items.map((item, i) => (
                    <li
                        key={i}
                        className="flex items-baseline gap-3 border-b border-white/[0.06] py-3.5 text-sm leading-relaxed text-zinc-400"
                    >
                        <span className={`select-none font-mono text-xs ${markerClass}`} aria-hidden="true">
                            {marker}
                        </span>
                        <span>{item}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export function PrivacySection() {
    return (
        <section className={sectionClass}>
            <SectionHeader
                eyebrow="Privacy"
                headline="The server can't read what it never receives."
                lede="Floe's signaling server exists to introduce two devices, and that is all it does. This is the complete list."
            />
            <div className="mt-12 grid gap-10 md:grid-cols-2 md:gap-12">
                <LedgerColumn
                    label="The signaling server handles"
                    marker="&rarr;"
                    markerClass="text-zinc-600"
                    items={handled}
                />
                <LedgerColumn
                    label="It never sees"
                    marker="&#10005;"
                    markerClass="text-ice/60"
                    items={neverSees}
                />
            </div>
            <div className="mt-10">
                <a
                    href="https://docs.floe.one/security-privacy"
                    target="_blank"
                    rel="noreferrer"
                    className="group inline-flex items-center gap-1.5 text-sm text-zinc-300 transition hover:text-ice"
                >
                    Read the security model
                    <ArrowUpRight className="h-3.5 w-3.5 text-zinc-500 transition group-hover:text-ice" />
                </a>
            </div>
        </section>
    );
}
