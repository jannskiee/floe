import React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Heart } from 'lucide-react';

const columns: {
    label: string;
    links: { name: string; href: string; external?: boolean }[];
}[] = [
    {
        label: 'Product',
        links: [
            { name: 'How it works', href: '/how-it-works' },
            { name: 'FAQ', href: '#faq' },
            { name: 'Docs', href: 'https://docs.floe.one', external: true },
            { name: 'Changelog', href: 'https://docs.floe.one/changelog', external: true },
        ],
    },
    {
        label: 'CLI',
        links: [
            { name: 'Installation', href: 'https://docs.floe.one/cli/installation', external: true },
            { name: 'Commands & flags', href: 'https://docs.floe.one/cli/flags', external: true },
            { name: 'Self-hosted server', href: 'https://docs.floe.one/cli/self-hosted-server', external: true },
        ],
    },
    {
        label: 'Project',
        links: [
            { name: 'GitHub', href: 'https://github.com/jannskiee/floe', external: true },
            { name: 'Self-hosting', href: 'https://docs.floe.one/self-hosting/overview', external: true },
            { name: 'Security & privacy', href: 'https://docs.floe.one/security-privacy', external: true },
        ],
    },
];

export function Footer() {
    return (
        <footer className="mt-24 w-full max-w-5xl border-t border-white/[0.06] pt-12 pb-10">
            <div className="grid gap-12 md:grid-cols-12">
                <div className="md:col-span-5">
                    <p className="text-lg font-extrabold tracking-tighter text-white">Floe</p>
                    <p className="mt-3 max-w-xs text-sm leading-relaxed text-zinc-500">
                        Open-source, peer-to-peer file transfer. MIT licensed.
                    </p>
                    <div className="mt-6 flex items-center gap-6">
                        <a
                            href="https://github.com/jannskiee/floe"
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors"
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
                            className="flex items-center gap-2 text-sm text-zinc-400 hover:text-[#FF5E5B] transition-colors"
                        >
                            <Heart className="h-4 w-4" />
                            <span className="font-medium">Support on Ko-fi</span>
                        </a>
                    </div>
                </div>
                <div className="grid grid-cols-2 gap-8 sm:grid-cols-3 md:col-span-7">
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
                                                className="text-sm text-zinc-400 transition-colors hover:text-zinc-100"
                                            >
                                                {link.name}
                                            </a>
                                        ) : link.href.startsWith('#') ? (
                                            <a
                                                href={link.href}
                                                className="text-sm text-zinc-400 transition-colors hover:text-zinc-100"
                                            >
                                                {link.name}
                                            </a>
                                        ) : (
                                            <Link
                                                href={link.href}
                                                className="text-sm text-zinc-400 transition-colors hover:text-zinc-100"
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
            <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-white/[0.06] pt-6 text-xs text-zinc-600 sm:flex-row">
                <p>&copy; {new Date().getFullYear()} Floe. Built on WebRTC.</p>
                <div className="flex gap-5">
                    <Link href="/privacy" className="transition-colors hover:text-zinc-300">
                        Privacy
                    </Link>
                    <Link href="/terms" className="transition-colors hover:text-zinc-300">
                        Terms
                    </Link>
                </div>
            </div>
        </footer>
    );
}
