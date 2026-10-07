import React, { memo } from 'react';
import { formatBytes } from '@/lib/utils';
import { displayPath, visitorCopy } from '@/lib/request/visitorCopy';
import { PATH_TEXT_MAX, isRtl, splitTail } from '@/lib/request/pathTail';

export interface PathRow {
    id: string;
    /** The visitor's own relative path. Never a name the host sent. */
    relativePath: string;
    size: number;
}

/** One line of the visitor's own path, shortened in the MIDDLE at any width:
 *  the head may end in an ellipsis, the tail (file name and extension) stays
 *  whole (pathTail.ts).
 *
 *  - Assistive tech reads the path once, whole, from the sr-only copy; the two
 *    drawn halves are aria-hidden (two flex items read as two lines, cut
 *    mid-word: "full se" then "t DSC_4000.NEF").
 *  - A right-to-left name lays the row out right to left (head on the right,
 *    its ellipsis beside the tail), the order dir="auto" would choose.
 *  - When the tail alone is wider than the line (a 280 px phone at large
 *    text), it gives way from its START: its box runs the other way round
 *    and the <bdi> keeps the name's own order, so the extension stays.
 *  - Line breaks and tabs in a name fold into spaces (legal on macOS and
 *    Linux; whitespace-pre would draw them), and whitespace-pre keeps a space
 *    at the split on its side of the line. */
export const PathText = memo(function PathText({ path, className = '' }: { path: string; className?: string }) {
    const shown = displayPath(path.replace(/[\t\n\v\f\r]/g, ' '), PATH_TEXT_MAX);
    const [head, tail] = splitTail(shown);
    const rtl = isRtl(shown);
    return (
        <span dir={rtl ? 'rtl' : 'ltr'} className={`relative flex min-w-0 ${className}`}>
            <span className="sr-only">{shown}</span>
            {head && (
                <span aria-hidden="true" className="min-w-0 overflow-hidden text-ellipsis whitespace-pre">
                    {head}
                </span>
            )}
            <span
                aria-hidden="true"
                dir={rtl ? 'ltr' : 'rtl'}
                className="max-w-full shrink-0 overflow-hidden text-ellipsis whitespace-pre"
            >
                <bdi dir={rtl ? 'rtl' : 'ltr'}>{tail}</bdi>
            </span>
        </span>
    );
});

/** Relative path and size, one row per file, no controls (the owner rejected
 *  per-row icons and hover-revealed actions). Scrolls after about six rows,
 *  four on a window under 800 px tall, so Send stays in view on a laptop
 *  (1366 x 657 inside the browser) once six or more files are picked.
 *  Memoized: in Sending the page re-renders on every 500 ms progress tick, and
 *  the rows (up to 10,000) change only when a file arrives. */
export const PathRows = memo(function PathRows({ rows }: { rows: PathRow[] }) {
    return (
        <ul className="mt-2 max-h-60 divide-y divide-white/[0.06] overflow-y-auto border-y border-white/[0.06] [@media(max-height:50rem)]:max-h-40">
            {rows.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-4 py-2">
                    <PathText path={r.relativePath} className="text-sm text-zinc-200" />
                    <span className="shrink-0 font-mono text-[0.6875rem] text-zinc-400">{formatBytes(r.size)}</span>
                </li>
            ))}
        </ul>
    );
});

/** C-93 and the files that arrived. The rows come from the visitor's own
 *  selection by the sender's own index: files 1 to N-1 after the ack of file
 *  N, never a count the host reported. Kept out of the live region. */
export function ArrivedList({ rows }: { rows: PathRow[] }) {
    if (rows.length === 0) return null;
    return (
        <div className="mt-5">
            <p className="font-mono text-[0.625rem] uppercase tracking-[0.2em] text-zinc-400">
                {visitorCopy.arrivedHeading}
            </p>
            <PathRows rows={rows} />
        </div>
    );
}
