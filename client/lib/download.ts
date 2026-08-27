/**
 * File name hygiene for received files.
 *
 * Every name here is peer-supplied and arrives unvalidated: `classifyControl`
 * in lib/transfer/protocol.ts casts the metadata JSON straight to its interface,
 * so `fileName` is whatever the other side chose to send.
 *
 * Three sanitized forms, because the three consumers need different things:
 *
 *  - `sanitizeFileName` is flat, for the `download` attribute of an anchor. It
 *    keeps only the last path segment, so a name like `../../etc/passwd` can
 *    only ever suggest `passwd`.
 *  - `sanitizeZipEntryName` keeps the directory structure, because a CLI folder
 *    send legitimately puts `project/src/main.go` on the wire and flattening it
 *    would break a working feature. It drops the segments that could escape.
 *  - `sanitizeDisplayText` is for text a person reads (an error banner, a
 *    status line): the same invisible characters go and the length is capped,
 *    and none of the file-system rules apply.
 *
 * The two file-name forms apply the Windows rules unconditionally, unlike the Go receiver, which
 * only applies them when it is running on Windows. The difference is deliberate:
 * the Go receiver writes to a disk whose OS it knows, while a ZIP built here is
 * portable and may be extracted on Windows no matter where it was downloaded, so
 * entry names have to satisfy the strictest target.
 */

/** Characters Win32 reserves in a file name. */
const WINDOWS_RESERVED = /[<>:"|?*]/g;

/**
 * The C0 and C1 control characters, DEL, and all four Unicode bidi controls.
 *
 * The bidi ones are the file name spoof: `photo‮gnp.exe` renders as
 * `photoexe.png` in Explorer, Finder and GNOME Files alike. Right-to-left
 * scripts carry their own directionality and use none of these, so Arabic and
 * Hebrew names pass through untouched. U+061C is easy to miss: it is the fourth
 * `Bidi_Control` character and reorders exactly like the RLM beside it.
 */
const INVISIBLE =
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Win32 device names, matched against the whole segment, case-insensitively. */
const DEVICE_NAMES = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
    'CONIN$', 'CONOUT$',
]);

/** The name used when a peer supplies nothing usable. Matches the Go receiver. */
const FALLBACK = 'received_file';

/** Longest single path segment we will emit, in UTF-16 units. */
const MAX_SEGMENT = 200;

/** Longest peer-supplied string shown to a person, in UTF-16 units. */
const MAX_DISPLAY = 200;

/**
 * Makes a peer-supplied string safe to put in front of a person: the same
 * invisible characters `sanitizeSegment` removes (controls and the four bidi
 * controls) are removed, and the length is capped with an ellipsis. Display
 * only: a name that will touch a disk or a ZIP goes through `sanitizeFileName`
 * or `sanitizeZipEntryName`, which also apply the Windows rules; text in an
 * error banner is not a file name and keeps its `:` and `?`. React escapes
 * HTML, not this: a bidi override in a rendered string reorders the glyphs
 * around it exactly as it would in a file manager.
 *
 * When the cap bites, the stem is shortened and the extension is kept: a plain
 * cut at the end would hide what a long name is (251 a's plus `.exe` would show
 * as a's and an ellipsis), which is the disguise this exists to close. Same
 * 16-unit tail rule as `sanitizeSegment`; a leading dot is a dotfile, not an
 * extension. Never splits a surrogate pair.
 */
export function sanitizeDisplayText(text: unknown, max = MAX_DISPLAY): string {
    if (typeof text !== 'string') return '';
    const out = text.replace(INVISIBLE, '');
    if (out.length <= max) return out;
    const dot = out.lastIndexOf('.');
    const ext = dot > 0 && out.length - dot <= 16 ? out.slice(dot) : '';
    let stem = out.slice(0, max - 1 - ext.length);
    const last = stem.charCodeAt(stem.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) stem = stem.slice(0, -1);
    return stem + '…' + ext;
}

/**
 * Cleans one path segment. Returns '' when nothing survives; callers decide
 * whether that means "drop it" or "use the fallback".
 */
function sanitizeSegment(segment: string): string {
    let out = segment.replace(INVISIBLE, '').replace(WINDOWS_RESERVED, '_');

    // Win32 drops trailing dots and spaces while resolving a path, so a name
    // ending in one does not refer to the file it appears to. In the Go receiver
    // that is what silently detached the Mark of the Web from a saved file.
    out = out.replace(/[. ]+$/, '');
    if (out === '') return '';

    if (DEVICE_NAMES.has(out.toUpperCase())) return `_${out}`;

    // Cap the length. fflate rejects an entire archive if any one entry name is
    // too long, so without this a single hostile name denies the ZIP to every
    // other file in the transfer. Keep the extension, trim the stem, and never
    // split a surrogate pair.
    if (out.length > MAX_SEGMENT) {
        const dot = out.lastIndexOf('.');
        const ext = dot > 0 && out.length - dot <= 16 ? out.slice(dot) : '';
        let stem = out.slice(0, MAX_SEGMENT - ext.length);
        if (/[\uD800-\uDBFF]$/.test(stem)) stem = stem.slice(0, -1);
        out = stem + ext;
    }
    return out;
}

/**
 * Resolves a peer-supplied name to a single safe file name, with no directory
 * part. Use for anything that names a file on the user's own disk.
 */
export function sanitizeFileName(name: unknown): string {
    if (typeof name !== 'string') return FALLBACK;

    // Both separators, so a Windows-style name cannot smuggle a path through a
    // browser that only treats '/' as one.
    const segments = name.split(/[/\\]/);
    const leaf = sanitizeSegment(segments[segments.length - 1] ?? '');
    return leaf === '' || leaf === '.' || leaf === '..' ? FALLBACK : leaf;
}

/**
 * Resolves a peer-supplied name to a ZIP entry path, preserving directories.
 *
 * `__proto__` is rewritten here and nowhere else. It is a perfectly legal file
 * name, so `sanitizeFileName` leaves it alone; the constraint belongs to fflate,
 * which flattens entries into a plain object. Assigning that key sets the
 * object's prototype instead of adding an entry, and the file disappears from
 * the archive. Measured with a 5-byte payload: a bare `{}` produced a 525-byte
 * archive containing the other file plus one junk directory entry per payload
 * byte (`0/`, `1/`, ...), which scales to roughly 90x amplification and freezes
 * the tab. Using a null-prototype object removes the amplification but the file
 * is still silently dropped, so both that and this rename are required.
 */
export function sanitizeZipEntryName(name: unknown): string {
    if (typeof name !== 'string') return FALLBACK;

    // Sanitize BEFORE the __proto__ check, never after. sanitizeSegment trims
    // trailing dots and spaces and strips invisible characters, so checking
    // first lets any decorated spelling rebuild the exact key afterwards:
    // "__proto__ " sanitized to "__proto__" and the file vanished from the
    // archive again, with no error and a plausible-looking ZIP.
    const parts = name
        .split(/[/\\]/)
        .filter((p) => p !== '' && p !== '.' && p !== '..')
        .map(sanitizeSegment)
        .map((p) => (p === '__proto__' ? '_proto_' : p))
        .filter((p) => p !== '');

    return parts.length === 0 ? FALLBACK : parts.join('/');
}

/**
 * Resolves a collision-free name for a ZIP entry.
 * If `name` is already in `used`, appends " (N)" before the extension
 * until a free slot is found, then adds the result to `used`.
 */
export function dedupeFileName(name: string, used: Set<string>): string {
    if (!used.has(name)) {
        used.add(name);
        return name;
    }

    // Split the directory off first. Without this the extension search runs over
    // the whole path, so `dir.v2/README` de-duplicates to `dir (1).v2/README`,
    // renaming the directory instead of the file.
    const slash = name.lastIndexOf('/');
    const dir = slash === -1 ? '' : name.slice(0, slash + 1);
    const leaf = slash === -1 ? name : name.slice(slash + 1);

    const dot = leaf.lastIndexOf('.');
    const stem = dot === -1 ? leaf : leaf.slice(0, dot);
    const ext = dot === -1 ? '' : leaf.slice(dot);

    let counter = 1;
    let finalName = `${dir}${stem} (${counter})${ext}`;
    while (used.has(finalName)) {
        counter++;
        finalName = `${dir}${stem} (${counter})${ext}`;
    }
    used.add(finalName);
    return finalName;
}

/**
 * Builds the entry map handed to fflate.
 *
 * Extracted from the download hook so the prototype-key behavior is testable
 * without a DOM. Two things here are load-bearing and look removable:
 *
 *  - the null-prototype container, which stops a `__proto__` entry poisoning
 *    our object and generating one junk directory entry per payload byte, and
 *  - sanitizing BEFORE de-duplicating. Reversed, `a:b.txt` and `a?b.txt` are
 *    blessed as distinct and then both collapse to `a_b.txt`, so one silently
 *    overwrites the other.
 */
export function buildZipEntries(
    items: { fileName: unknown; bytes: Uint8Array }[]
): Record<string, Uint8Array> {
    const entries = Object.create(null) as Record<string, Uint8Array>;
    const used = new Set<string>();
    for (const item of items) {
        entries[dedupeFileName(sanitizeZipEntryName(item.fileName), used)] = item.bytes;
    }
    return entries;
}
