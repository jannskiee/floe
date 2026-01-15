'use client';

import React from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Heart } from 'lucide-react';
import { Navbar } from '@/components/layout/Navbar';
import { AboutSection } from '@/components/layout/AboutSection';
import { FAQSection } from '@/components/layout/FAQSection';
import { P2PTransfer } from '@/components/P2PTransfer';

export default function Home() {
    return (
        <div className="flex min-h-screen flex-col items-center bg-zinc-950 font-sans text-zinc-100 p-6 pt-32">
            <Navbar />

            <div className="mx-auto max-w-3xl text-center mb-8 space-y-4">
                <h1 className="text-7xl font-extrabold tracking-tighter text-white sm:text-9xl drop-shadow-2xl">
                    Floe.
                </h1>
                <p className="mt-4 text-lg leading-8 text-zinc-400 max-w-lg mx-auto">
                    Secure, serverless P2P file transfer.{' '}
                    <br className="hidden sm:inline" />
                    No intermediaries, size limits, or registration required.
                </p>
            </div>

            <P2PTransfer />
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
                <div className="flex gap-4 text-[10px] text-zinc-500 uppercase tracking-widest">
                    <Link
                        href="/privacy"
                        className="hover:text-white transition-colors"
                    >
                        Privacy Policy
                    </Link>
                    <span>•</span>
                    <Link
                        href="/terms"
                        className="hover:text-white transition-colors"
                    >
                        Terms of Use
                    </Link>
                </div>
                <p className="text-xs text-zinc-600 text-center">
                    &copy; {new Date().getFullYear()} Floe. Built with Next.js,
                    WebRTC, and Socket.io.
                </p>
            </footer>
        </div>
    );
}
