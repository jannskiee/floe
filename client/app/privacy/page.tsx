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
                    <p className="text-zinc-400">Last updated: </p>
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
                        transfer service. This means your files are streamed
                        directly from the sender's device to the receiver's
                        device.
                        <br />
                        <br />
                        <strong>
                            We do not store, view, or process your files.
                        </strong>{' '}
                        They never touch our servers/databases (because we don't
                        have a database).
                    </p>
                </div>

                <div className="space-y-8 text-zinc-300 leading-relaxed">
                    <section className="space-y-3">
                        <h3 className="text-xl font-semibold text-white flex items-center gap-2">
                            1. How the Transfer Works
                        </h3>
                        <p>
                            When you send a file, we use <strong>WebRTC</strong>{' '}
                            to establish a direct connection between you and the
                            recipient. Our server is only used for "Signaling"
                            (introducing the two devices). Once connected, the
                            server steps aside, and data flows directly between
                            peers.
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
                            This project is open-source and hosted on Vercel
                            (Frontend) and Render/Railway (Backend). Please
                            refer to their respective privacy policies regarding
                            server access logs.
                        </p>
                    </section>
                </div>
            </div>
        </div>
    );
}
