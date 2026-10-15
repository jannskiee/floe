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
 * Why a template match: most messages with a changing part are one literal
 * with a format verb or an interpolation where the row has a placeholder
 * (`Peer version: %s` is the row "Peer version: {version}"). `findTemplate`
 * finds those whole, the static parts typed exactly and each placeholder
 * standing for any one source placeholder. Without it, a message whose static
 * words are short could only be matched by the fragment rule below, and it
 * reported "Peer version: {version}" and "{size} in {duration}." gone.
 *
 * Why a threshold and not "every part": a message is often built in two files
 * (Go wraps an error as `could not resolve %q: %w` in one and words the cause
 * in another), and a row names one source. So a text that is not found whole
 * passes when two of its static parts of FRAGMENT_PAIR characters or one of
 * FRAGMENT_SINGLE are in the file. That is loose on purpose: a rule that
 * needed every part would report every wrapped error in the CLI. The cost of
 * loose is a stale row that passes, never a check that fails on a row that is
 * right, which matters since the `messages` and `captures` checks are hard.
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
    // A dollar sign typed as one in a template literal or a shell string:
    // install.sh prints `\${HOME}` so the reader sees ${HOME}.
    $: '$',
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

// What can stand for a changing part inside a source literal, one at a time:
// a Go or C format verb (%s, %d, %q, %w, %.1f, %-8s), an interpolation
// (${name} in a template literal or a shell string, ${f(x)} included), a
// shell variable ($NAME), or a placeholder spelled the way a row spells one.
const SOURCE_PLACEHOLDER = [
    '%[-+# 0]*\\d*(?:\\.\\d+)?[a-zA-Z]',
    '\\$\\{[^}]{1,80}\\}',
    '\\$[A-Za-z_][A-Za-z0-9_]*',
    '\\{[A-Za-z][A-Za-z0-9 _.-]{0,30}\\}',
].join('|');

/**
 * Where a text with placeholders starts in the haystack as one literal, or
 * -1: the static parts typed exactly and side by side, each placeholder of the
 * text standing for one source placeholder. A text with no placeholder, or
 * with no letter or digit outside them ("{cause}"), is never matched here, so
 * a row cannot pass on format verbs alone. The word rule of findText applies.
 */
export function findTemplate(hay, text) {
    const n = fold(squeeze(text));
    const parts = n.split(new RegExp(PLACEHOLDER.source, 'g'));
    if (parts.length < 2 || !/[A-Za-z0-9]/.test(parts.join(''))) return -1;
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordy = /[A-Za-z0-9]/;
    const head = wordy.test(n[0]) ? '(?<![A-Za-z0-9])' : '';
    const tail = wordy.test(n[n.length - 1]) ? '(?![A-Za-z0-9])' : '';
    const body = parts.map(escape).join(`(?:${SOURCE_PLACEHOLDER})`);
    const m = new RegExp(head + body + tail).exec(hay.folded);
    return m ? m.index : -1;
}

/** Whether a message's text is still typed in this source. */
export function textOccurs(text, hay) {
    if (findText(hay, text) >= 0 || findTemplate(hay, text) >= 0) return true;
    const found = staticFragments(text).filter((f) => findText(hay, f) >= 0);
    return (
        found.filter((f) => f.length >= FRAGMENT_PAIR).length >= 2 ||
        found.some((f) => f.length >= FRAGMENT_SINGLE)
    );
}

// ---------------------------------------------------------------------------
// The copy modules
// ---------------------------------------------------------------------------

// The three files that hold every sentence a request link shows, one per
// surface (CLAUDE.md: every sentence either side shows is fixed copy chosen
// by a code). Unlike the rest of the source, all of a copy module is meant to
// be seen, so every copy line in it must have a row in messages.json: one that
// says where it is explained, or why it is not listed.
export const COPY_FILES = [
    { surface: 'web-request', file: 'client/lib/request/visitorCopy.ts' },
    { surface: 'desktop', file: 'desktop/frontend/src/requestCopy.ts' },
    { surface: 'cli', file: 'cli/cmd/floe/sendto.go' },
];

const GO_VERB = /%[-+# 0]*\d*(?:\.\d+)?[a-zA-Z]/g;

/**
 * Every string literal of a TypeScript or Go file, in source order, as the
 * reader would see it: escapes decoded, each `${...}` of a template literal
 * and each format verb written {}, white space squeezed. Comments are
 * skipped, a template literal inside an interpolation is a literal of its
 * own, and a TypeScript regular expression is not read as a string. In Go
 * (`go` true) a backtick string is raw: no escape and no interpolation.
 */
export function stringLiterals(source, go = false) {
    const s = source.replace(/\r\n/g, '\n');
    const out = [];
    // Format verbs only in Go: "100% done" in TypeScript is not "100{}one".
    const emit = (t) => out.push(squeeze(go ? t.replace(GO_VERB, '{}') : t));
    let i = 0;
    // The last character of code read, to tell a regular expression from a
    // division: a slash after one of these starts a regular expression.
    let prev = '(';
    const quoted = (q) => {
        let t = '';
        for (i++; i < s.length && s[i] !== q && s[i] !== '\n'; i++) {
            if (s[i] === '\\') {
                const e = s[++i];
                t += e === 'n' || e === 't' ? ' ' : e === 'r' ? '' : e;
            } else t += s[i];
        }
        i++;
        return t;
    };
    // Code until the } that closes an interpolation, or to the end.
    const code = (inside) => {
        let depth = 0;
        while (i < s.length) {
            const c = s[i];
            const d = s[i + 1];
            if (c === '/' && d === '/') {
                while (i < s.length && s[i] !== '\n') i++;
            } else if (c === '/' && d === '*') {
                const end = s.indexOf('*/', i + 2);
                i = end < 0 ? s.length : end + 2;
            } else if (c === '"' || c === "'") {
                emit(quoted(c));
                prev = 'x';
            } else if (c === '`') {
                emit(template());
                prev = 'x';
            } else if (
                !go &&
                c === '/' &&
                /[(,=:[!&|?{};+\-*%<>~^]/.test(prev)
            ) {
                // A regular expression literal, classes included.
                let cls = false;
                for (i++; i < s.length && s[i] !== '\n'; i++) {
                    if (s[i] === '\\') i++;
                    else if (s[i] === '[') cls = true;
                    else if (s[i] === ']') cls = false;
                    else if (s[i] === '/' && !cls) break;
                }
                i++;
                prev = 'x';
            } else {
                if (c === '{') depth++;
                if (c === '}') {
                    if (inside && depth === 0) {
                        i++;
                        return;
                    }
                    depth--;
                }
                if (!/\s/.test(c)) prev = c;
                i++;
            }
        }
    };
    // A template literal, or in Go a raw string.
    const template = () => {
        let t = '';
        for (i++; i < s.length && s[i] !== '`'; ) {
            if (go) t += s[i++];
            else if (s[i] === '\\') {
                const e = s[i + 1];
                t += e === 'n' || e === 't' ? ' ' : e === 'r' ? '' : e;
                i += 2;
            } else if (s[i] === '$' && s[i + 1] === '{') {
                t += '{}';
                i += 2;
                code(true);
            } else t += s[i++];
        }
        i++;
        return t;
    };
    code(false);
    return out;
}

/**
 * The literals of a copy module that are copy: words a person reads, as
 * against an import path, a code (`relay-cap`), a constant's name, or a
 * format string with no word in it. Deduplicated, in source order.
 */
export function copyLines(source, file) {
    const seen = new Set();
    return stringLiterals(source, file.endsWith('.go')).filter((t) => {
        const copy =
            /[A-Za-z]{2}/.test(t.replace(/\{\}/g, '')) &&
            !/^[a-z0-9_.:/@#-]+$/.test(t) &&
            !/^\.{1,2}\/\S*$/.test(t) &&
            !/^[A-Z0-9_]+$/.test(t);
        if (!copy || seen.has(t)) return false;
        seen.add(t);
        return true;
    });
}

// A text as the copy check compares it: quotes folded, white space
// squeezed, every placeholder {} whatever its name, case ignored.
function copyKey(text) {
    return fold(squeeze(text))
        .replace(new RegExp(PLACEHOLDER.source, 'g'), '{}')
        .toLowerCase();
}

/**
 * The copy lines of `file` that no row covers. A row covers a line when its
 * source is the file and the line sits in its text on word boundaries: a row
 * may join a title and its body, so one row can cover two lines.
 */
export function uncoveredCopy(lines, rows, file) {
    const texts = rows.filter((r) => r.source === file).map((r) => copyKey(r.text));
    const wordy = /[a-z0-9]/;
    return lines.filter((line) => {
        const l = copyKey(line);
        return !texts.some((t) => {
            for (let at = t.indexOf(l); at >= 0; at = t.indexOf(l, at + 1)) {
                const before = at > 0 ? t[at - 1] : '';
                const after = t[at + l.length] ?? '';
                if (wordy.test(l[0]) && wordy.test(before)) continue;
                if (wordy.test(l[l.length - 1]) && wordy.test(after)) continue;
                return true;
            }
            return false;
        });
    });
}
