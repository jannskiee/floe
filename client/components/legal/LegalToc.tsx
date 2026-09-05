'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { pickActiveSection } from '@/lib/legalToc';
import { EYEBROW, FOCUS_RING } from './styles';

export interface TocItem {
    id: string;
    label: string;
}

interface ActiveRow {
    id: string;
    /** The active row's box inside the rail list, for the indicator. */
    top: number;
    height: number;
}

/**
 * "On this page" for the legal documents: a numbered list that follows the
 * reader. From lg up it sits in the sticky rail with a hairline track and a
 * one-pixel ice segment that slides to the current section; below lg it is a
 * native <details>, collapsed, so a phone reader gets the list without a
 * sticky strip eating the viewport.
 *
 * Hydration contract (e2e/hydration.spec.ts covers both routes): the first
 * client render must match the server HTML, so nothing here reads window
 * during render. The active row is set from an effect after mount, the same
 * way Navbar's scroll-spy works, and the server renders the list with no item
 * marked.
 */
export function LegalToc({ items }: { items: TocItem[] }) {
    const [active, setActive] = useState<ActiveRow | null>(null);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const sections = items
            .map((item) => document.getElementById(item.id))
            .filter((el): el is HTMLElement => el !== null);
        if (sections.length === 0) return;
        const ids = new Set(sections.map((el) => el.id));

        // A section the reader asked for by name (a TOC click, or a deep link
        // like /terms#relay) stays current until they scroll by hand. Without
        // this, a short page that cannot scroll the clicked section up to the
        // reading line lands at the bottom, where the bottom rule marks the
        // last entry instead of the one they clicked.
        let pinned: string | null = ids.has(location.hash.slice(1)) ? location.hash.slice(1) : null;
        const onHashChange = () => {
            const id = location.hash.slice(1);
            pinned = ids.has(id) ? id : null;
            schedule();
        };
        const unpin = () => {
            if (!pinned) return;
            pinned = null;
            schedule();
        };

        // One measurement per frame however many scroll events arrive: a
        // trackpad can fire dozens per frame and each getBoundingClientRect
        // forces layout. The row's box is read in the same frame as the
        // section pick, so a resize that keeps the same section current (the
        // lg breakpoint, where the rail list appears) still refreshes it.
        let frame = 0;
        const measure = () => {
            frame = 0;
            const atBottom =
                window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
            const id =
                pinned ??
                pickActiveSection(
                    sections.map((el) => ({ id: el.id, top: el.getBoundingClientRect().top })),
                    atBottom
                );
            const row = id ? listRef.current?.querySelector<HTMLElement>(`[data-toc-id="${id}"]`) : null;
            const next = id ? { id, top: row?.offsetTop ?? 0, height: row?.offsetHeight ?? 0 } : null;
            setActive((prev) =>
                prev && next && prev.id === next.id && prev.top === next.top && prev.height === next.height
                    ? prev
                    : next
            );
        };
        const schedule = () => {
            if (!frame) frame = requestAnimationFrame(measure);
        };
        measure();
        window.addEventListener('scroll', schedule, { passive: true });
        window.addEventListener('resize', schedule);
        window.addEventListener('hashchange', onHashChange);
        // Hand control back to the spy on the reader's own input, not on the
        // scroll events a smooth scroll to the clicked section produces.
        window.addEventListener('wheel', unpin, { passive: true });
        window.addEventListener('touchstart', unpin, { passive: true });
        window.addEventListener('keydown', unpin);
        return () => {
            if (frame) cancelAnimationFrame(frame);
            window.removeEventListener('scroll', schedule);
            window.removeEventListener('resize', schedule);
            window.removeEventListener('hashchange', onHashChange);
            window.removeEventListener('wheel', unpin);
            window.removeEventListener('touchstart', unpin);
            window.removeEventListener('keydown', unpin);
        };
    }, [items]);

    const rows = items.map((item, i) => {
        const current = item.id === active?.id;
        return (
            <li key={item.id} data-toc-id={item.id}>
                <a
                    href={`#${item.id}`}
                    aria-current={current ? 'location' : undefined}
                    className={`group flex items-baseline gap-3 py-1.5 text-sm transition-colors ${FOCUS_RING} ${
                        current ? 'text-zinc-100' : 'text-zinc-400 hover:text-zinc-100'
                    }`}
                >
                    <span
                        className={`w-5 shrink-0 font-mono text-xs tabular-nums transition-colors ${
                            current ? 'text-ice' : 'text-zinc-600 group-hover:text-zinc-400'
                        }`}
                        aria-hidden="true"
                    >
                        {String(i + 1).padStart(2, '0')}
                    </span>
                    <span className="min-w-0">{item.label}</span>
                </a>
            </li>
        );
    });

    return (
        <>
            {/* Rail version: the wrapper's left border is the track and the
                ice segment is positioned over it from the active row's box
                (the wrapper, not the list, so the <ol> keeps a valid content
                model). The slide is a transform so it stays on the compositor;
                reduced motion snaps instead. role="list" because Tailwind's
                preflight removes list markers, and Safari drops list semantics
                with them. */}
            <nav aria-label="On this page" className="mt-10 hidden lg:block">
                <p className={`${EYEBROW} text-zinc-600`}>On this page</p>
                <div ref={listRef} className="relative mt-4 border-l border-white/[0.06] pl-4">
                    <span
                        aria-hidden="true"
                        className={`absolute -left-px top-0 w-px bg-ice transition-[transform,height,opacity] duration-300 ease-out motion-reduce:transition-none ${
                            active && active.height > 0 ? 'opacity-100' : 'opacity-0'
                        }`}
                        style={{
                            transform: `translateY(${active?.top ?? 0}px)`,
                            height: active?.height ?? 0,
                        }}
                    />
                    <ol role="list">{rows}</ol>
                </div>
            </nav>

            {/* Phone and tablet version: a native disclosure, closed by
                default. The server renders it closed too, so the markup
                matches on hydration. */}
            <details className="group mt-8 border-y border-white/[0.06] lg:hidden">
                <summary
                    className={`flex cursor-pointer list-none items-center justify-between py-3 ${EYEBROW} text-zinc-500 transition-colors hover:text-zinc-300 ${FOCUS_RING} [&::-webkit-details-marker]:hidden`}
                >
                    On this page
                    <ChevronDown
                        className="h-4 w-4 text-zinc-600 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
                        aria-hidden="true"
                    />
                </summary>
                <ol role="list" className="pb-3">
                    {rows}
                </ol>
            </details>
        </>
    );
}
