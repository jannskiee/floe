'use client';

import React from 'react';
import { ArrowLeft, Zap, Server, ShieldCheck, BookOpen } from 'lucide-react';
import Link from 'next/link';

export default function HowItWorks() {
    return (
        <div className="min-h-dvh bg-zinc-950 text-zinc-100 font-sans p-6 md:p-12">
            <div className="max-w-3xl mx-auto space-y-8">
                <div className="space-y-4">
                    <Link
                        href="/"
                        className="inline-flex items-center text-sm text-zinc-400 hover:text-white transition-colors mb-4"
                    >
                        <ArrowLeft className="w-4 h-4 mr-2" /> Back to Home
                    </Link>
                    <h1 className="text-4xl font-bold tracking-tight text-white">
                        How Floe Works
                    </h1>
                    <p className="text-zinc-400">
                        A plain-language overview of what happens behind the scenes when you share a file.
                    </p>
                </div>

                {/* Hero summary card */}
                <div className="p-6 rounded-2xl bg-zinc-900/50 border border-zinc-800 space-y-4">
                    <div className="flex items-center gap-3 text-green-400 mb-2">
                        <ShieldCheck className="w-6 h-6" />
                        <h2 className="text-lg font-semibold">The Short Version</h2>
                    </div>
                    <p className="text-zinc-300 leading-relaxed">
                        Floe uses a technology called <strong>WebRTC</strong> to send your files directly from
                        one browser to another. Think of it like handing a USB drive to someone. It
                        happens over the internet, in real time. In most cases, no one else is in the middle.
                        <br /><br />
                        In some network situations, a secure relay server acts as a bridge. Either way,
                        your files are <strong>end-to-end encrypted</strong> and never stored on any server.
                    </p>
                </div>

                {/* Direct + Relay side-by-side cards */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="p-5 rounded-2xl bg-zinc-900/50 border border-zinc-800 space-y-3">
                        <div className="flex items-center gap-2.5">
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-500/10 ring-1 ring-green-500/20">
                                <Zap className="w-4 h-4 text-green-400" />
                            </div>
                            <div>
                                <p className="text-sm font-semibold text-white leading-none">Direct Connection</p>
                                <span className="text-[10px] text-green-400 font-medium uppercase tracking-wide">Fastest</span>
                            </div>
                        </div>
                        <p className="text-sm text-zinc-400 leading-relaxed">
                            Files travel straight from your device to the recipient. No server sits in between.
                            Speed is limited only by your internet connection.
                        </p>
                        <ul className="space-y-1 text-xs text-zinc-500">
                            <li className="flex items-center gap-1.5"><span className="text-green-500">+</span> No file size limit</li>
                            <li className="flex items-center gap-1.5"><span className="text-green-500">+</span> Zero bandwidth cost to Floe</li>
                            <li className="flex items-center gap-1.5"><span className="text-green-500">+</span> Works on most home and mobile networks</li>
                        </ul>
                    </div>

                    <div className="p-5 rounded-2xl bg-zinc-900/50 border border-zinc-800 space-y-3">
                        <div className="flex items-center gap-2.5">
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500/10 ring-1 ring-amber-500/20">
                                <Server className="w-4 h-4 text-amber-400" />
                            </div>
                            <div>
                                <p className="text-sm font-semibold text-white leading-none">Relay Connection</p>
                                <span className="text-[10px] text-amber-400 font-medium uppercase tracking-wide">Via TURN Server</span>
                            </div>
                        </div>
                        <p className="text-sm text-zinc-400 leading-relaxed">
                            Used on strict corporate firewalls or carrier-grade NAT networks where a direct
                            path cannot be found. Floe falls back automatically.
                        </p>
                        <ul className="space-y-1 text-xs text-zinc-500">
                            <li className="flex items-center gap-1.5"><span className="text-amber-500">~</span> Works on restricted networks</li>
                            <li className="flex items-center gap-1.5"><span className="text-amber-500">~</span> Files remain encrypted in transit</li>
                            <li className="flex items-center gap-1.5"><span className="text-amber-500">~</span> Capped at 2 GB per session</li>
                        </ul>
                    </div>
                </div>

                {/* Encryption note */}
                <p className="text-sm text-zinc-500 text-center px-4">
                    Every connection, direct or relayed, is encrypted with{' '}
                    <strong className="text-zinc-400">DTLS</strong> built into WebRTC. Even the relay server cannot read your files.
                </p>

                {/* Docs CTA */}
                <div className="p-6 rounded-2xl bg-zinc-900/50 border border-zinc-800 space-y-4">
                    <div className="flex items-center gap-3">
                        <BookOpen className="w-5 h-5 text-zinc-400" />
                        <h2 className="text-base font-semibold text-white">Want the full technical detail?</h2>
                    </div>
                    <p className="text-sm text-zinc-400">
                        The Floe documentation covers signaling, ICE and NAT traversal, DTLS encryption,
                        and the binary transfer protocol in depth.
                    </p>
                    <a
                        href="https://www.floe.one/docs/how-it-works/signaling"
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-bold text-black transition hover:bg-zinc-200"
                    >
                        Read the full technical breakdown
                        <ArrowLeft className="w-3.5 h-3.5 rotate-180" />
                    </a>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
                        {[
                            { label: 'Signaling', href: 'https://www.floe.one/docs/how-it-works/signaling' },
                            { label: 'Direct Connection', href: 'https://www.floe.one/docs/how-it-works/direct-connection' },
                            { label: 'Relay Connection', href: 'https://www.floe.one/docs/how-it-works/relay-connection' },
                            { label: '2 GB Limit', href: 'https://www.floe.one/docs/how-it-works/2gb-limit' },
                            { label: 'Encryption', href: 'https://www.floe.one/docs/how-it-works/encryption' },
                        ].map(({ label, href }) => (
                            <a
                                key={label}
                                href={href}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[10px] text-zinc-500 uppercase tracking-wide hover:text-white transition-colors whitespace-nowrap"
                            >
                                {label}
                            </a>
                        ))}
                    </div>
                </div>

                {/* Footer nav */}
                <div className="pt-4 border-t border-white/5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] text-zinc-500 uppercase tracking-wide">
                    <a href="https://www.floe.one/docs" target="_blank" rel="noreferrer" className="whitespace-nowrap hover:text-white transition-colors">Docs</a>
                    <span>•</span>
                    <Link href="/privacy" className="whitespace-nowrap hover:text-white transition-colors">Privacy Policy</Link>
                    <span>•</span>
                    <Link href="/terms" className="whitespace-nowrap hover:text-white transition-colors">Terms of Use</Link>
                </div>
            </div>
        </div>
    );
}
