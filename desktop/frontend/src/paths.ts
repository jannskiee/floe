// Path comparison and merging for the staged-file list, outside App.tsx so they
// can be tested without a DOM (the same arrangement as settings.ts).

/** The platform is a PARAMETER, not a module-level read, and that is the whole
 *  point of this file existing. App.tsx computes isWindows from
 *  navigator.userAgent at module scope; lifting that read into here would make
 *  these functions untestable, because every *.test.ts runs under vitest's
 *  `node` environment where navigator.userAgent is Node's own. The test would
 *  silently exercise the POSIX branch only, on a product that ships Windows
 *  first. vite.config.ts documents the same trap for App.tsx, where it is
 *  worked around by pinning a Windows userAgent in environmentOptions. */

/** baseName is the last path segment, splitting on either separator because the
 *  Go side sends whatever the host produced. Returns undefined for an empty
 *  string, which is Array.pop's answer and every caller already handles. */
export const baseName = (p: string) => p.split(/[\\/]/).pop();

/** normPath folds a path for comparison only. Windows paths compare
 *  case-insensitively; the ORIGINAL string is what gets displayed and handed to
 *  the Go side, so this result must never be stored. */
export const normPath = (p: string, windows: boolean) => (windows ? p.toLowerCase() : p);

const ELLIPSIS = '...';
// A drive ("D:\"), a network share ("\\server\share\") or a POSIX root.
const ROOT = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/]|\/)/;

/** shortPath fits a path, or a single folder name, into `max` characters by
 *  cutting its middle: the drive root and the last folders stay
 *  ("D:\...\Acme footage 2026-09-14 1405"), and when even the last folder is
 *  too long, the start and the end of the whole string do. Cutting the end
 *  instead would hide exactly the part that tells two drops apart, the
 *  timestamp in the folder name. A path that fits comes back unchanged, so a caller knows
 *  it was shortened when the result differs; the full path then belongs in a
 *  native title beside it. Display only. */
export function shortPath(p: string, max: number): string {
    if (p.length <= max) return p;
    const root = ROOT.exec(p)?.[0] ?? '';
    const sep = p.includes('\\') ? '\\' : '/';
    const parts = p.slice(root.length).split(/[\\/]+/).filter(Boolean);
    if (root) {
        for (let k = parts.length - 1; k >= 1; k--) {
            const s = `${root}${ELLIPSIS}${sep}${parts.slice(-k).join(sep)}`;
            if (s.length <= max) return s;
        }
    }
    const room = Math.max(2, max - ELLIPSIS.length);
    const head = Math.floor(room / 2);
    return `${p.slice(0, head)}${ELLIPSIS}${p.slice(p.length - (room - head))}`;
}

/** mergePaths appends `add` to `prev`, skipping anything already present under
 *  normPath comparison. Order is preserved and the original spelling is kept. */
export function mergePaths(prev: string[], add: string[], windows: boolean): string[] {
    const seen = new Set(prev.map((p) => normPath(p, windows)));
    const out = [...prev];
    for (const p of add) {
        if (!seen.has(normPath(p, windows))) {
            seen.add(normPath(p, windows));
            out.push(p);
        }
    }
    return out;
}
