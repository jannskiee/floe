import React from 'react';
import { formatBytes } from '@/lib/utils';
import { displayPath, visitorCopy } from '@/lib/request/visitorCopy';

export interface PathRow {
    id: string;
    /** The visitor's own relative path. Never a name the host sent. */
    relativePath: string;
    size: number;
}

/** Relative path and size, one row per file, no controls (the owner rejected
 *  per-row icons and hover-revealed actions). Scrolls after about six rows. */
export function PathRows({ rows }: { rows: PathRow[] }) {
    return (
        <ul className="mt-2 max-h-60 divide-y divide-white/[0.06] overflow-y-auto border-y border-white/[0.06]">
            {rows.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-4 py-2">
                    <span className="min-w-0 truncate text-sm text-zinc-200">{displayPath(r.relativePath)}</span>
                    <span className="shrink-0 font-mono text-[11px] text-zinc-500">{formatBytes(r.size)}</span>
                </li>
            ))}
        </ul>
    );
}

/** C-93 and the files that arrived. The rows come from the visitor's own
 *  selection by the sender's own index: files 1 to N-1 after the ack of file
 *  N, never a count the host reported. Kept out of the live region. */
export function ArrivedList({ rows }: { rows: PathRow[] }) {
    if (rows.length === 0) return null;
    return (
        <div className="mt-5">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                {visitorCopy.arrivedHeading}
            </p>
            <PathRows rows={rows} />
        </div>
    );
}
