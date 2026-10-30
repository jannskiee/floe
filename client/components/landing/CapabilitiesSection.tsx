import {
    Activity,
    ArrowLeftRight,
    ArrowUpRight,
    FileCheck,
    FolderTree,
    Infinity as InfinityIcon,
    Server,
    LucideIcon,
} from 'lucide-react';
import { SectionHeader, sectionClass } from './SectionHeader';

// Six tiles on purpose: the smallest count that fills the last row at both
// the 2 and the 3 column widths.
const items: {
    icon: LucideIcon;
    title: string;
    body: string;
    href?: string;
}[] = [
    {
        icon: InfinityIcon,
        title: 'No size limit from Floe',
        body: 'Floe sets no size limit on a direct connection; a browser that receives is limited by what that browser can hold. Relayed sessions cap at 2 GB, and the badge shows which one you are on.',
    },
    {
        icon: ArrowLeftRight,
        title: 'Browser to terminal',
        body: 'The web app, Floe Desktop, and the CLI share one protocol. Send from a server, receive on a phone, any direction.',
    },
    {
        icon: FolderTree,
        title: 'Folders stay folders',
        body: 'The CLI and Floe Desktop send a folder whole and rebuild its structure when they receive one. A browser keeps the structure when you use "Download ZIP".',
    },
    {
        icon: Activity,
        title: 'Honest progress',
        // The terminal draws a bar per file (format.go newProgressBar); the
        // browser draws one bar that restarts for each file
        // (TransferProgressBar.tsx), so "per-file bars" was true of one side.
        body: 'Progress for each file with live speed and time left, in the browser and in the terminal.',
    },
    {
        icon: FileCheck,
        title: 'Checked on arrival',
        body: 'Each file is checked against its announced size and, when the sender sends one, a fingerprint of its contents (SHA-256). A mismatched file is discarded. Browser, CLI, and Floe Desktop receivers confirm delivery.',
        href: 'https://www.floe.one/docs/how-it-works/file-checks',
    },
    {
        icon: Server,
        title: 'Open source, self-hostable',
        body: 'MIT licensed, every line on GitHub. Run your own signaling server and relay with Docker; the docs cover production setup.',
        href: 'https://www.floe.one/docs/self-hosting/overview',
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
