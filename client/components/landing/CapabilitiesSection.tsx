import React from 'react';
import {
    Activity,
    ArrowLeftRight,
    ArrowUpRight,
    FolderTree,
    Infinity as InfinityIcon,
    Scale,
    Server,
    LucideIcon,
} from 'lucide-react';
import { SectionHeader, sectionClass } from './SectionHeader';

const items: {
    icon: LucideIcon;
    title: string;
    body: string;
    href?: string;
}[] = [
    {
        icon: InfinityIcon,
        title: 'Unlimited direct transfers',
        body: 'No size cap on direct connections. Relayed sessions cap at 2 GB, and the badge shows which one you are on.',
    },
    {
        icon: ArrowLeftRight,
        title: 'Browser to terminal',
        body: 'The web app and the CLI share one protocol. Send from a server, receive on a phone, any direction.',
    },
    {
        icon: FolderTree,
        title: 'Folders stay folders',
        body: 'The CLI walks directories recursively and preserves their structure on the other side.',
    },
    {
        icon: Activity,
        title: 'Honest progress',
        body: 'Per-file bars with live speed and ETA, in the browser and in the terminal.',
    },
    {
        icon: Server,
        title: 'Self-hostable',
        body: 'Run your own signaling server and relay with Docker. The docs cover production setup.',
        href: 'https://www.floe.one/docs/self-hosting/overview',
    },
    {
        icon: Scale,
        title: 'Open source, MIT',
        body: 'Client, server, and CLI. Every line is on GitHub.',
        href: 'https://github.com/jannskiee/floe',
    },
];

export function CapabilitiesSection() {
    return (
        <section className={sectionClass}>
            <SectionHeader
                eyebrow="Capabilities"
                headline="No asterisks."
                lede="The fine print, printed large. Every claim below holds for the current release."
            />
            <div className="mt-12 grid border-l border-t border-white/[0.06] sm:grid-cols-2 lg:grid-cols-3">
                {items.map((item) => {
                    const content = (
                        <>
                            <item.icon className="h-4 w-4 text-zinc-500" aria-hidden="true" />
                            <h3 className="mt-4 text-sm font-medium text-zinc-100">{item.title}</h3>
                            <p className="mt-2 text-[13px] leading-relaxed text-zinc-400">{item.body}</p>
                        </>
                    );
                    const cellClass = 'border-b border-r border-white/[0.06] p-6';
                    return item.href ? (
                        <a
                            key={item.title}
                            href={item.href}
                            target="_blank"
                            rel="noreferrer"
                            className={`group relative block transition-colors hover:bg-white/[0.02] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ice ${cellClass}`}
                        >
                            <ArrowUpRight
                                className="absolute right-5 top-5 h-3.5 w-3.5 text-zinc-600 transition group-hover:text-ice"
                                aria-hidden="true"
                            />
                            {content}
                        </a>
                    ) : (
                        <div key={item.title} className={cellClass}>
                            {content}
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
