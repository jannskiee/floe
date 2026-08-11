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

/**
 * Section anchors on the homepage, in document order (drives the scroll-spy).
 *
 * `wide` holds an anchor back to lg. The 640-1023px band has to seat the two
 * destinations as well, and it is mostly landscape phones and half-snapped
 * desktop windows rather than tablets. CLI and Desktop are the two that yield:
 * both point at something you cannot do at that size anyway (run a terminal,
 * install a Windows app), while About and FAQ are audience-neutral.
 *
 * The gate is pure CSS. The observer below watches the page <section> elements,
 * which render at every width, so a held-back anchor just carries a highlight
 * nobody can see. Filtering this array by viewport instead would mean matchMedia
 * in an effect, which is the markup-swapping e2e/hydration.spec.ts fails on.
 */
const SECTIONS: { id: string; label: string; wide?: boolean }[] = [
    { id: 'about', label: 'About' },
    { id: 'cli', label: 'CLI', wide: true },
    { id: 'desktop', label: 'Desktop', wide: true },
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
    const onDownload = pathname === '/download';

    return (
        <nav aria-label="Main" className="fixed top-0 left-0 right-0 z-50 flex justify-center pb-6 pt-[calc(1.5rem+env(safe-area-inset-top))] pointer-events-none">
            {/* data-nav-pill is the stable hook for e2e/responsive.spec.ts and
                e2e/screenshot-matrix.mjs. Both also assert this stays the only
                element child of nav[aria-label="Main"], because <nav> is
                `flex justify-center`: a sibling would push the capsule off centre,
                and a wrapper would move the centring away from the measured box.

                The pill hugs its content at every width, so the overflow guard
                below never engages normally; it is the net for a font fallback, a
                minimum-font-size setting or browser zoom. Three companions are
                load-bearing and each is silently fatal alone:
                  min-w-0        a flex item's automatic minimum size beats
                                 max-width, so without this the cap does nothing.
                  [&>*]:shrink-0 otherwise the children squash and wrap to two rows
                                 instead of scrolling. Pinning the direct children
                                 pins the whole tree.
                  scroll-p-1.5   when a scroller engages, browsers align the focused
                                 child's border box flush with the scrollport edge,
                                 putting its 2px focus ring outside the clip.
                calc(100%...) not 100vw: <nav> is fixed left-0 right-0 so it already
                spans the client width, while 100vw includes the Windows classic
                scrollbar and would shove the capsule ~15px off-centre.
                The scrollbar is hidden rather than styled: the custom-scrollbar
                utility in globals.css paints a visible 6px bar, which is right for
                the CLI terminal and wrong inside a 56px control strip. Keyboard
                users still reach every item by Tab, and focus scrolls into view. */}
            <div
                data-nav-pill
                className="pointer-events-auto flex min-w-0 max-w-[calc(100%-1.5rem)] items-center gap-1 max-[359px]:gap-0.5 overflow-x-auto overscroll-x-contain scroll-p-1.5 whitespace-nowrap rounded-full border border-white/10 bg-zinc-900/70 p-1.5 max-[359px]:p-1 shadow-2xl backdrop-blur-xl [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0"
            >
                {isHome ? (
                    /* Button with hard-nav: forces full reload, clearing all peer/transfer state */
                    <button
                        onClick={() => { window.location.href = '/'; }}
                        // Without this the button's accessible name is computed from the
                        // status text, so screen readers announced it as "Connected"
                        // rather than as the control that returns you home. The status
                        // still announces on change via the aria-live span below.
                        aria-label="Floe home"
                        title={status.label}
                        className="flex items-center gap-2 rounded-full px-2.5 max-[359px]:px-2 py-1.5 sm:px-4 sm:py-2 text-sm font-extrabold tracking-tighter text-white transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-ice"
                    >
                        <span className="relative flex h-2.5 w-2.5 items-center justify-center" aria-hidden="true">
                            <span className={`absolute inset-0 rounded-full ${status.color} opacity-40 blur-[2px] transition-colors duration-500`} />
                            <span className={`h-1.5 w-1.5 rounded-full ${status.color} transition-colors duration-500`} />
                        </span>
                        Floe
                        {/* aria-live so a status change (direct -> offline) is announced */}
                        <span className="sr-only" aria-live="polite">, {status.label}</span>
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
                {/* Section anchors are scroll shortcuts on a page the visitor is
                    already scrolling, so on phones they yield the width to the two
                    destinations: below sm the pill is brand + Download + Docs +
                    GitHub. */}
                <div className="hidden sm:block h-4 w-px bg-white/10 mx-1" />
                <div className="hidden sm:flex items-center gap-1">
                    {SECTIONS.map((section) => {
                        // No sub-sm variants here: the container never renders below sm.
                        const pillClass = [
                            'rounded-full px-3.5 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-ice',
                            section.wide ? 'hidden lg:block' : '',
                            activeSection === section.id
                                ? 'bg-white/[0.07] text-zinc-100'
                                : 'text-zinc-400 hover:bg-white/10 hover:text-white',
                        ]
                            .filter(Boolean)
                            .join(' ');
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
                {/* Destinations, split from the section anchors: Download then Docs
                    side by side, then the GitHub pill keeps its filled endpoint
                    treatment. */}
                <div className="flex items-center gap-0.5 sm:gap-1">
                    {/* Visible at every width. This was md-only on the theory that a
                        phone visitor cannot run the Windows build, but that left the
                        page unreachable from the header on every phone, so the surface
                        most people arrive on offered no route to the desktop app at
                        all. The width it costs below sm is paid for by holding the
                        four section anchors back. */}
                    <Link
                        href="/download"
                        data-umami-event="nav-download"
                        aria-current={onDownload ? 'page' : undefined}
                        className={`rounded-full px-2.5 max-[359px]:px-1 py-1.5 sm:px-3.5 sm:py-2 text-xs sm:text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-ice ${
                            onDownload
                                ? 'bg-white/[0.07] text-zinc-100'
                                : 'text-zinc-400 hover:bg-white/10 hover:text-white'
                        }`}
                    >
                        Download
                    </Link>
                    <a
                        href="https://www.floe.one/docs"
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-full px-2.5 max-[359px]:px-1 py-1.5 sm:px-3.5 sm:py-2 text-xs sm:text-sm font-medium text-zinc-400 transition hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-ice"
                    >
                        Docs
                    </a>
                </div>
                <div className="h-4 w-px bg-white/10 mx-1 max-[359px]:mx-0" />
                <a
                    href="https://github.com/jannskiee/floe"
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 rounded-full bg-white px-2.5 max-[359px]:px-2 py-1.5 sm:px-4 sm:py-2 text-xs sm:text-sm font-bold text-black transition hover:bg-zinc-200 focus-visible:outline-2 focus-visible:outline-ice"
                >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 flex-shrink-0" fill="currentColor" aria-hidden="true">
                        <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                    </svg>
                    {/* sr-only below sm keeps the accessible name when only the mark
                        shows. It is position:absolute, so it is not a flex item and
                        adds no gap: the chip stays 34x26, not 34 plus a gap. */}
                    <span className="sr-only sm:not-sr-only">GitHub</span>
                </a>
            </div>
        </nav>
    );
};
