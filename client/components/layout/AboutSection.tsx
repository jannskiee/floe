'use client';

import React from 'react';
import { ShieldCheck, Zap, Server } from 'lucide-react';

export const AboutSection = () => {
    return (
        <section id="about" className="mt-32 max-w-4xl w-full grid grid-cols-1 md:grid-cols-3 gap-8 text-center scroll-mt-28">
            <div className="flex flex-col items-center space-y-3 p-4">
                <div className="h-12 w-12 rounded-full bg-zinc-900 flex items-center justify-center border border-zinc-800 text-white">
                    <ShieldCheck className="h-6 w-6" />
                </div>
                <h3 className="text-lg font-semibold text-white">End-to-End Encrypted</h3>
                <p className="text-sm text-zinc-500 max-w-xs">Encrypted end-to-end on every transfer. Direct or relayed, only you and your recipient can read your files.</p>
            </div>
            <div className="flex flex-col items-center space-y-3 p-4">
                <div className="h-12 w-12 rounded-full bg-zinc-900 flex items-center justify-center border border-zinc-800 text-white">
                    <Zap className="h-6 w-6" />
                </div>
                <h3 className="text-lg font-semibold text-white">Blazing Fast</h3>
                <p className="text-sm text-zinc-500 max-w-xs">No throttling, no upload queues. Transfer speed is limited only by your connection.</p>
            </div>
            <div className="flex flex-col items-center space-y-3 p-4">
                <div className="h-12 w-12 rounded-full bg-zinc-900 flex items-center justify-center border border-zinc-800 text-white">
                    <Server className="h-6 w-6" />
                </div>
                <h3 className="text-lg font-semibold text-white">No File Storage</h3>
                <p className="text-sm text-zinc-500 max-w-xs">Files are never stored on any server. Direct transfers have no size limit. Relay transfers are capped at 2 GB per session.</p>
            </div>
        </section>
    );
};