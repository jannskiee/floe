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

// Display columns (R5-11). In the Done row's 12 px mono a CJK, Hangul or
// fullwidth character, and an emoji, takes about two cells of a Latin one, so
// a cut that counted characters let CSS cut the timestamp off a wide label.
// These are the East Asian Wide (W) and Fullwidth (F) blocks; pictographs are
// matched by their Unicode properties below.
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
    [0x1100, 0x115f], // Hangul Jamo initial consonants
    [0x2e80, 0x303e], // CJK radicals and Kangxi, CJK symbols and punctuation
    [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul compatibility Jamo, CJK enclosed and compatibility
    [0x3400, 0x4dbf], // CJK Extension A
    [0x4e00, 0x9fff], // CJK Unified Ideographs
    [0xa000, 0xa4cf], // Yi
    [0xa960, 0xa97f], // Hangul Jamo Extended-A
    [0xac00, 0xd7a3], // Hangul syllables
    [0xf900, 0xfaff], // CJK Compatibility Ideographs
    [0xfe10, 0xfe19], // vertical forms
    [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
    [0xff00, 0xff60], // fullwidth forms
    [0xffe0, 0xffe6], // fullwidth signs
    [0x16fe0, 0x16fe4], // ideographic symbols
    [0x17000, 0x18cff], // Tangut
    [0x1b000, 0x1b2ff], // Kana supplement and extensions, Nushu
    [0x1f200, 0x1f2ff], // enclosed ideographic supplement
    [0x20000, 0x3fffd], // CJK Extension B and later
];
const EMOJI = /\p{Emoji_Presentation}/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
// No cell at all: combining marks (the variation selectors among them) and
// format characters such as the zero-width joiner.
const ZERO_WIDTH = /[\p{Mn}\p{Me}\p{Cf}]/u;
// Variation selector 16, which asks for the emoji form of the character before it.
const VS16 = '️';

/** The cells one code point takes; `next` is the code point after it, since
 *  U+FE0F asks for an emoji form: a text-style pictograph's, or a keycap's
 *  digit, # or * (1, U+FE0F, U+20E3), which counted one cell while it was
 *  drawn as an emoji. After a character with no emoji form it overcounts. */
function cellsOf(cp: string, next: string | undefined): number {
    if (ZERO_WIDTH.test(cp)) return 0;
    if (EMOJI.test(cp) || next === VS16) return 2;
    const c = cp.codePointAt(0) ?? 0;
    if (c >= 0x1f000 && PICTOGRAPH.test(cp)) return 2;
    return WIDE_RANGES.some(([lo, hi]) => c >= lo && c <= hi) ? 2 : 1;
}

// The cut keeps whole what a reader sees as one character, a grapheme
// cluster: a flag's two regional indicators, a family's pictographs and
// joiners, a skin tone's modifier, a keycap, a letter and its marks. A cut
// between code points could keep half of a flag or leave a lone skin tone.
// Intl.Segmenter has been in Chromium since 87 (client/lib/request/pathTail.ts
// uses it the same way); without it the cut falls back to whole code points.
let graphemes: Intl.Segmenter | null | undefined;
function clustersOf(s: string): string[] {
    if (graphemes === undefined) {
        try {
            graphemes = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
                ? new Intl.Segmenter(undefined, {granularity: 'grapheme'})
                : null;
        } catch {
            graphemes = null;
        }
    }
    return graphemes ? Array.from(graphemes.segment(s), (g) => g.segment) : Array.from(s);
}

/** displayCols is how many monospace cells s takes: two for an East Asian
 *  Wide or Fullwidth character and for an emoji, none for a combining mark or
 *  a format character (a joiner, a variation selector), one for anything
 *  else. An overcount only cuts a little more. Display only. */
export function displayCols(s: string): number {
    const cps = Array.from(s);
    let n = 0;
    for (let i = 0; i < cps.length; i++) n += cellsOf(cps[i], cps[i + 1]);
    return n;
}

/** middleCut keeps the start and the end of s within max display columns,
 *  with the ellipsis between them. It slices whole grapheme clusters
 *  (clustersOf), never UTF-16 units, so no surrogate pair, flag, emoji
 *  sequence or letter with its marks is split, and the end part never starts
 *  with a mark or a joiner cut off from its base. A cluster takes the cells of
 *  its code points added up, so the total is displayCols(s). */
function middleCut(s: string, max: number): string {
    const cps = Array.from(s);
    const cpCells = cps.map((c, i) => cellsOf(c, cps[i + 1]));
    const parts = clustersOf(s);
    let at = 0;
    const cells = parts.map((p) => {
        let n = 0;
        for (let k = Array.from(p).length; k > 0; k--) n += cpCells[at++];
        return n;
    });
    if (cells.reduce((a, b) => a + b, 0) <= max) return s;
    const room = Math.max(2, max - ELLIPSIS.length);
    let head = 0;
    let used = 0;
    while (head < parts.length && used + cells[head] <= Math.ceil(room / 2)) used += cells[head++];
    let tail = parts.length;
    let tailUsed = 0;
    while (tail > head && tailUsed + cells[tail - 1] <= room - used) tailUsed += cells[--tail];
    while (tail < parts.length && cells[tail] === 0) tail++;
    return `${parts.slice(0, head).join('')}${ELLIPSIS}${parts.slice(tail).join('')}`;
}

// A drop folder's own name ends in this PC's date and time and, when that
// name was taken, a number (desktop/dropfolder.go dropFolderName and
// makeDropFolder): "Acme footage 2026-09-14 1405 (2)".
const DROP_STAMP = /^(.*?)( \d{4}-\d{2}-\d{2} \d{4}(?: \(\d+\))?)$/su;

/** shortDropFolder fits a drop folder's own name into max display columns for
 *  the Done row (R5-11): the date, the time and any " (n)" stay whole, since
 *  they tell two drops apart, and only the label before them is cut in its
 *  middle. A name without that ending, or with no room left for a label, is
 *  cut in its middle as a whole. A name that fits comes back unchanged.
 *  Display only. */
export function shortDropFolder(name: string, max: number): string {
    if (displayCols(name) <= max) return name;
    const m = DROP_STAMP.exec(name);
    if (m) {
        const room = max - displayCols(m[2]);
        if (room >= ELLIPSIS.length + 2) return `${middleCut(m[1], room)}${m[2]}`;
    }
    return middleCut(name, max);
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
