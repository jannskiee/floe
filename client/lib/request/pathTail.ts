// Where a path row splits so its end always shows (the 2026-10-08 /r QA, D4).
//
// displayPath (C-91) shortens a path in the middle so both ends stay readable,
// at 56 characters, which is what fits the card at its full width. On a phone
// the row is far narrower than that, and the row's CSS truncation then cut the
// END: the file name and its extension. A folder of camera files read as eight
// identical rows at 390 px ("Wedding photos June 2026 fu...and r"). A row now
// draws a head that CSS may shorten with an ellipsis and a tail it never
// shortens unless the tail alone is wider than the row, so CSS eats the middle.
//
// Rows ask displayPath for PATH_TEXT_MAX rather than its default. The card's
// row holds about 58 characters of ordinary text, the tail included, so
// displayPath's own "..." (at character 59 of a shortened path) stays past the
// visible head; a name made mostly of narrow letters (l, i) can show both. The
// cap still keeps a deep path from putting kilobytes of text in every row.

/** The text a path row asks displayPath for. */
export const PATH_TEXT_MAX = 120;

/** The characters a path row always shows at its end: a camera name and its
 *  extension ("DSC_4000.NEF"), or a version and its extension ("FINAL_v12.docx"). */
export const PATH_TAIL = 14;

let segmenter: Intl.Segmenter | null | undefined;

/** One grapheme segmenter for the page, or null where there is none (no
 *  browser /r supports). Made once: a new one per row cost 143 to 187 ms per
 *  10,000 rows, every time the ARRIVED list re-rendered. */
function graphemes(): Intl.Segmenter | null {
    if (segmenter === undefined) {
        segmenter =
            typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
                ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
                : null;
    }
    return segmenter;
}

/** Split `text` into a head and its last `tail` user-perceived characters.
 *  Counted in grapheme clusters, so an emoji sequence or a letter and its
 *  accent are never drawn half in each span (a split ZWJ sequence renders as
 *  its separate parts). Walks back from the end, so a long head costs nothing.
 *  The head is '' when the whole text fits the tail. */
export function splitTail(text: string, tail = PATH_TAIL): [string, string] {
    const seg = graphemes();
    if (seg) {
        const segments = seg.segment(text);
        let cut = text.length;
        for (let k = 0; k < tail && cut > 0; k++) cut = segments.containing(cut - 1)?.index ?? 0;
        return cut === 0 ? ['', text] : [text.slice(0, cut), text.slice(cut)];
    }
    // Code points: never splits a surrogate pair.
    const parts = Array.from(text);
    if (parts.length <= tail) return ['', text];
    const cut = parts.length - tail;
    return [parts.slice(0, cut).join(''), parts.slice(cut).join('')];
}

// Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic and the Arabic
// extensions and presentation forms: the scripts a name can be written in
// right to left.
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
// A letter of a left-to-right script (Latin, Greek, Cyrillic, Armenian,
// Indic, Thai, CJK, Hangul and the rest), the other kind of strong character.
const LTR = /[A-Za-z\u00C0-\u02AF\u0370-\u058F\u0900-\u1FFF\u2C00-\uD7FF\uF900-\uFB1C]/;

/** Whether `text` reads right to left: its first strong character is in a
 *  right-to-left script, the rule dir="auto" applies. Digits, spaces and
 *  punctuation are not strong, so "2026 \u062A\u0642\u0631\u064A\u0631.pdf" is right to left. */
export function isRtl(text: string): boolean {
    for (const ch of text) {
        if (RTL.test(ch)) return true;
        if (LTR.test(ch)) return false;
    }
    return false;
}
