#!/usr/bin/env node
/**
 * Builds references/messages.json from an audit of every message Floe shows.
 *
 * Kept as the record of how that file was made, and for the next audit: it is
 * not part of any check and nothing runs it in CI. The audit of 2026-10-14
 * was eleven JSON files (A1 to A10, the eighth in two parts) with 1,468 rows
 * between them, each { text, surface, source, documented_at } and each
 * written by a reader, not a parser, so every field is prose around a fact:
 * a text with a note in parentheses, a source with line numbers and a remark,
 * a docs place in any of eight spellings. This script takes the fact out of
 * each and proves it against the tree, and what it cannot prove it does not
 * keep:
 *
 * - A text has to occur in one of the files its `source` names (the rule is
 *   message-match.mjs). A text that does not is written to
 *   messages-unmatched.md for a person to decide, and is NOT put in
 *   messages.json: a row nobody verified would be reported stale by the
 *   `messages` check on the day it was added.
 * - `documented_at` has to name a heading id that exists in docs/, by the same
 *   reading of ids the `links` check uses. One that does not becomes
 *   `anchor: null` and is listed in messages-anchor-unresolved.md.
 *
 * What the auditors wrote that is not the message, and how it is read: a
 * note in parentheses or square brackets at the end goes unless the source
 * types it; `<name>` and `${name}` become `{name}`; several messages in one
 * row ("Keep open / Close") become one row each; and an example value in a
 * part the source does not type as written (`429`, `v1.11.0`, a lone `N`)
 * becomes a placeholder. Placeholder names are the auditor's where there was
 * one, since Go's formatting verbs carry no name to take. Two rows that
 * differ only in what a placeholder is called are one message, and the first
 * spelling is kept.
 *
 * A second run keeps what a person added to the file since: a row added by
 * hand, a row's `why_no_home`, and an anchor set by hand on a row this run
 * could not place.
 *
 * Usage:
 *   node messages-seed.mjs <audit dir> [--root <repo>] [--triage <dir>]
 * Writes <repo>/.claude/skills/docs-verify/references/messages.json and, in
 * the triage directory (default: `triage` beside the audit directory),
 * messages-unmatched.md and messages-anchor-unresolved.md.
 */
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPages, slug } from './docs-check.mjs';
import {
    PLACEHOLDER,
    findText,
    haystack,
    sliceAt,
    staticFragments,
    textOccurs,
} from './message-match.mjs';
import { MESSAGES_FILE, SURFACES } from './messages-index.mjs';

// Where a surface's own strings live. A row that names several files is tried
// against these first, so a browser row lands on client/ and not on the
// engine file the auditor mentioned beside it.
const HOME = {
    web: 'client/',
    'web-request': 'client/',
    site: 'client/',
    desktop: 'desktop/',
    cli: 'cli/',
    server: 'server/',
};
// A page named with no heading is kept as a page-level anchor. Set to false
// to hold every anchor to a fragment; those rows then go to the unresolved
// list with `anchor: null`.
const PAGE_ANCHORS = true;
// The changelog records what a release changed. It is not where a message is
// explained, so it is never an anchor.
const NOT_A_HOME = new Set(['changelog']);
// A list item shorter than this many letters is a slash inside one message
// ("{size} / 2 GB"), not a second message.
const LIST_ITEM_LETTERS = 4;
// The fewest letters a row's text may have outside its placeholders.
const ROW_LETTERS = 2;
// How much of a note in brackets the source has to type, straight after the
// bracket, for the note to be part of the message and not the auditor's.
const NOTE_OPENING = 6;

const squeeze = (s) => s.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// source: which files
// ---------------------------------------------------------------------------

// An environment file may hold live credentials (server/.env does), so no
// spelling of one is ever opened, whatever an audit row names.
function isSecret(path) {
    const name = basename(path);
    return /^\.env(\.|$)/.test(name) && !name.endsWith('.example');
}

/**
 * The repo-relative files an audit `source` names, in the order written.
 * `isFile(path)` says whether a candidate is a file in the tree.
 */
export function sourcePaths(field, isFile) {
    const out = [];
    for (const token of field.split(/[\s;,()]+/)) {
        const path = token.replace(/:[\d:,-]*$/, '').replace(/[.:]+$/, '');
        if (!path || path.startsWith('/') || /\\|\.\.|:/.test(path)) continue;
        if (isSecret(path) || out.includes(path) || !isFile(path)) continue;
        out.push(path);
    }
    return out;
}

// ---------------------------------------------------------------------------
// documented_at: which anchor
// ---------------------------------------------------------------------------

// A docs place as the auditors wrote one: /page#id, docs/page.mdx#id,
// page.mdx#id, or a bare #id that belongs to the page named before it.
const PLACE =
    /(\/|docs\/)?([a-z0-9-]+(?:\/[a-z0-9-]+)*)(\.mdx)?(#[A-Za-z0-9_-]+)?|(#[A-Za-z0-9_-]+)/g;

/**
 * { anchor, kind } for an audit `documented_at`. kind is `anchor` (a heading
 * id that exists), `page` (a page named with no heading), `nowhere` (the
 * auditor's own answer) or `unresolved` (it names something that is not
 * there).
 */
export function resolveAnchor(documentedAt, pages) {
    const text = documentedAt.trim();
    if (text === '' || /^nowhere\b/i.test(text))
        return { anchor: null, kind: 'nowhere' };
    let last = null;
    let pageOnly = null;
    for (const m of text.matchAll(PLACE)) {
        let id = null;
        if (m[5]) {
            if (last === null) continue;
            id = m[5].slice(1);
        } else {
            // A word with no slash before it and no .mdx after it is prose.
            if (!m[1] && !m[3]) continue;
            last = pages.has(m[2]) && !NOT_A_HOME.has(m[2]) ? m[2] : null;
            if (last === null) continue;
            if (m[4]) id = m[4].slice(1);
            else {
                // "/web-app/sending (Watch the connection)": the heading by name.
                const named = text
                    .slice(m.index + m[0].length)
                    .match(/^\s*\(([^)]+)\)/);
                const want = named ? slug(named[1]) : null;
                if (want && pages.get(last).headings.ids.has(want)) id = want;
                else pageOnly ??= last;
            }
        }
        if (id !== null && pages.get(last).headings.ids.has(id))
            return { anchor: `/${last}#${id}`, kind: 'anchor' };
    }
    if (pageOnly !== null && PAGE_ANCHORS)
        return { anchor: `/${pageOnly}`, kind: 'page' };
    return { anchor: null, kind: 'unresolved' };
}

// ---------------------------------------------------------------------------
// text: is it in the source, and as what
// ---------------------------------------------------------------------------

// "(tooltip)" or "[Try again]" closing an audit text, with a space before it,
// so the "(s)" of "file(s)" is not one.
function trailingNote(text) {
    const close = text[text.length - 1];
    const open = { ')': '(', ']': '[' }[close];
    if (!open) return null;
    let depth = 0;
    for (let i = text.length - 1; i > 0; i--) {
        if (text[i] === close) depth++;
        else if (text[i] === open && --depth === 0)
            return text[i - 1] === ' '
                ? {
                      head: text.slice(0, i).trimEnd(),
                      open,
                      note: text.slice(i + 1, -1),
                  }
                : null;
    }
    return null;
}

function withoutNotes(text, keep) {
    let out = text;
    for (
        let n = trailingNote(out);
        n && n.head && !keep(n);
        n = trailingNote(out)
    )
        out = n.head;
    return out;
}

// "Windows notification: ", "Log: ", "Error: " or "install.sh: " in front of
// a message: a capitalized phrase, or a file name.
const LABEL = /^([A-Z][A-Za-z0-9 .-]{0,28}|[\w-]+\.[a-z0-9]{1,4}): (?=\S)/;
// The two the CLI prints itself in front of a line. On any other surface they
// are the auditor's.
const CLI_LABELS = new Set(['Error', 'Warning']);

// The auditors' own ways of marking a variable part, as {name}.
function placeholders(text) {
    return squeeze(
        text
            .replace(/\s*\(new line\)\s*/g, ' ')
            .replace(/^\s*(?:\.\.\.|\u2026):?\s*/, '')
            // An ellipsis that stands alone is the auditor leaving words out;
            // one that ends a word ("Waiting for peer...") is the app's.
            .replace(/(?<=^|\s)(?:\.\.\.|\u2026)(?=\s|$)/g, '{rest}')
            // <name>, and <text from the library, may quote the other side>,
            // which is named by its words before the comma.
            .replace(/<([A-Za-z][^<>]{0,80})>/g, (m, said) => {
                const name = said
                    .split(',')[0]
                    .replace(/[^A-Za-z0-9 _.-]/g, '')
                    .trim()
                    .slice(0, 30);
                return name ? `{${name}}` : m;
            })
            .replace(
                /\$\{([^}]*)\}/g,
                (m, e) => `{${e.match(/[A-Za-z_]\w*/g)?.pop() ?? 'value'}}`
            )
            .replace(/%[+#-]?\d*(?:\.\d+)?[sdqvwf]/g, '{value}')
    );
}

const VERSION = /(?<![A-Za-z0-9.{])v?\d+\.\d+\.\d+(?![A-Za-z0-9}])/g;
const NUMBER = /(?<![A-Za-z0-9.{-])\d+(?:[.,:]\d+)*(?![A-Za-z0-9}])/g;
const LETTER = /(?<![A-Za-z0-9{'])[NMXYK](?![A-Za-z0-9}'])/g;

// An example value stands for a variable only in a part the source does not
// type as written: "2 GB limit per session" is in the file and keeps its 2,
// "server returned 429" is not and becomes "server returned {n}".
function examples(text, hay) {
    let out = text;
    for (const part of staticFragments(text)) {
        if (findText(hay, part) >= 0) continue;
        const built = part
            .replace(VERSION, '{version}')
            .replace(NUMBER, '{n}')
            .replace(LETTER, (c) => `{${c.toLowerCase()}}`);
        if (built !== part) out = out.split(part).join(built);
    }
    return out;
}

// A note is the message's own when the source types its opening words
// straight after the bracket: "(selected %s)" is, "(or: ...)" is not. Without
// this, "capped at 2 GB (selected <size>)" would lose its note and then be
// found whole, as the first half of the line it is.
function withoutAuditorNotes(text, hay) {
    return withoutNotes(text, ({ open, note }) => {
        const first = staticFragments(placeholders(note))[0] ?? '';
        return first.length >= NOTE_OPENING && findText(hay, open + first) >= 0;
    });
}

// The text as a template: the notes the source does not type and a label
// that is the auditor's are taken off, and what varies is in braces.
function template(text, hay, surface) {
    let out = withoutAuditorNotes(text, hay);
    // A label is the message's own on the same terms, the words after it
    // included: install.sh has "install.sh:" in a comment and prints none.
    const label = out.match(LABEL);
    if (label && !(surface === 'cli' && CLI_LABELS.has(label[1]))) {
        const rest = staticFragments(placeholders(out.replace(LABEL, '')))[0];
        const typed =
            findText(
                hay,
                rest === undefined ? `${label[1]}:` : `${label[1]}: ${rest}`
            ) >= 0;
        if (!typed) out = out.replace(LABEL, '');
    }
    return examples(placeholders(out), hay);
}

// A row has to say something: "--" (the ping before it is known) and a bare
// {n} are in the source and are no message a person would look up.
function hasWords(text) {
    const plain = text.replace(new RegExp(PLACEHOLDER.source, 'g'), '');
    return (plain.match(/[A-Za-z]/g) || []).length >= ROW_LETTERS;
}

function matchOne(text, sources) {
    const whole = squeeze(text);
    // { "error": "Too many requests" } is typed as the words alone.
    const body = whole.match(/"error"\s*:\s*"([^"]+)"/);
    for (const { path, hay } of sources) {
        const bare = withoutAuditorNotes(whole, hay);
        const typed = [
            whole,
            bare,
            whole.replace(LABEL, ''),
            bare.replace(LABEL, ''),
            body?.[1],
        ];
        for (const candidate of new Set(
            typed.filter((c) => c && hasWords(c))
        )) {
            const at = findText(hay, candidate);
            if (at >= 0)
                return {
                    text: sliceAt(hay, at, candidate),
                    source: path,
                    how: 'verbatim',
                };
        }
    }
    return null;
}

function matchBuilt(text, sources, surface) {
    for (const { path, hay } of sources) {
        const built = template(squeeze(text), hay, surface);
        // "{the sender's own reason}, for example ..." describes a message
        // and quotes a few; a person has to pick the rows out of it.
        if (!hasWords(built) || /\bfor example\b/i.test(built)) continue;
        if (textOccurs(built, hay))
            return { text: built, source: path, how: 'fragments' };
    }
    return null;
}

// "A / B", and the "   or" and "   then" some auditors set off with a wide
// gap. Read from the raw text: the gap is what marks them.
function listItems(text) {
    const items = text
        .trim()
        .split(/\s+\/\s+|\s{2,}(?:or|and|then)\s+/)
        .map(squeeze)
        .filter(Boolean);
    const enough = (item) =>
        (item.match(/[A-Za-z]/g) || []).length >= LIST_ITEM_LETTERS;
    return items.length > 1 && items.every(enough) ? items : [squeeze(text)];
}

/**
 * Looks one audit text up in its sources ([{ path, hay }], best first).
 * `matched` is one entry per message found, as { text, source, how };
 * `missed` is what was not found, as the auditor wrote it.
 */
export function matchText(text, sources, surface) {
    const whole = matchOne(text, sources);
    if (whole) return { matched: [whole], missed: [] };
    const matched = [];
    const missed = [];
    for (const item of listItems(text)) {
        const found =
            matchOne(item, sources) ?? matchBuilt(item, sources, surface);
        if (!found) missed.push(item);
        else if (!matched.some((m) => m.text === found.text))
            matched.push(found);
    }
    return matched.length
        ? { matched, missed }
        : { matched, missed: [squeeze(text)] };
}

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

function byRow(a, b) {
    const s = SURFACES.indexOf(a.surface) - SURFACES.indexOf(b.surface);
    if (s !== 0) return s;
    const [ka, kb] = [a.text.toLowerCase(), b.text.toLowerCase()];
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
}

/**
 * audit: [{ file, surface, text, source, documented_at }] in reading order.
 * env: { isFile(path), readSource(path), pages }.
 * Returns the rows for messages.json and three lists for a person: texts not
 * found (`unmatched`), docs places that name nothing (`unresolved`), and
 * rows that ended on a page with no heading (`pageLevel`).
 */
export function seedRows(audit, { isFile, readSource, pages }) {
    const hays = new Map();
    const hayOf = (path) => {
        if (!hays.has(path)) hays.set(path, haystack(readSource(path)));
        return hays.get(path);
    };
    const kept = new Map();
    const unmatched = [];
    for (const a of audit) {
        const said = { file: a.file, surface: a.surface, source: a.source };
        if (!SURFACES.includes(a.surface)) {
            unmatched.push({
                ...said,
                text: squeeze(a.text),
                why: `unknown surface "${a.surface}"`,
            });
            continue;
        }
        const paths = sourcePaths(a.source, isFile);
        if (!paths.length) {
            unmatched.push({
                ...said,
                text: squeeze(a.text),
                why: 'the source names no file in this tree',
            });
            continue;
        }
        const own = (p) => Number(p.startsWith(HOME[a.surface]));
        paths.sort((x, y) => own(y) - own(x));
        const { matched, missed } = matchText(
            a.text,
            paths.map((path) => ({ path, hay: hayOf(path) })),
            a.surface
        );
        for (const text of missed)
            unmatched.push({
                ...said,
                text,
                why: !hasWords(placeholders(text))
                    ? 'too little text outside its placeholders to be a row'
                    : `${matched.length ? 'one item of a list, ' : ''}not found in ${paths.join(', ')}`,
            });
        const home = resolveAnchor(a.documented_at, pages);
        for (const m of matched) {
            // One message, whatever two auditors called its variable parts:
            // "after {n} of {m} files" and "after {a} of {b} files" are a
            // duplicate, and the first spelling is kept.
            const shape = m.text.replace(
                new RegExp(PLACEHOLDER.source, 'g'),
                '{}'
            );
            const key = `${a.surface}\u0000${shape}`;
            if (!kept.has(key))
                kept.set(key, {
                    row: {
                        surface: a.surface,
                        text: m.text,
                        source: m.source,
                        anchor: null,
                        why_no_home: null,
                    },
                    said: [],
                });
            const entry = kept.get(key);
            // Of several auditors' rows for one message, the first that names
            // a heading wins, and a page is taken only when none does.
            const better =
                home.anchor !== null &&
                (entry.row.anchor === null ||
                    (home.kind === 'anchor' &&
                        !entry.row.anchor.includes('#')));
            if (better) entry.row.anchor = home.anchor;
            entry.said.push({
                file: a.file,
                documented_at: a.documented_at,
                kind: home.kind,
            });
        }
    }
    const entries = [...kept.values()].sort((a, b) => byRow(a.row, b.row));
    const unresolved = [];
    const pageLevel = [];
    for (const { row, said } of entries) {
        const from = (kind) => said.filter((s) => s.kind === kind);
        if (row.anchor === null)
            for (const s of from('unresolved'))
                unresolved.push({
                    file: s.file,
                    surface: row.surface,
                    text: row.text,
                    documented_at: s.documented_at,
                });
        else if (!row.anchor.includes('#'))
            for (const s of from('page'))
                pageLevel.push({
                    file: s.file,
                    surface: row.surface,
                    text: row.text,
                    anchor: row.anchor,
                    documented_at: s.documented_at,
                });
    }
    return {
        rows: entries.map((e) => e.row),
        unmatched,
        unresolved,
        pageLevel,
    };
}

// What a person added to an earlier messages.json survives a new seed: a row
// this run did not produce (the unmatched list is cleared by adding rows by
// hand), a reason for having no docs home, and an anchor on a row the audit
// placed nowhere. An anchor the audit does resolve wins over an earlier one.
export function carryOver(rows, earlier) {
    const key = (r) => `${r.surface}\u0000${r.text}`;
    const before = new Map(earlier.map((r) => [key(r), r]));
    const seeded = new Set(rows.map(key));
    const kept = rows.map((row) => {
        const was = before.get(key(row));
        if (!was) return row;
        const anchor = row.anchor ?? was.anchor ?? null;
        return {
            ...row,
            anchor,
            why_no_home: anchor === null ? (was.why_no_home ?? null) : null,
        };
    });
    return [...kept, ...earlier.filter((r) => !seeded.has(key(r)))].sort(byRow);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

// A1, A2, ... A8a, A8b, A9, A10: by number, then by letter.
function auditFiles(dir) {
    const order = (name) => {
        const m = name.match(/^A(\d+)([a-z]?)\.json$/);
        return [Number(m[1]), m[2]];
    };
    return readdirSync(dir)
        .filter((name) => /^A\d+[a-z]?\.json$/.test(name))
        .sort((a, b) => {
            const [na, la] = order(a);
            const [nb, lb] = order(b);
            return na - nb || (la < lb ? -1 : la > lb ? 1 : 0);
        });
}

const quote = (s) => `\`\` ${s.replace(/\s+/g, ' ')} \`\``;

function unmatchedReport(unmatched, total) {
    const lines = [
        '# Messages the seed could not find in their source',
        '',
        `Written by .claude/skills/docs-verify/scripts/messages-seed.mjs. ${unmatched.length} entries from ${total} audit rows.`,
        'None of these is in messages.json. For each one, decide: the text is paraphrased (take the',
        'wording from the source and add the row by hand), it is built from parts too short to match',
        '(add the row with {placeholders}, keeping two parts of 8 characters or one of 20 that the',
        'source types), or it is not a message (leave it out).',
        '',
    ];
    let file = null;
    for (const u of unmatched) {
        if (u.file !== file) lines.push(`## ${(file = u.file)}`, '');
        lines.push(
            `- [${u.surface}] ${quote(u.text)}`,
            `  - source: ${u.source.replace(/\s+/g, ' ')}`,
            `  - why: ${u.why}`
        );
    }
    return `${lines.join('\n')}\n`;
}

function unresolvedReport(unresolved, pageLevel) {
    const lines = [
        '# Docs places the seed could not resolve to a heading',
        '',
        'Written by .claude/skills/docs-verify/scripts/messages-seed.mjs.',
        '',
        `## Names something that is not there (${unresolved.length})`,
        '',
        'These rows are in messages.json with `anchor: null`. The audit named a page or a heading id',
        'that docs/ does not have, a heading whose id Mintlify builds with quotes or slashes in it',
        '(give that heading an explicit {#id}), or only the changelog.',
        '',
    ];
    for (const u of unresolved)
        lines.push(
            `- ${u.file} [${u.surface}] ${quote(u.text)}`,
            `  - documented_at: ${u.documented_at.replace(/\s+/g, ' ')}`
        );
    lines.push(
        '',
        `## Resolved to a page, with no heading (${pageLevel.length})`,
        '',
        'These rows are in messages.json with a page-level anchor. Name the heading when there is one.',
        ''
    );
    for (const p of pageLevel)
        lines.push(
            `- ${p.file} [${p.surface}] ${quote(p.text)}`,
            `  - anchor: ${p.anchor}`,
            `  - documented_at: ${p.documented_at.replace(/\s+/g, ' ')}`
        );
    return `${lines.join('\n')}\n`;
}

function main(args) {
    let root = resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        '..'
    );
    let auditDir = null;
    let triage = null;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--root') root = resolve(args[++i] || '');
        else if (args[i] === '--triage') triage = resolve(args[++i] || '');
        else if (!args[i].startsWith('--') && auditDir === null)
            auditDir = resolve(args[i]);
        else auditDir = undefined;
    }
    if (
        !auditDir ||
        !existsSync(auditDir) ||
        !existsSync(join(root, 'docs', 'docs.json'))
    ) {
        console.error(
            'usage: node messages-seed.mjs <audit dir> [--root <repo>] [--triage <dir>]'
        );
        process.exit(2);
    }
    triage ??= join(dirname(auditDir), 'triage');

    const audit = [];
    for (const file of auditFiles(auditDir)) {
        const data = JSON.parse(
            readFileSync(join(auditDir, file), 'utf8').replace(/^\ufeff/, '')
        );
        for (const m of data.messages || []) audit.push({ file, ...m });
    }
    const isFile = (path) => {
        try {
            return statSync(join(root, path)).isFile();
        } catch {
            return false;
        }
    };
    const seeded = seedRows(audit, {
        isFile,
        readSource: (path) => readFileSync(join(root, path), 'utf8'),
        pages: readPages(join(root, 'docs')),
    });
    const target = join(root, MESSAGES_FILE);
    const rows = existsSync(target)
        ? carryOver(seeded.rows, JSON.parse(readFileSync(target, 'utf8')))
        : seeded.rows;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(rows, null, 4)}\n`);
    mkdirSync(triage, { recursive: true });
    writeFileSync(
        join(triage, 'messages-unmatched.md'),
        unmatchedReport(seeded.unmatched, audit.length)
    );
    writeFileSync(
        join(triage, 'messages-anchor-unresolved.md'),
        unresolvedReport(seeded.unresolved, seeded.pageLevel)
    );

    const count = (list, key) =>
        SURFACES.map(
            (s) => `${s} ${list.filter((r) => r[key] === s).length}`
        ).join(', ');
    console.log(`messages-seed: ${audit.length} audit rows`);
    console.log(
        `  ${rows.length} rows in ${MESSAGES_FILE} (${count(rows, 'surface')})`
    );
    console.log(
        `  ${rows.filter((r) => r.anchor !== null).length} with an anchor, ${rows.filter((r) => r.anchor === null).length} without`
    );
    console.log(
        `  ${seeded.unmatched.length} texts not found, in ${join(triage, 'messages-unmatched.md')}`
    );
    console.log(
        `  ${seeded.unresolved.length} docs places unresolved and ${seeded.pageLevel.length} at page level, in ${join(triage, 'messages-anchor-unresolved.md')}`
    );
}

function realPath(p) {
    try {
        return realpathSync(p);
    } catch {
        return p;
    }
}
const invokedDirectly =
    process.argv[1] &&
    realPath(resolve(process.argv[1])).toLowerCase() ===
        realPath(fileURLToPath(import.meta.url)).toLowerCase();
if (invokedDirectly) main(process.argv.slice(2));
