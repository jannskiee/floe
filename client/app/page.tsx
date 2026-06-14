import React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Heart } from 'lucide-react';
import { Navbar } from '@/components/layout/Navbar';
import { AboutSection } from '@/components/layout/AboutSection';
import { FAQSection } from '@/components/layout/FAQSection';
import { P2PTransfer } from '@/components/P2PTransfer';
import { InAppBrowserGuard } from '@/components/InAppBrowserGuard';

export default function Home() {
    return (
        <div className="flex min-h-screen flex-col items-center bg-zinc-950 font-sans text-zinc-100 p-4 sm:p-6 pt-28 sm:pt-32">
            <Navbar />

            <div className="mx-auto max-w-3xl text-center mb-8 space-y-4">
                <h1 className="text-5xl sm:text-7xl font-extrabold tracking-tighter text-white lg:text-9xl drop-shadow-2xl">
                    Floe
                </h1>
                <p className="mt-4 text-lg leading-8 text-zinc-400 max-w-lg mx-auto">
                    Secure, encrypted P2P file transfer.{' '}
                    <br className="hidden sm:inline" />
                    No accounts, no file storage, and no registration required.
                </p>
            </div>

            <InAppBrowserGuard>
                <P2PTransfer />
            </InAppBrowserGuard>
            <AboutSection />
            <FAQSection />

            <footer className="mt-24 mb-12 w-full max-w-md flex flex-col items-center space-y-6 border-t border-white/5 pt-8">
                <div className="flex items-center gap-6">
                    <a
                        href="https://github.com/jannskiee/floe"
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors"
                    >
                        <Image
                            src="/github-mark-white.png"
                            alt="GitHub"
                            width={16}
                            height={16}
                            className="opacity-80 hover:opacity-100 transition-opacity"
                        />
                        <span className="font-medium">Open Source</span>
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
                <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] text-zinc-500 uppercase tracking-wide">
                    <Link href="/how-it-works" className="whitespace-nowrap hover:text-white transition-colors">How It Works</Link>
                    <span>•</span>
                    <Link href="/privacy" className="whitespace-nowrap hover:text-white transition-colors">Privacy Policy</Link>
                    <span>•</span>
                    <Link href="/terms" className="whitespace-nowrap hover:text-white transition-colors">Terms of Use</Link>
                </div>
                <p className="text-xs text-zinc-600 text-center">
                    &copy; {new Date().getFullYear()} Floe. Built with Next.js,
                    WebRTC, and Socket.io.
                </p>
            </footer>
        </div>
    );
}
