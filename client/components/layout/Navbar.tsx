'use client';

import React, { useEffect, useState } from 'react';


type ConnectionStatus = 'direct' | 'relay' | 'connected' | 'offline';

export const Navbar = () => {
    const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('offline');

    useEffect(() => {
        const handler = (e: Event) => {
            setConnectionStatus((e as CustomEvent).detail as ConnectionStatus);
        };
        window.addEventListener('floe-connection-status', handler);
        return () => window.removeEventListener('floe-connection-status', handler);
    }, []);

    const scrollToSection = (id: string) => {
        const element = document.getElementById(id);
        if (element) {
            element.scrollIntoView({ behavior: 'smooth' });
        }
    };

    const dotColor =
        connectionStatus === 'direct' ? 'bg-green-500' :
        connectionStatus === 'relay' ? 'bg-amber-500' :
        connectionStatus === 'connected' ? 'bg-green-500' :
        'bg-red-500';

    return (
        <nav className="fixed top-0 left-0 right-0 z-50 flex justify-center py-6 pointer-events-none">
            <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-white/10 bg-zinc-900/80 p-1.5 shadow-2xl backdrop-blur-md transition-all hover:border-white/20">
                {/* Plain <a> forces full page reload — clears all peer/transfer state */}
                <a href="/" className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 sm:px-4 sm:py-2 text-xs sm:text-sm font-semibold text-white transition hover:bg-white/10">
                    <div className={`h-2 w-2 rounded-full ${dotColor} animate-pulse transition-colors duration-500`} />
                    Floe.
                </a>
                <div className="h-4 w-px bg-white/10 mx-1" />
                <div className="flex items-center gap-0.5 sm:gap-1">
                    <button onClick={() => scrollToSection('about')} className="rounded-full px-2.5 py-1.5 sm:px-4 sm:py-2 text-xs sm:text-sm font-medium text-zinc-400 transition hover:bg-white/10 hover:text-white">About</button>
                    <button onClick={() => scrollToSection('faq')} className="rounded-full px-2.5 py-1.5 sm:px-4 sm:py-2 text-xs sm:text-sm font-medium text-zinc-400 transition hover:bg-white/10 hover:text-white">FAQs</button>
                </div>
                <div className="h-4 w-px bg-white/10 mx-1" />
                <a href="https://github.com/jannskiee/floe" target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1.5 sm:px-4 sm:py-2 text-xs sm:text-sm font-bold text-black transition hover:bg-zinc-200">
                    <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0 sm:hidden" fill="currentColor" aria-hidden="true">
                        <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                    </svg>
                    <span className="hidden sm:inline">GitHub</span>
                </a>
            </div>
        </nav>
    );
};