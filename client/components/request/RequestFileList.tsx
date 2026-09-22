import React from 'react';
import { countLine, visitorCopy } from '@/lib/request/visitorCopy';
import { PathRows, type PathRow } from '@/components/request/ArrivedList';

/** The selection: C-07's count line, the quiet C-35 line when a folder had
 *  empty folders in it, and the files as path and size. Clear, beside Send,
 *  empties it; there is no per-file control. */
export function RequestFileList({
    rows,
    size,
    emptyFolders,
}: {
    rows: PathRow[];
    size: number;
    emptyFolders: number;
}) {
    return (
        <div className="mt-5">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-400">
                {countLine(rows.length, size)}
            </p>
            {emptyFolders > 0 && (
                <p className="mt-1 text-xs text-zinc-500">{visitorCopy.emptyFoldersSkipped}</p>
            )}
            <PathRows rows={rows} />
        </div>
    );
}
