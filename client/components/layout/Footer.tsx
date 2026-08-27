import React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Heart } from 'lucide-react';

// The four columns mirror the docs footer in docs/docs.json exactly (same
// headers, same labels, same destinations), so the two surfaces never drift.
// Change them together or not at all.
const columns: {
    label: string;
    links: { name: string; href: string; external?: boolean }[];
}[] = [
    {
        label: 'Product',
        links: [
            { name: 'Floe', href: '/' },
            { name: 'Download', href: '/download' },
            { name: 'How It Works', href: '/how-it-works' },
        ],
    },
    {
        label: 'Documentation',
        links: [
            { name: 'Quickstart', href: 'https://www.floe.one/docs/quickstart', external: true },
            { name: 'Web app', href: 'https://www.floe.one/docs/web-app/sending', external: true },
            { name: 'CLI', href: 'https://www.floe.one/docs/cli/installation', external: true },
            { name: 'Desktop app', href: 'https://www.floe.one/docs/desktop/installation', external: true },
            { name: 'Self-hosting', href: 'https://www.floe.one/docs/self-hosting/overview', external: true },
            { name: 'FAQ', href: 'https://www.floe.one/docs/faq', external: true },
            { name: 'Changelog', href: 'https://www.floe.one/docs/changelog', external: true },
        ],
    },
    {
        label: 'Project',
        links: [
            { name: 'GitHub', href: 'https://github.com/jannskiee/floe', external: true },
            { name: 'Releases', href: 'https://github.com/jannskiee/floe/releases', external: true },
            { name: 'Report an Issue', href: 'https://github.com/jannskiee/floe/issues', external: true },
            { name: 'Contributing', href: 'https://github.com/jannskiee/floe/blob/main/CONTRIBUTING.md', external: true },
            { name: 'Sponsor', href: 'https://github.com/sponsors/jannskiee', external: true },
        ],
    },
    {
        label: 'Legal',
        links: [
            { name: 'Privacy Policy', href: '/privacy' },
            { name: 'Terms of Use', href: '/terms' },
            { name: 'Security Policy', href: 'https://github.com/jannskiee/floe/security/policy', external: true },
            { name: 'License (MIT)', href: 'https://github.com/jannskiee/floe/blob/main/LICENSE', external: true },
        ],
    },
];

export function Footer() {
    return (
        <footer className="mt-24 w-full max-w-5xl border-t border-white/[0.06] pt-12 pb-10">
            {/* lg, not md: at 768 the 12-col split + gap-12 would leave ~92px
                link columns, which cannot hold the one-word DOCUMENTATION
                header (~114px at 11px mono with 0.2em tracking). Below lg the
                identity block stacks above a full-width link row instead. */}
            <div className="grid gap-12 lg:grid-cols-12">
                <div className="lg:col-span-4">
                    <p className="text-lg font-extrabold tracking-tighter text-white">Floe</p>
                    <p className="mt-3 max-w-xs text-sm leading-relaxed text-zinc-500">
                        Open-source, peer-to-peer file transfer. <span className="whitespace-nowrap">MIT licensed.</span>
                    </p>
                    <div className="mt-6 flex items-center gap-6">
                        <a
                            href="https://github.com/jannskiee/floe"
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors focus-visible:outline-2 focus-visible:outline-ice"
                        >
                            <Image
                                src="/github-mark-white.png"
                                alt=""
                                width={16}
                                height={16}
                                className="opacity-80"
                            />
                            <span className="font-medium">GitHub</span>
                        </a>
                        <a
                            href="https://ko-fi.com/jannskiee"
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-2 text-sm text-zinc-400 hover:text-[#FF5E5B] transition-colors focus-visible:outline-2 focus-visible:outline-ice"
                        >
                            <Heart className="h-4 w-4" />
                            <span className="font-medium">Support on Ko-fi</span>
                        </a>
                    </div>
                </div>
                {/* md, not sm, for the 4-across step: at 640 four tracks are
                    ~124px, within 10px of the DOCUMENTATION header; from 768
                    they are 156px+, and at lg the col-span-8 split keeps them
                    at ~135px or wider. Below md the four columns fall back to
                    the standard 2x2. */}
                <div className="grid grid-cols-2 gap-8 md:grid-cols-4 lg:col-span-8">
                    {columns.map((column) => (
                        <div key={column.label}>
                            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-600">
                                {column.label}
                            </p>
                            <ul className="mt-4 space-y-2.5">
                                {column.links.map((link) => (
                                    <li key={link.name}>
                                        {link.external ? (
                                            <a
                                                href={link.href}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="text-sm text-zinc-400 transition-colors hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-ice"
                                            >
                                                {link.name}
                                            </a>
                                        ) : (
                                            <Link
                                                href={link.href}
                                                className="text-sm text-zinc-400 transition-colors hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-ice"
                                            >
                                                {link.name}
                                            </Link>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>
            </div>
            {/* The Legal column above owns Privacy/Terms now, so the bar keeps
                only the copyright line. */}
            <div className="mt-12 border-t border-white/[0.06] pt-6 text-center text-xs text-zinc-600 sm:text-left">
                <p>&copy; {new Date().getFullYear()} Floe. Built on WebRTC.</p>
            </div>
        </footer>
    );
}
