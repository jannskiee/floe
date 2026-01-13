import React from 'react';

export const Navbar = () => {
    const scrollToSection = (id: string) => {
        const element = document.getElementById(id);
        if (element) {
            element.scrollIntoView({ behavior: 'smooth' });
        }
    };

    return (
        <nav className="fixed top-0 left-0 right-0 z-50 flex justify-center py-6 pointer-events-none">
            <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-white/10 bg-zinc-900/80 p-1.5 shadow-2xl backdrop-blur-md transition-all hover:border-white/20">
                <button onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })} className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10">
                    <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                    Floe.
                </button>
                <div className="h-4 w-px bg-white/10 mx-1" />
                <div className="flex items-center gap-1">
                    <button onClick={() => scrollToSection('about')} className="rounded-full px-4 py-2 text-sm font-medium text-zinc-400 transition hover:bg-white/10 hover:text-white">About</button>
                    <button onClick={() => scrollToSection('faq')} className="rounded-full px-4 py-2 text-sm font-medium text-zinc-400 transition hover:bg-white/10 hover:text-white">FAQs</button>
                </div>
                <div className="h-4 w-px bg-white/10 mx-1" />
                <a href="https://github.com" target="_blank" rel="noreferrer" className="rounded-full bg-white px-4 py-2 text-sm font-bold text-black transition hover:bg-zinc-200">GitHub</a>
            </div>
        </nav>
    );
};