import React, { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import { Footer } from '@/components/layout/Footer';
import { LegalToc, type TocItem } from './LegalToc';
import { EYEBROW, FOCUS_RING } from './styles';

/**
 * Shared frame for the legal document pages (/privacy, /terms), following the
 * landing design system: mono ice eyebrow, hairline rules, the asymmetric 4/8
 * grid, with a sticky rail on the left that carries the document switcher,
 * the dated meta and the scroll-spy table of contents. The shared site
 * <Footer /> renders at the bottom.
 *
 * Everything here is server-rendered; the only client island is LegalToc.
 */

const DOCUMENTS = [
    { key: 'privacy', label: 'Privacy policy', href: '/privacy' },
    { key: 'terms', label: 'Terms of use', href: '/terms' },
] as const;

export type LegalDocument = (typeof DOCUMENTS)[number]['key'];

/**
 * The number a section shows, taken from its position in the table of
 * contents so the rail and the heading can never disagree. A section missing
 * from the TOC throws, which fails the prerender at build time.
 */
export function sectionIndex(toc: readonly TocItem[], id: string): string {
    const i = toc.findIndex((item) => item.id === id);
    if (i < 0) throw new Error(`section "${id}" is not in the table of contents`);
    return String(i + 1).padStart(2, '0');
}

export interface LegalDate {
    label: string;
    /** ISO month, e.g. "2026-09", for the <time> element. */
    iso: string;
    text: string;
}

export function LegalShell({
    document,
    title,
    dates,
    historyHref,
    toc,
    intro,
    children,
}: {
    document: LegalDocument;
    title: string;
    dates: LegalDate[];
    historyHref: string;
    toc: TocItem[];
    intro?: ReactNode;
    children: ReactNode;
}) {
    return (
        // print: browsers drop background colors by default, so the dark
        // theme would print as light text on white paper. Every descendant
        // takes the ink color and a visible hairline instead.
        <div className="min-h-dvh bg-zinc-950 font-sans text-zinc-100 print:bg-white print:text-zinc-900 print:[&_*]:text-inherit! print:[&_*]:border-zinc-300!">
            <div className="mx-auto w-full max-w-5xl px-4 pb-10 pt-10 sm:px-6 sm:pt-14">
                <Link
                    href="/"
                    className={`inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-zinc-100 ${FOCUS_RING} print:hidden`}
                >
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to Floe
                </Link>

                <div className="mt-10 grid gap-10 lg:grid-cols-12 lg:gap-12">
                    <header className="lg:sticky lg:top-12 lg:col-span-4 lg:self-start print:static">
                        {/* Document switcher: the same active-tab grammar as
                            the install tabs on the homepage, ice marking the
                            document you are on. */}
                        <nav
                            aria-label="Legal documents"
                            className="flex gap-1 border-b border-white/[0.06] print:hidden"
                        >
                            {DOCUMENTS.map((doc) => {
                                const active = doc.key === document;
                                return (
                                    <Link
                                        key={doc.key}
                                        href={doc.href}
                                        aria-current={active ? 'page' : undefined}
                                        className={`-mb-px border-b px-3 py-2 font-mono text-xs transition ${FOCUS_RING} ${
                                            active
                                                ? 'border-ice text-zinc-100'
                                                : 'border-transparent text-zinc-400 hover:text-zinc-200'
                                        }`}
                                    >
                                        {doc.label}
                                    </Link>
                                );
                            })}
                        </nav>

                        <p className={`mt-8 ${EYEBROW} text-ice`}>
                            Legal
                        </p>
                        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-zinc-100 sm:text-4xl">
                            {title}
                        </h1>

                        <dl className="mt-6 grid grid-cols-[auto_1fr] items-baseline gap-x-5 gap-y-2 text-xs">
                            {dates.map((date) => (
                                <React.Fragment key={date.label}>
                                    {/* zinc-400, not the eyebrow's zinc-600: on /terms these
                                        labels are the only thing telling two dates apart. */}
                                    <dt className={`${EYEBROW} text-zinc-400`}>
                                        {date.label}
                                    </dt>
                                    <dd className="font-mono text-zinc-400">
                                        <time dateTime={date.iso}>{date.text}</time>
                                    </dd>
                                </React.Fragment>
                            ))}
                        </dl>

                        <a
                            href={historyHref}
                            target="_blank"
                            rel="noreferrer"
                            className={`group mt-5 inline-flex items-center gap-1.5 text-sm text-zinc-400 transition hover:text-ice ${FOCUS_RING} print:hidden`}
                        >
                            See every change on GitHub
                            <ArrowUpRight
                                className="h-3.5 w-3.5 text-zinc-600 transition group-hover:text-ice"
                                aria-hidden="true"
                            />
                        </a>

                        <div className="print:hidden">
                            <LegalToc items={toc} />
                        </div>
                    </header>

                    <main className="lg:col-span-8">
                        {intro}
                        <div className={intro ? 'mt-12' : undefined}>{children}</div>
                    </main>
                </div>

                <div className="print:hidden">
                    <Footer />
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
        <section id={id} className="scroll-mt-10 border-t border-white/[0.06] py-9 sm:py-11">
            <div className="flex items-baseline gap-4 sm:gap-6">
                <span className="w-8 shrink-0 font-mono text-xs text-zinc-600" aria-hidden="true">
                    {index}
                </span>
                <div className="min-w-0 flex-1">
                    <h2 className="text-xl font-medium tracking-tight text-zinc-100">{title}</h2>
                    <div className="mt-4 space-y-5 text-[15px] leading-7 text-zinc-400 [&_strong]:font-medium [&_strong]:text-zinc-200">
                        {children}
                    </div>
                </div>
            </div>
        </section>
    );
}

/**
 * The intro block: a plain-language summary on the privacy page, the warranty
 * disclaimer on the terms page. `summary` carries the ice accent, the one the
 * landing sections use for their eyebrows; `caution` stays amber, the color
 * the homepage gives the relay path. Green is reserved for live status.
 */
export function LegalCallout({
    label,
    tone,
    children,
}: {
    label: string;
    tone: 'summary' | 'caution';
    children: ReactNode;
}) {
    const border = tone === 'summary' ? 'border-ice/30' : 'border-amber-400/40';
    const text = tone === 'summary' ? 'text-ice' : 'text-amber-400';
    return (
        <aside className={`border-l-2 py-1 pl-5 sm:pl-6 ${border}`}>
            <p className={`${EYEBROW} ${text}`}>{label}</p>
            <div className="mt-4 space-y-4 text-[15px] leading-7 text-zinc-300 [&_strong]:font-medium [&_strong]:text-zinc-100">
                {children}
            </div>
        </aside>
    );
}

/**
 * Term-and-description rows, the grammar the download page uses for its
 * index: a label column and a body column on a hairline ledger.
 */
export function LegalLedger({ rows }: { rows: { term: string; body: ReactNode }[] }) {
    return (
        <dl className="divide-y divide-white/[0.06] border-y border-white/[0.06]">
            {rows.map((row) => (
                <div
                    key={row.term}
                    className="grid gap-y-1.5 py-4 sm:grid-cols-[9.5rem_1fr] sm:gap-x-6 sm:py-5"
                >
                    <dt className="text-sm font-medium text-zinc-200 sm:pt-0.5">{row.term}</dt>
                    <dd className="min-w-0 space-y-3">{row.body}</dd>
                </div>
            ))}
        </dl>
    );
}

export function LegalList({
    items,
    marker = '→',
}: {
    items: ReactNode[];
    marker?: string;
}) {
    return (
        <ul className="divide-y divide-white/[0.06] border-y border-white/[0.06]">
            {items.map((item, i) => (
                <li key={i} className="flex items-baseline gap-3 py-3">
                    <span className="select-none font-mono text-xs text-zinc-600" aria-hidden="true">
                        {marker}
                    </span>
                    <span className="min-w-0">{item}</span>
                </li>
            ))}
        </ul>
    );
}

// Every link in the body of a legal page points off the page (a provider's
// policy, GitHub, the docs), so they all open in a new tab.
export function LegalLink({ href, children }: { href: string; children: ReactNode }) {
    return (
        <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className={`text-zinc-200 underline decoration-white/20 underline-offset-4 transition hover:text-ice hover:decoration-ice/40 ${FOCUS_RING}`}
        >
            {children}
        </a>
    );
}

export function InlineCode({ children }: { children: ReactNode }) {
    return (
        <code className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[13px] text-zinc-300">
            {children}
        </code>
    );
}
