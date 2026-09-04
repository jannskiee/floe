// Progress arithmetic and the strings it produces, outside App.tsx so they can
// be tested without a DOM or the Wails runtime bindings (the same arrangement
// as settings.ts and history.ts).

import type {MutableRefObject} from 'react';
import {fmtBytes} from './incoming';

export interface Prog {
    fileName: string;
    fileIndex: number;
    fileCount: number;
    fileBytes: number;
    fileSize: number;
    totalBytes: number;
    grandTotal: number;
    // On-disk name the receiver wrote, relative to the save folder. Differs from
    // fileName when a collision was de-duplicated to "name (1).ext". Empty on
    // send events. Anything that opens or reveals a received file must use this.
    savedName: string;
}

export type Marker = {t: number; bytes: number} | null;

// Both mirror client/lib/transferUtils.ts, which mirrors
// cli/engine/transfer/format.go. The web and the CLI already agreed; the
// desktop was the outlier on both counts, so the desktop is what moves.
export function fmtSpeed(bps: number): string {
    if (!isFinite(bps) || bps <= 0) return '';
    // One decimal on BOTH branches. toFixed(0) on the KB branch printed
    // "0 KB/s" while bytes were still moving, and lost a significant digit
    // at every rate under a megabyte.
    return bps >= 1024 * 1024
        ? (bps / 1048576).toFixed(1) + ' MB/s'
        : (bps / 1024).toFixed(1) + ' KB/s';
}

export function fmtEta(sec: number): string {
    if (!isFinite(sec) || sec < 0) return '';
    // Three branches, not two. Without the hours branch a 20 GB transfer on a
    // slow link read "166m 40s" where the web and the CLI both said "2h 46m".
    // Rounding first is what keeps the minutes branch from printing "1m 60s".
    const s = Math.ceil(sec);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** track computes percent, speed, and ETA for a progress event. It uses an
 *  average-since-start speed (stable) keyed off a per-transfer marker ref.
 *
 *  NOT a pure function, despite living in this file: it reads the clock and it
 *  MUTATES `ref` on the first event of a transfer, seeding the marker the rest
 *  of the transfer measures against. It is a stateful accumulator with a
 *  ref-shaped API. `now` is injectable so a test can drive it without stubbing
 *  the global clock; the default keeps every call site unchanged. */
export function track(
    ref: MutableRefObject<Marker>,
    p: Prog,
    now: () => number = Date.now
): {pct: number; label: string} {
    const denom = p.grandTotal > 0 ? p.grandTotal : p.fileSize;
    const num = p.grandTotal > 0 ? p.totalBytes : p.fileBytes;
    const pct = denom > 0 ? Math.min(100, Math.round((num / denom) * 100)) : 0;

    const t = now();
    if (!ref.current) ref.current = {t, bytes: num};
    const dt = (t - ref.current.t) / 1000;
    const speed = dt > 0.2 ? (num - ref.current.bytes) / dt : 0;
    const eta = speed > 0 ? (denom - num) / speed : Infinity;

    const tag = p.fileCount > 1 ? `[${p.fileIndex}/${p.fileCount}] ` : '';
    let label = `${tag}${p.savedName || p.fileName} - ${pct}%  (${fmtBytes(num)} / ${fmtBytes(denom)})`;
    const s = fmtSpeed(speed);
    const e = fmtEta(eta);
    if (s) label += `, ${s}`;
    if (e && pct < 100) label += `, ETA ${e}`;
    return {pct, label};
}
