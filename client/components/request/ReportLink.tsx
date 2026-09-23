import React from 'react';
import { visitorCopy } from '@/lib/request/visitorCopy';

/** C-12: the right side of the Ready footer (W1), and only there (D-091
 *  Q-C15). The href is report.ts's mailto, built from the origin and the path
 *  and never from the fragment; with no valid link id there is no link. */
export function ReportLink({ href }: { href: string | null }) {
    if (!href) return null;
    return (
        <a
            href={href}
            rel="noreferrer"
            className="shrink-0 text-xs text-zinc-500 underline underline-offset-2 transition hover:text-zinc-300 focus-visible:outline-2 focus-visible:outline-ice"
        >
            {visitorCopy.reportLink}
        </a>
    );
}
