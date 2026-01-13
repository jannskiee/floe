'use client';

import React from 'react';
import { ArrowLeft, AlertTriangle } from 'lucide-react';
import Link from 'next/link';

export default function TermsOfUse() {
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
                        Terms of Use
                    </h1>
                    <p className="text-zinc-400">Effective Date: </p>
                </div>

                <div className="p-6 rounded-2xl bg-orange-500/10 border border-orange-500/20 space-y-4">
                    <div className="flex items-center gap-3 text-orange-400 mb-2">
                        <AlertTriangle className="w-6 h-6" />
                        <h2 className="text-lg font-semibold">Disclaimer</h2>
                    </div>
                    <p className="text-zinc-300 leading-relaxed">
                        Floe is provided "as is" without any warranties. As an
                        open-source project, we do not guarantee uptime, data
                        integrity, or fitness for a particular purpose. Use this
                        service at your own risk.
                    </p>
                </div>

                <div className="space-y-8 text-zinc-300 leading-relaxed">
                    <section className="space-y-3">
                        <h3 className="text-xl font-semibold text-white flex items-center gap-2">
                            1. Acceptable Use
                        </h3>
                        <p>By using Floe, you agree NOT to:</p>
                        <ul className="list-disc list-inside space-y-2 ml-2 text-zinc-400">
                            <li>
                                Transfer illegal content (e.g., malware, pirated
                                software, child exploitation material).
                            </li>
                            <li>
                                Use the service for phishing or social
                                engineering attacks.
                            </li>
                            <li>
                                Attempt to disrupt or reverse-engineer the
                                signaling server.
                            </li>
                        </ul>
                    </section>

                    <section className="space-y-3">
                        <h3 className="text-xl font-semibold text-white">
                            2. User Responsibility
                        </h3>
                        <p>
                            Since Floe is a Peer-to-Peer service, you are solely
                            responsible for the content you send. We do not (and
                            cannot) moderate file contents. You agree to
                            indemnify the developers of Floe against any legal
                            claims arising from your use of the service.
                        </p>
                    </section>

                    <section className="space-y-3">
                        <h3 className="text-xl font-semibold text-white">
                            3. Copyright & License
                        </h3>
                        <p>
                            The source code for Floe is available under the{' '}
                            <strong>MIT License</strong>. You are free to
                            inspect, modify, and host your own version of this
                            software, subject to the terms of the license.
                        </p>
                    </section>
                </div>
            </div>
        </div>
    );
}
