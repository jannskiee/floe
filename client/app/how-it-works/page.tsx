'use client';

import React from 'react';
import { ArrowLeft, Zap, Server, ShieldCheck } from 'lucide-react';
import Link from 'next/link';

export default function HowItWorks() {
    return (
        <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans p-6 md:p-12">
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
                        A plain-language guide to what happens behind the scenes when you share a file.
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
                        In some network situations, a secure relay
                        server acts as a bridge. Either way, your files are <strong>end-to-end encrypted</strong> and
                        never stored on any server.
                    </p>
                </div>

                <div className="space-y-10 text-zinc-300 leading-relaxed">

                    {/* Section 1 */}
                    <section className="space-y-4">
                        <h3 className="text-xl font-semibold text-white">Signaling</h3>
                        <p>
                            When you drop files into Floe, a unique one-time link is created. Our signaling server
                            (<code className="text-xs bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-300">api.floe.one</code>) plays
                            the role of a matchmaker. When the recipient opens your link, both browsers
                            introduce themselves to each other through this server.
                        </p>
                        <p>
                            Once both sides have said hello, the signaling server steps completely out of the
                            picture. It does not handle any file data, does not store anything, and does not
                            participate in the transfer.
                        </p>
                    </section>

                    {/* Section 2 */}
                    <section className="space-y-4">
                        <div className="flex items-center gap-3">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-green-500/10 ring-1 ring-green-500/20">
                                <Zap className="w-4 h-4 text-green-400" />
                            </div>
                            <h3 className="text-xl font-semibold text-white">
                                Direct Connection
                                <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-400 ring-1 ring-green-500/20">Fastest</span>
                            </h3>
                        </div>
                        <p>
                            A direct connection means your files travel straight from your device to the
                            recipient&apos;s device, like a private tunnel between two computers with no stops
                            in between.
                        </p>
                        <p>
                            To find this direct path, WebRTC uses a <strong>STUN server</strong>. Think of a STUN
                            server like asking a friend outside your house &quot;what does my address look like from
                            out there?&quot; It helps each browser discover its public internet address so they can
                            reach each other.
                        </p>
                        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 space-y-2">
                            <p className="text-sm font-semibold text-white">Direct Connection: what it means for you</p>
                            <ul className="list-disc list-inside space-y-1.5 text-sm text-zinc-400 ml-2">
                                <li>Maximum speed, limited only by your internet connection</li>
                                <li>No file size limits</li>
                                <li>Zero bandwidth cost to Floe</li>
                                <li>Your files never touch a server</li>
                            </ul>
                        </div>
                        <p>
                            Most home and mobile networks support direct connections. You are most likely to see
                            this on standard home Wi-Fi or a personal mobile hotspot.
                        </p>
                    </section>

                    {/* Section 3 */}
                    <section className="space-y-4">
                        <div className="flex items-center gap-3">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-500/10 ring-1 ring-amber-500/20">
                                <Server className="w-4 h-4 text-amber-400" />
                            </div>
                            <h3 className="text-xl font-semibold text-white">
                                Relay Connection
                                <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-400 ring-1 ring-amber-500/20">Via TURN Server</span>
                            </h3>
                        </div>
                        <p>
                            Some networks make it impossible to connect two browsers directly. This happens
                            on strict corporate firewalls, university networks, or when your mobile carrier
                            places many users behind a single shared IP address (called{' '}
                            <strong>Carrier-Grade NAT</strong>). In these cases, a direct path simply cannot
                            be found.
                        </p>
                        <p>
                            Floe automatically falls back to a <strong>TURN server</strong>
                            (<code className="text-xs bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-300">turn.floe.one</code>).
                            A TURN server acts as a secure bridge. Your data passes through it on its way to
                            the recipient. Think of it like a trusted courier who picks up a sealed, locked
                            box from you and delivers it to the recipient without being able to open it.
                        </p>
                        <p>
                            Even through a relay, your files are protected by <strong>DTLS encryption</strong>.
                            This is the same standard used by HTTPS. The relay server sees encrypted data packets, not
                            your actual files.
                        </p>
                        <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 space-y-2">
                            <p className="text-sm font-semibold text-white">Relay Connection: what it means for you</p>
                            <ul className="list-disc list-inside space-y-1.5 text-sm text-zinc-400 ml-2">
                                <li>Transfer still works even on strict networks</li>
                                <li>Your files remain encrypted in transit</li>
                                <li>Speeds may be slower depending on server load</li>
                                <li>Limited to 2 GB per transfer (see below)</li>
                            </ul>
                        </div>
                    </section>

                    {/* Section 4 */}
                    <section className="space-y-4">
                        <h3 className="text-xl font-semibold text-white">Why the 2 GB Limit on Relay?</h3>
                        <p>
                            When your files go through our TURN relay server, every byte of data passes through
                            our infrastructure. That costs real money in server bandwidth. Direct connections
                            cost us nothing.
                        </p>
                        <p>
                            To keep Floe free and running for everyone, relay transfers are capped at
                            <strong> 2 GB per session</strong>. This limit only applies to relay connections.
                            Direct connections have no limit whatsoever.
                        </p>
                        <div className="rounded-xl bg-amber-500/5 border border-amber-500/20 p-4 space-y-2">
                            <p className="text-sm font-semibold text-amber-400">How to get a Direct Connection</p>
                            <ul className="list-disc list-inside space-y-1.5 text-sm text-zinc-400 ml-2">
                                <li>Use a standard home or personal Wi-Fi network</li>
                                <li>Disconnect from any VPN</li>
                                <li>Avoid transferring from strict corporate or university networks</li>
                                <li>Try using a personal mobile hotspot</li>
                            </ul>
                        </div>
                    </section>

                    {/* Section 5 */}
                    <section className="space-y-4">
                        <h3 className="text-xl font-semibold text-white">End-to-End Encryption</h3>
                        <p>
                            Every WebRTC connection, whether direct or relayed, is encrypted using{' '}
                            <strong>DTLS-SRTP</strong>. This is the same encryption standard used by your
                            bank&apos;s website. It means even Floe&apos;s own relay server cannot read your files.
                            The encryption keys are generated uniquely for each transfer and exist only in
                            the two browsers involved.
                        </p>
                        <p>
                            Floe has no database, stores no files, and retains no logs of what you transfer.
                            Once the transfer is complete and both tabs are closed, the data is gone.
                        </p>
                    </section>
                </div>

                {/* Footer nav */}
                <div className="pt-4 border-t border-white/5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] text-zinc-500 uppercase tracking-wide">
                    <Link href="/privacy" className="whitespace-nowrap hover:text-white transition-colors">Privacy Policy</Link>
                    <span>•</span>
                    <Link href="/terms" className="whitespace-nowrap hover:text-white transition-colors">Terms of Use</Link>
                </div>
            </div>
        </div>
    );
}
