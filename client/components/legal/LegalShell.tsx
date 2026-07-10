import React, { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

/**
 * Shared frame for the legal document pages (/privacy, /terms), following the
 * landing design system: mono ice eyebrow, hairline rules, asymmetric 4/8 grid
 * with a sticky on-page nav in the left rail.
 */
export function LegalShell({
    eyebrow,
    title,
    updated,
    toc,
    footerLinks,
    intro,
    children,
}: {
    eyebrow: string;
    title: string;
    updated: string;
    toc: { id: string; label: string }[];
    footerLinks: { name: string; href: string }[];
    intro?: ReactNode;
    children: ReactNode;
}) {
    return (
        <div className="min-h-dvh bg-zinc-950 font-sans text-zinc-100">
            <div className="mx-auto w-full max-w-5xl px-4 pb-10 pt-10 sm:px-6 sm:pt-14">
                <Link
                    href="/"
                    className="inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-zinc-100"
                >
                    <ArrowLeft className="h-4 w-4" /> Back to Floe
                </Link>
                <div className="mt-10 grid gap-10 lg:grid-cols-12 lg:gap-12">
                    <header className="lg:sticky lg:top-12 lg:col-span-4 lg:self-start">
                        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ice">{eyebrow}</p>
                        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-zinc-100 sm:text-4xl">
                            {title}
                        </h1>
                        <p className="mt-4 font-mono text-xs text-zinc-500">{updated}</p>
                        <nav aria-label="On this page" className="mt-10 hidden lg:block">
                            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-600">
                                On this page
                            </p>
                            <ul className="mt-4 space-y-3">
                                {toc.map((item, i) => (
                                    <li key={item.id}>
                                        <a
                                            href={`#${item.id}`}
                                            className="group flex items-baseline gap-3 text-sm text-zinc-400 transition hover:text-ice"
                                        >
                                            <span className="font-mono text-xs text-zinc-600 transition group-hover:text-ice/70">
                                                {String(i + 1).padStart(2, '0')}
                                            </span>
                                            {item.label}
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        </nav>
                    </header>
                    <main className="lg:col-span-8">
                        {intro}
                        <div className={intro ? 'mt-10' : undefined}>{children}</div>
                    </main>
                </div>
                <div className="mt-16 flex flex-col items-center justify-between gap-3 border-t border-white/[0.06] pt-6 text-xs text-zinc-600 sm:flex-row">
                    <p>&copy; {new Date().getFullYear()} Floe. Built on WebRTC.</p>
                    <div className="flex gap-5">
                        {footerLinks.map((link) => (
                            <Link
                                key={link.name}
                                href={link.href}
                                className="transition-colors hover:text-zinc-300"
                            >
                                {link.name}
                            </Link>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}

export function LegalSection({
    id,
    index,
    title,
    children,
}: {
    id: string;
    index: string;
    title: string;
    children: ReactNode;
}) {
    return (
        <section id={id} className="scroll-mt-8 border-t border-white/[0.06] py-8 sm:py-10">
            <div className="flex gap-4 sm:gap-5">
                <span className="w-6 shrink-0 pt-0.5 font-mono text-xs text-zinc-600" aria-hidden="true">
                    {index}
                </span>
                <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-medium tracking-tight text-zinc-100">{title}</h2>
                    <div className="mt-3 space-y-4 text-sm leading-relaxed text-zinc-400">{children}</div>
                </div>
            </div>
        </section>
    );
}

export function LegalCallout({
    label,
    tone,
    children,
}: {
    label: string;
    tone: 'positive' | 'caution';
    children: ReactNode;
}) {
    const border = tone === 'positive' ? 'border-green-400/40' : 'border-amber-400/40';
    const text = tone === 'positive' ? 'text-green-400' : 'text-amber-400';
    return (
        <aside className={`border-l-2 py-1 pl-5 ${border}`}>
            <p className={`font-mono text-[11px] uppercase tracking-[0.2em] ${text}`}>{label}</p>
            <div className="mt-3 space-y-3 text-sm leading-relaxed text-zinc-300">{children}</div>
        </aside>
    );
}

export function LegalList({
    items,
    marker = '→',
}: {
    items: ReactNode[];
    marker?: string | null;
}) {
    return (
        <ul className="divide-y divide-white/[0.06] border-y border-white/[0.06]">
            {items.map((item, i) => (
                <li key={i} className="flex items-baseline gap-3 py-3">
                    {marker !== null && (
                        <span className="select-none font-mono text-xs text-zinc-600" aria-hidden="true">
                            {marker}
                        </span>
                    )}
                    <span className="min-w-0">{item}</span>
                </li>
            ))}
        </ul>
    );
}

export function InlineCode({ children }: { children: ReactNode }) {
    return (
        <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-xs text-zinc-300">
            {children}
        </code>
    );
}
