/**
 * How a message text is held against the source file that prints it.
 *
 * One module because four readers have to agree on the answer: the seed that
 * builds references/messages.json, the snapshot of the released apps
 * (released-strings.mjs), and the `messages` and `captures` checks in
 * docs-check.mjs. If each had its own idea of "occurs", a row the seed accepted
 * would be reported stale by the check on the same tree.
 *
 * Why the source is rewritten before the search: a message is rarely one run
 * of characters in its file. It is typed across two string literals joined by
 * a plus, wrapped over three lines of JSX, written with \" or &apos; where the
 * reader sees a quote. `haystack` undoes exactly those, so the text a person
 * reads on screen can be looked up as typed.
 *
 * Why a threshold and not "every part": a message is often built in two files
 * (Go wraps an error as `could not resolve %q: %w` in one and words the cause
 * in another), and a row names one source. So a text that is not found whole
 * passes when two of its static parts of FRAGMENT_PAIR characters or one of
 * FRAGMENT_SINGLE are in the file. That is loose on purpose: the checks that
 * use it only print notes, and a rule that needed every part would report
 * every wrapped error in the CLI.
 */

// A variable part of a message, as messages.json writes it: {name}, {n},
// {your path}. A letter must follow the brace, so the JSON bodies the server
// answers with ({ "error": ... }, {"totalBytes":...}) are not placeholders.
export const PLACEHOLDER = /\{[A-Za-z][A-Za-z0-9 _.-]{0,30}\}/;
export const FRAGMENT_PAIR = 8;
export const FRAGMENT_SINGLE = 20;

const ENTITIES = {
    apos: "'",
    quot: '"',
    amp: '&',
    lt: '<',
    gt: '>',
    nbsp: ' ',
    middot: '\u00b7',
    hellip: '\u2026',
    rarr: '\u2192',
    larr: '\u2190',
    ldquo: '\u201c',
    rdquo: '\u201d',
    lsquo: '\u2018',
    rsquo: '\u2019',
};
const SIMPLE_ESCAPES = {
    n: ' ',
    t: ' ',
    r: '',
    '"': '"',
    "'": "'",
    '`': '`',
    '\\': '\\',
};

// Typed and straight quotes are one character each, so folding keeps every
// index: a match found in the folded text is cut from the unfolded one, and a
// row's text keeps the marks its source has.
function fold(s) {
    return s
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201c\u201d]/g, '"')
        .replace(/\u00a0/g, ' ');
}

function squeeze(s) {
    return s.replace(/\s+/g, ' ').trim();
}

/**
 * A source file as its strings read: adjacent literals joined, escapes and
 * entities decoded, every run of white space one space. Returns it as typed
 * (`text`) and with its quotes folded (`folded`), index for index.
 *
 * Comments stay in. Taking them out safely needs a tokenizer for Go, for
 * TypeScript and for JSX text (where an apostrophe is not a string), and a
 * wrong cut would lose a real message and report it gone. Left in, the worst
 * case is a message that survives only in a comment and is not reported.
 */
export function haystack(source) {
    const text = source
        .replace(/\r\n/g, '\n')
        // 'a ' + 'b', and the same across a line break, in any quote style.
        .replace(/(?<!\\)(['"`])[ \t]*\+[ \t]*\n?[ \t]*(['"`])/g, '')
        .replace(/\{(['"]) \1\}/g, ' ')
        .replace(
            /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g,
            (m, e) => {
                if (e in SIMPLE_ESCAPES) return SIMPLE_ESCAPES[e];
                if (e.length === 1) return m;
                const hex = e.replace(/^[ux]\{?|\}$/g, '');
                return String.fromCodePoint(parseInt(hex, 16));
            }
        )
        .replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e) => {
            if (e[0] !== '#') return ENTITIES[e] ?? m;
            const code =
                e[1] === 'x'
                    ? parseInt(e.slice(2), 16)
                    : parseInt(e.slice(1), 10);
            return String.fromCodePoint(code);
        })
        .replace(/\s+/g, ' ');
    return { text, folded: fold(text) };
}

/**
 * Where `needle` starts in the haystack, or -1. A needle that begins or ends
 * on a letter or digit must begin or end a word there, so "Send" is not found
 * inside "onSend" or "Sending".
 */
export function findText(hay, needle) {
    const n = fold(squeeze(needle));
    if (!n) return -1;
    const h = hay.folded;
    const wordy = /[A-Za-z0-9]/;
    const first = wordy.test(n[0]);
    const last = wordy.test(n[n.length - 1]);
    for (let i = h.indexOf(n); i >= 0; i = h.indexOf(n, i + 1)) {
        if (first && i > 0 && wordy.test(h[i - 1])) continue;
        if (last && i + n.length < h.length && wordy.test(h[i + n.length]))
            continue;
        return i;
    }
    return -1;
}

/** The text at a match, as the source spells it. */
export function sliceAt(hay, at, needle) {
    return hay.text.slice(at, at + fold(squeeze(needle)).length);
}

/**
 * The parts of a message that are typed in a source file: what is left when
 * the placeholders are taken out, cut again where one error wraps another
 * (": ") and where one sentence ends and the next begins, because those are
 * the joints at which a message is put together from separate literals. Quotes
 * at the edges go, since a formatting verb often supplies them at run time.
 */
export function staticFragments(text) {
    return squeeze(text)
        .split(new RegExp(PLACEHOLDER.source, 'g'))
        .flatMap((part) => part.split(/: |(?<=[.!?]) (?=[A-Z])/))
        .map((part) =>
            part.replace(
                /^[\s"'`\u201c\u201d\u2018\u2019]+|[\s"'`\u201c\u201d\u2018\u2019]+$/g,
                ''
            )
        )
        .filter((part) => /[A-Za-z0-9]/.test(part));
}

/** Whether a message's text is still typed in this source. */
export function textOccurs(text, hay) {
    if (findText(hay, text) >= 0) return true;
    const found = staticFragments(text).filter((f) => findText(hay, f) >= 0);
    return (
        found.filter((f) => f.length >= FRAGMENT_PAIR).length >= 2 ||
        found.some((f) => f.length >= FRAGMENT_SINGLE)
    );
}
