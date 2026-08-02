'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

type ConnectionStatus = 'direct' | 'relay' | 'connected' | 'offline';

const STATUS: Record<ConnectionStatus, { color: string; label: string }> = {
    direct: { color: 'bg-green-500', label: 'Direct peer connection' },
    relay: { color: 'bg-amber-500', label: 'Relay connection' },
    connected: { color: 'bg-green-500', label: 'Connected' },
    offline: { color: 'bg-red-500', label: 'Not connected' },
};

// Section anchors on the homepage, in document order (drives the scroll-spy).
const SECTIONS = [
    { id: 'about', label: 'About' },
    { id: 'cli', label: 'CLI' },
    { id: 'desktop', label: 'Desktop' },
    { id: 'faq', label: 'FAQ' },
];

export const Navbar = () => {
    // The receiver view lives at /#room=..., so pathname is '/' there too and
    // the hard-nav wordmark keeps its clear-peer-state job everywhere it matters.
    const pathname = usePathname();
    const isHome = pathname === '/';
    const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('offline');
    const [activeSection, setActiveSection] = useState<string | null>(null);
    const inView = useRef(new Set<string>());

    useEffect(() => {
        const handler = (e: Event) => {
            setConnectionStatus((e as CustomEvent).detail as ConnectionStatus);
        };
        window.addEventListener('floe-connection-status', handler);
        return () => window.removeEventListener('floe-connection-status', handler);
    }, []);

    useEffect(() => {
        if (!isHome) return; // scroll-spy only exists where the sections do
        const elements = SECTIONS.map((s) => document.getElementById(s.id)).filter(
            (el): el is HTMLElement => el !== null
        );
        if (elements.length === 0) return;
        const tracked = inView.current;
        // A band around the upper-middle of the viewport decides which section is "current".
        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting) tracked.add(entry.target.id);
                    else tracked.delete(entry.target.id);
                });
                setActiveSection(SECTIONS.find((s) => tracked.has(s.id))?.id ?? null);
            },
            { rootMargin: '-25% 0px -60% 0px' }
        );
        elements.forEach((el) => observer.observe(el));
        return () => observer.disconnect();
    }, [isHome]);

    const scrollToSection = (id: string) => {
        const element = document.getElementById(id);
        if (element) {
            element.scrollIntoView({ behavior: 'smooth' });
        }
    };

    const status = STATUS[connectionStatus];

    return (
        <nav aria-label="Main" className="fixed top-0 left-0 right-0 z-50 flex justify-center pb-6 pt-[calc(1.5rem+env(safe-area-inset-top))] pointer-events-none">
            <div className="pointer-events-auto flex items-center gap-1 max-[359px]:gap-0.5 rounded-full border border-white/10 bg-zinc-900/70 p-1.5 max-[359px]:p-1 shadow-2xl backdrop-blur-xl">
                {isHome ? (
                    /* Button with hard-nav: forces full reload, clearing all peer/transfer state */
                    <button
                        onClick={() => { window.location.href = '/'; }}
                        title={status.label}
                        className="flex items-center gap-2 rounded-full px-2.5 max-[359px]:px-2 py-1.5 sm:px-4 sm:py-2 text-sm font-extrabold tracking-tighter text-white transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-ice"
                    >
                        <span className="relative flex h-2.5 w-2.5 items-center justify-center" aria-hidden="true">
                            <span className={`absolute inset-0 rounded-full ${status.color} opacity-40 blur-[2px] transition-colors duration-500`} />
                            <span className={`h-1.5 w-1.5 rounded-full ${status.color} transition-colors duration-500`} />
                        </span>
                        Floe
                        <span className="sr-only">, {status.label}</span>
                    </button>
                ) : (
                    /* Off the homepage there is no peer connection to report or clear:
                       a plain link, no status dot, no status text. */
                    <Link
                        href="/"
                        className="flex items-center rounded-full px-2.5 max-[359px]:px-2 py-1.5 sm:px-4 sm:py-2 text-sm font-extrabold tracking-tighter text-white transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-ice"
                    >
                        Floe
                    </Link>
                )}
                <div className="h-4 w-px bg-white/10 mx-1 max-[359px]:mx-0" />
                <div className="flex items-center gap-0.5 sm:gap-1">
                    {SECTIONS.map((section) => {
                        const pillClass = `rounded-full px-2.5 max-[359px]:px-1 py-1.5 sm:px-3.5 sm:py-2 text-xs sm:text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-ice ${
                            activeSection === section.id
                                ? 'bg-white/[0.07] text-zinc-100'
                                : 'text-zinc-400 hover:bg-white/10 hover:text-white'
                        }`;
                        // On the homepage the pills smooth-scroll; elsewhere they are real
                        // links back to the homepage anchors (middle-click friendly).
                        return isHome ? (
                            <button key={section.id} onClick={() => scrollToSection(section.id)} className={pillClass}>
                                {section.label}
                            </button>
                        ) : (
                            <Link key={section.id} href={`/#${section.id}`} className={pillClass}>
                                {section.label}
                            </Link>
                        );
                    })}
                </div>
                <div className="h-4 w-px bg-white/10 mx-1 max-[359px]:mx-0" />
                {/* Destinations, split from the section anchors above: Docs and the
                    repo leave the site, Download is the conversion page. One filled
                    pill only, and it is Download; GitHub steps down to an icon so
                    the CTA has no competition. */}
                <div className="flex items-center gap-0.5 sm:gap-1">
                    <a
                        href="https://github.com/jannskiee/floe"
                        target="_blank"
                        rel="noreferrer"
                        aria-label="GitHub"
                        title="GitHub"
                        className="flex items-center justify-center rounded-full p-2 max-[359px]:p-1.5 text-white transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-ice"
                    >
                        <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0" fill="currentColor" aria-hidden="true">
                            <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                        </svg>
                    </a>
                    <a
                        href="https://www.floe.one/docs"
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-full px-2.5 max-[359px]:px-1 py-1.5 sm:px-3.5 sm:py-2 text-xs sm:text-sm font-medium text-zinc-400 transition hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-ice"
                    >
                        Docs
                    </a>
                    {/* md: on purpose: the extra pill clips the untested 640-767px band,
                        and phone visitors cannot run the Windows build anyway (footer +
                        the homepage Desktop section carry discovery below md). */}
                    <Link
                        href="/download"
                        data-umami-event="nav-download"
                        className="hidden md:block rounded-full bg-white px-4 py-2 text-sm font-bold text-black transition hover:bg-zinc-200 focus-visible:outline-2 focus-visible:outline-ice"
                    >
                        Download
                    </Link>
                </div>
            </div>
        </nav>
    );
};
