import React from 'react';
import { ShieldCheck, Zap, Globe } from 'lucide-react';

export const AboutSection = () => {
    return (
        <section id="about" className="mt-32 max-w-4xl w-full grid grid-cols-1 md:grid-cols-3 gap-8 text-center scroll-mt-28">
            <div className="flex flex-col items-center space-y-3 p-4">
                <div className="h-12 w-12 rounded-full bg-zinc-900 flex items-center justify-center border border-zinc-800 text-white">
                    <ShieldCheck className="h-6 w-6" />
                </div>
                <h3 className="text-lg font-semibold text-white">End-to-End Encrypted</h3>
                <p className="text-sm text-zinc-500 max-w-xs">Your data never touches our servers. It flows directly from your device to your peer&apos;s device.</p>
            </div>
            <div className="flex flex-col items-center space-y-3 p-4">
                <div className="h-12 w-12 rounded-full bg-zinc-900 flex items-center justify-center border border-zinc-800 text-white">
                    <Zap className="h-6 w-6" />
                </div>
                <h3 className="text-lg font-semibold text-white">Blazing Fast</h3>
                <p className="text-sm text-zinc-500 max-w-xs">No upload limits or bandwidth throttling. Transfer speed is only limited by your local network.</p>
            </div>
            <div className="flex flex-col items-center space-y-3 p-4">
                <div className="h-12 w-12 rounded-full bg-zinc-900 flex items-center justify-center border border-zinc-800 text-white">
                    <Globe className="h-6 w-6" />
                </div>
                <h3 className="text-lg font-semibold text-white">Unlimited Size</h3>
                <p className="text-sm text-zinc-500 max-w-xs">Send terabytes of data if you want. Since we don&apos;t store it, we don&apos;t care how big it is.</p>
            </div>
        </section>
    );
};