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

    // Cap the length. An archive refuses an entry name too long for its header
    // (planZip in lib/zipWriter.ts), so without this a single hostile name
    // denies the ZIP to every other file in the transfer. Keep the extension,
    // trim the stem, and never split a surrogate pair.
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
 * name, so `sanitizeFileName` leaves it alone; the constraint belonged to
 * fflate's zip(), which took its entries as a plain object. Assigning that key
 * set the object's prototype instead of adding an entry, and the file
 * disappeared from the archive. Measured with a 5-byte payload: a bare `{}`
 * produced a 525-byte archive containing the other file plus one junk
 * directory entry per payload byte (`0/`, `1/`, ...), which scales to roughly
 * 90x amplification and freezes the tab. The streaming writer that replaced
 * zip() takes names as strings in a list, and the rename stays so an archive
 * names a file as it always has, and so a name can never become that key again.
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
export function dedupeFileName(name: string, used: NameSet): string {
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

    // A name whose only dot is its first character (`.env`) has no extension,
    // so the number goes at its end, as the Go engine's candidatePath numbers
    // it. Read as an extension, it came out as ` (1).env`.
    const dot = leaf.lastIndexOf('.');
    const hasExt = dot > 0;
    const stem = hasExt ? leaf.slice(0, dot) : leaf;
    const ext = hasExt ? leaf.slice(dot) : '';

    let counter = 1;
    let finalName = `${dir}${stem} (${counter})${ext}`;
    while (used.has(finalName)) {
        counter++;
        finalName = `${dir}${stem} (${counter})${ext}`;
    }
    used.add(finalName);
    return finalName;
}

/** What dedupeFileName needs of the names already taken: a Set, or a set
 *  that decides what counts as the same name (foldedNames). */
export interface NameSet {
    has(name: string): boolean;
    add(name: string): unknown;
}

/**
 * A name set that treats names differing only in letter case, or in how an
 * accented letter is encoded, as one. Windows and macOS save them as one file,
 * so a ZIP holding `A.txt` and `a.txt` unpacked only one of them there: on
 * Windows, Expand-Archive stopped at the second with "already exists" (the
 * review of the streamed ZIP, 2026-10-16). Names keep their own case; only
 * the comparison folds.
 */
function foldedNames(): NameSet {
    const taken = new Set<string>();
    const fold = (name: string) => name.normalize('NFC').toLowerCase();
    return {
        has: (name) => taken.has(fold(name)),
        add: (name) => taken.add(fold(name)),
    };
}

/**
 * Names the entries handed to the ZIP writer (lib/zipWriter.ts), in the order
 * given, one entry per item.
 *
 * Names that differ only in letter case count as one (foldedNames), so the
 * second is numbered. Sanitizing comes BEFORE de-duplicating, and that order
 * is load-bearing.
 * Reversed, `a:b.txt` and `a?b.txt` are blessed as distinct and then both
 * collapse to `a_b.txt`, so the archive holds two entries of one name and
 * extracting it keeps only one of them.
 *
 * A list, not an object keyed by name: the streaming writer takes each name as
 * a string, so no peer name ever becomes a property key. The object fflate's
 * zip() needed is why a `__proto__` entry once disappeared (see
 * sanitizeZipEntryName).
 */
export function buildZipEntries(
    items: readonly { fileName: unknown; blob: Blob }[]
): { name: string; blob: Blob }[] {
    const used = foldedNames();
    return items.map((item) => ({
        name: dedupeFileName(sanitizeZipEntryName(item.fileName), used),
        blob: item.blob,
    }));
}
