'use client';

import React from 'react';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import Link from 'next/link';

export default function PrivacyPolicy() {
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
                        Privacy Policy
                    </h1>
                    <p className="text-zinc-400">Last updated: June 2026</p>
                </div>

                <div className="p-6 rounded-2xl bg-zinc-900/50 border border-zinc-800 space-y-4">
                    <div className="flex items-center gap-3 text-green-400 mb-2">
                        <ShieldCheck className="w-6 h-6" />
                        <h2 className="text-lg font-semibold">
                            The Short Version
                        </h2>
                    </div>
                    <p className="text-zinc-300 leading-relaxed">
                        Floe is a <strong>Peer-to-Peer (P2P)</strong> file
                        transfer service. This means your files stream
                        directly from the sender&apos;s device to the receiver&apos;s
                        device whenever possible.
                        <br />
                        <br />
                        <strong>
                            We do not store, view, or process your files.
                        </strong>{' '}
                        In direct connections, files never touch our servers. In relay
                        connections, encrypted file data passes through our TURN server
                        in transit but is never stored or inspected. The only thing we
                        keep is a single anonymous number: the running total of bytes
                        transferred across all users, shown by the counter on our
                        homepage. You can opt out of contributing to this counter at
                        any time.
                    </p>
                </div>

                <div className="space-y-8 text-zinc-300 leading-relaxed">
                    <section className="space-y-3">
                        <h3 className="text-xl font-semibold text-white flex items-center gap-2">
                            1. How the Transfer Works
                        </h3>
                        <p>
                            When you send a file, we use <strong>WebRTC</strong>{' '}
                            to establish a connection between you and the recipient.
                            Our signaling server introduces the two devices and then
                            steps aside. In most cases, data flows directly between
                            browsers. When a direct path is not available, our TURN
                            relay server bridges the connection. Even through the relay,
                            files remain encrypted and are never stored.
                        </p>
                    </section>

                    <section className="space-y-3">
                        <h3 className="text-xl font-semibold text-white flex items-center gap-2">
                            2. Information We Collect
                        </h3>
                        <ul className="list-disc list-inside space-y-2 ml-2 text-zinc-400">
                            <li>
                                <strong>Files:</strong> We do NOT collect or
                                store any files.
                            </li>
                            <li>
                                <strong>Metadata:</strong> We temporarily
                                process filenames and sizes during the signaling
                                phase to display them to the receiver. This data
                                is not stored permanently.
                            </li>
                            <li>
                                <strong>Aggregate Transfer Total:</strong> When a
                                transfer completes, the receiving side reports only
                                the number of bytes it received. We add this to one
                                shared, all-time counter of total bytes transferred,
                                shown on our homepage. The sender never reports.
                                We do not store file names, file contents, individual
                                transfer records, or any link between this number and
                                you. You can opt out of this report: uncheck
                                &quot;Contribute to global stats&quot; on the receiver
                                view in the browser, or use{' '}
                                <code className="text-xs bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-300">--no-report</code>
                                {' '}(or set{' '}
                                <code className="text-xs bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-300">FLOE_NO_STATS=1</code>
                                ) when using the CLI.
                            </li>
                            <li>
                                <strong>IP Addresses:</strong> Like all web
                                servers, our hosting provider may log connection
                                request IP addresses for security and abuse
                                prevention. We do not link this to your
                                identity.
                            </li>
                        </ul>
                    </section>

                    <section className="space-y-3">
                        <h3 className="text-xl font-semibold text-white">
                            3. Third-Party Services
                        </h3>
                        <p>
                            Floe uses third-party infrastructure providers for
                            hosting and network relay services. The web app is
                            hosted on Vercel, which collects aggregate, anonymous
                            traffic and performance metrics through Vercel Analytics
                            and Speed Insights. We also use Sentry for error
                            monitoring and Umami for privacy-respecting usage
                            analytics. Please refer to their respective privacy
                            policies regarding data handling.
                        </p>
                    </section>

                    <section className="space-y-3">
                        <h3 className="text-xl font-semibold text-white">
                            4. Relay Server
                        </h3>
                        <p>
                            When a direct connection cannot be established, file data
                            is routed through our TURN relay server (
                            <code className="text-xs bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-300">
                                turn.floe.one
                            </code>
                            ). This server processes encrypted data packets in transit
                            and does not store, decrypt, or inspect any file contents.
                            Relay sessions are limited to 2 GB per session. Connection
                            metadata (timestamps, IP addresses) may be logged by the
                            hosting provider for security purposes.
                        </p>
                    </section>

                    <section className="space-y-3">
                        <h3 className="text-xl font-semibold text-white">
                            5. Error Monitoring &amp; Session Replay
                        </h3>
                        <p>
                            Floe uses Sentry to monitor application errors
                            and performance. Sentry may capture:
                        </p>
                        <ul className="list-disc list-inside space-y-2 ml-2 text-zinc-400">
                            <li>Error stack traces and browser metadata (browser version, OS, device type)</li>
                            <li>Connection type (direct or relay) and transfer progress at time of error</li>
                            <li>
                                <strong>Session Replay:</strong> An anonymized, video-like recording of
                                a small sample of browser sessions, plus any session where an error
                                occurs. All on-screen text and media are masked, so file names and file
                                contents are never captured.
                            </li>
                        </ul>
                        <p>
                            Sentry does <strong>not</strong> capture file names, file contents,
                            or any personally identifiable information. Session recordings are
                            used solely for debugging technical issues.{' '}
                            <a
                                href="https://sentry.io/privacy/"
                                target="_blank"
                                rel="noreferrer"
                                className="text-zinc-400 hover:text-white underline underline-offset-2 transition-colors"
                            >
                                Sentry Privacy Policy
                            </a>
                            .
                        </p>
                    </section>

                    <section className="space-y-3">
                        <h3 className="text-xl font-semibold text-white">
                            6. Usage Analytics
                        </h3>
                        <p>
                            Floe uses Umami, a privacy-focused analytics tool, to
                            understand how the service is used. Umami collects:
                        </p>
                        <ul className="list-disc list-inside space-y-2 ml-2 text-zinc-400">
                            <li>Aggregate transfer metrics: number of files and total bytes transferred per session</li>
                            <li>Connection type (direct or relay) and whether a transfer succeeded or failed</li>
                            <li>Standard page view data: pages visited, browser type, country (not city)</li>
                        </ul>
                        <p>
                            Umami does <strong>not</strong> use cookies, does not collect
                            personally identifiable information, and does not track
                            individuals across sessions or websites. File names and file
                            contents are never recorded.{' '}
                            <a
                                href="https://umami.is/privacy"
                                target="_blank"
                                rel="noreferrer"
                                className="text-zinc-400 hover:text-white underline underline-offset-2 transition-colors"
                            >
                                Umami Privacy Policy
                            </a>
                            .
                        </p>
                    </section>
                </div>

                {/* Footer nav */}
                <div className="pt-4 border-t border-white/5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] text-zinc-500 uppercase tracking-wide">
                    <Link href="/how-it-works" className="whitespace-nowrap hover:text-white transition-colors">How It Works</Link>
                    <span>•</span>
                    <Link href="/terms" className="whitespace-nowrap hover:text-white transition-colors">Terms of Use</Link>
                </div>
            </div>
        </div>
    );
}
