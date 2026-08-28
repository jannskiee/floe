#!/usr/bin/env node
/**
 * Renders a desktop-v* entry of docs/changelog.mdx into the plain text the
 * Microsoft Store's "What's new in this version" field takes, and measures
 * it against the field's limits before anyone pastes it.
 *
 * Why it exists: the Store field is 1,500 characters of plain text. The
 * changelog is MDX with bold, backticks and links, so a raw paste leaves
 * `**` and backticks in the listing. The text opens with a title line,
 * "Floe Desktop X.Y.Z", the convention Submission 10 shipped by hand (its
 * 1,306 characters began "Floe Desktop 0.2.8"). With it the desktop-v0.2.8
 * entry renders to 1,429 characters (measured 2026-08-28), a margin of 71,
 * so the length check is not theoretical: the next entry of that shape overflows, and the
 * field silently truncates rather than refusing. The per-line list printed
 * on an overflow shows what to trim.
 *
 * Why the checks are what they are: the changelog contract (the MDX comment
 * at the top of the file) makes `label` the tag verbatim, so the entry is
 * found by label and never by position, and an `Unreleased` label at tag
 * time is the step that has not happened yet (floe-release step 6). The
 * first tag is the primary surface, so an entry whose first tag is not
 * Desktop is a note, and rule 6's "Web app:" and "Self-hosting:" prefixes
 * mark bullets a Store reader has no use for. Store policy refuses "What's
 * new" text that points at other download sources, so github.com, the
 * floe.one download page, winget, Homebrew and Scoop are noted with the
 * line they sit on. The no-dash rule is enforced by Vale in docs/ only; the
 * Store text lives outside docs/, so it is re-checked here. A `<` or `>`
 * left in the text is residue only when it forms a tag: `&lt;` decodes to a
 * bare `<`, and the shipped desktop-v0.2.6 entry holds `< > : " | ? *` in
 * a code span. For a rendered entry, nothing under the title line is a hard
 * stop; a hand-written --check file is judged whole, so one line is a valid
 * paste. A first body line that is not bold is noted against contract rule 4.
 *
 * --out writes the file even when a HARD finding is reported, so a hand
 * condensation starts from the over-limit plain text, never from the MDX.
 *
 * Green does NOT prove the text reads well for a Store reader (a desktop
 * entry may still say `floe` where the reader has no CLI), that Partner
 * Center accepted it, or that the entry describes what the tag shipped.
 *
 * Usage:
 *   node .claude/skills/store-submit/scripts/release-notes.mjs
 *       --desktop desktop-vX.Y.Z [--out <file>] [--root <dir>] [--json]
 *   node .claude/skills/store-submit/scripts/release-notes.mjs
 *       --check <file> [--json]
 * Tests:
 *   node --test .claude/skills/store-submit/scripts/release-notes.test.mjs
 * Exit: 0 no HARD finding, 1 any HARD finding, 2 usage.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/ -> store-submit/ -> skills/ -> .claude/ -> repo root.
const DEFAULT_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..'
);
const CHANGELOG = 'docs/changelog.mdx';
export const STORE_MAX = 1500;
// Phrases that point a Store reader at another download source.
export const EXTERNAL =
    /github\.com|floe\.one\/download|releases\/download|apps\.microsoft\.com|\bwinget\b|homebrew|\bscoop\b|github release/i;
const DESKTOP_TAG = /^desktop-v\d+\.\d+\.\d+$/;
const DASH = /[\u2013\u2014]/;
// What survives rendering when a construct was not reduced. Angle brackets
// count only as a tag (`<kbd>`, `</Update>`): a bare `<` is legitimate text
// once `&lt;` is decoded or a code span holding `< > : " | ? *` is restored.
const RESIDUE = /\*\*|\]\(|`|<\/?[A-Za-z][^>]*>/;
const SURFACE = /^- (Web app|Self-hosting): /;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"' };

// djb2 over code points, 8 lowercase hex digits: the same text pasted from
// the Store form can be fingerprinted in a browser snippet with this loop.
export function djb2(text) {
    let h = 5381;
    for (const ch of text) h = (Math.imul(h, 33) + ch.codePointAt(0)) >>> 0;
    return h.toString(16).padStart(8, '0');
}

// The entry for a label: from the line starting `<Update label="<label>"` to
// the next line that is exactly `</Update>`. Null when the label is absent.
export function findEntry(text, label) {
    const lines = String(text).split(/\r?\n/);
    const start = lines.findIndex((l) =>
        l.trim().startsWith(`<Update label="${label}"`)
    );
    if (start < 0) return null;
    let end = -1;
    for (let i = start + 1; i < lines.length; i++) {
        if (lines[i].trim() === '</Update>') {
            end = i;
            break;
        }
    }
    if (end < 0) return null;
    const head = lines[start];
    const tags = (head.match(/tags=\{\[([^\]]*)\]\}/)?.[1] ?? '')
        .split(',')
        .map((s) => s.trim().replace(/^"|"$/g, ''))
        .filter(Boolean);
    return {
        label,
        line: start + 1,
        head,
        tags,
        description: head.match(/description="([^"]*)"/)?.[1] ?? null,
        body: lines.slice(start + 1, end),
    };
}

// Reduces one line of markdown to text. Code spans are lifted out first so
// their contents are never mistaken for emphasis or a link, and restored
// into the link text too, so a NOTE never shows the placeholder.
function inline(line, urls) {
    const codes = [];
    const restore = (s) =>
        s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
    let s = line.replace(/`([^`]*)`/g, (_, code) => {
        codes.push(code);
        return `\u0000${codes.length - 1}\u0000`;
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
        urls.push({ text: restore(text), url });
        return text;
    });
    s = s.replace(/\*\*(.+?)\*\*/g, '$1');
    s = s.replace(/(^|[^*\w])\*(?!\s)([^*]+?)(?<!\s)\*(?![*\w])/g, '$1$2');
    s = s.replace(/&(amp|lt|gt|quot);/g, (_, e) => ENTITIES[e]);
    return restore(s);
}

// Plain text from an entry body: an optional title line first, then the
// common indent stripped, the headline followed by one blank line, bullets as `- `, inline markdown
// reduced, entities decoded, LF, trimmed. A body line starting with `<` is
// MDX this renderer does not understand and is returned, never dropped.
// `headline` is the source line the headline came from (null for an empty
// body), so check() can see whether it was bold.
export function render(body, title = null) {
    const urls = [];
    const mdx = [];
    const lead = (l) => /^ */.exec(l)[0].length;
    const nonEmpty = body.filter((l) => l.trim() !== '');
    const indent = nonEmpty.length ? Math.min(...nonEmpty.map(lead)) : 0;
    const out = title ? [title, ''] : [];
    let headline = null;
    for (const raw of body) {
        const line = raw.slice(Math.min(indent, lead(raw))).replace(/\s+$/, '');
        if (line.trim() === '') {
            out.push('');
        } else if (line.trimStart().startsWith('<')) {
            mdx.push(line.trim());
        } else if (headline === null) {
            headline = line.trim();
            out.push(inline(headline, urls), '');
        } else {
            out.push(inline(line.replace(/^\s*- /, '- '), urls));
        }
    }
    const text = out
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return { text, urls, mdx, headline };
}

// HARD findings block the paste; NOTE findings are for the reader.
export function check(text, context = {}) {
    const {
        tag = null,
        tags = null,
        urls = [],
        mdx = [],
        headline = null,
        entryMissing = false,
        unreleased = false,
        titled = false,
    } = context;
    const hard = [];
    const notes = [];
    if (entryMissing) {
        hard.push({
            check: 'entry',
            message: `no <Update label="${tag}"> in ${CHANGELOG}${unreleased ? '; an Unreleased entry exists, relabel it first (floe-release step 6)' : ''}`,
        });
    }
    for (const line of mdx) {
        hard.push({
            check: 'mdx',
            message: `unsupported MDX inside the entry: ${line}`,
        });
    }
    const lines = text.split('\n');
    // Nothing at all is not a paste, and neither is a title the script
    // added itself ("Floe Desktop X.Y.Z") with nothing under it. A hand-written
    // file (--check) is judged whole: one line is a valid What's new. A
    // missing entry is already HARD entry.
    const pasted = titled ? lines.slice(1) : lines;
    if (!entryMissing && pasted.join('\n').trim() === '') {
        hard.push({ check: 'empty', message: 'nothing to paste' });
    }
    if (text.length > STORE_MAX) {
        const detail = lines
            .map(
                (l, i) =>
                    `      ${String(l.length).padStart(5)}  ${i + 1}: ${l.length > 60 ? `${l.slice(0, 57)}...` : l}`
            )
            .join('\n');
        hard.push({
            check: 'length',
            message: `${text.length} chars, ${STORE_MAX} allowed; trim ${text.length - STORE_MAX}\n${detail}`,
        });
    }
    lines.forEach((l, i) => {
        if (DASH.test(l))
            hard.push({
                check: 'dashes',
                message: `line ${i + 1} has an em or en dash: ${l}`,
            });
        const residue = RESIDUE.exec(l);
        if (residue)
            hard.push({
                check: 'residue',
                message: `line ${i + 1} keeps "${residue[0]}": ${l}`,
            });
        for (const m of l.matchAll(new RegExp(EXTERNAL.source, 'gi'))) {
            notes.push({
                check: 'external',
                message: `"${m[0]}" on line ${i + 1}: ${l}`,
            });
        }
        const surface = SURFACE.exec(l);
        if (surface)
            notes.push({
                check: 'surface',
                message: `line ${i + 1} is about ${surface[1]}, which a Store reader does not have: ${l}`,
            });
    });
    for (const u of urls) {
        notes.push({
            check: 'link',
            message: `dropped ${u.url} (kept "${u.text}")`,
        });
        // The url is gone from the text, so the phrase it carried is only
        // visible here.
        for (const m of u.url.matchAll(new RegExp(EXTERNAL.source, 'gi'))) {
            notes.push({
                check: 'external',
                message: `"${m[0]}" in the dropped link ${u.url} (kept "${u.text}")`,
            });
        }
    }
    // A leading bullet is promoted to the headline slot silently, so the
    // source line is checked, not the rendered one.
    if (headline !== null && !headline.startsWith('**')) {
        notes.push({
            check: 'headline',
            message:
                'first line is not a bold headline (changelog contract rule 4)',
        });
    }
    if (tags && tags[0] !== 'Desktop') {
        notes.push({
            check: 'tags',
            message: `first tag is "${tags[0] ?? ''}", expected "Desktop"; the entry's primary surface is not the desktop app`,
        });
    }
    return { hard, notes };
}

function usage(message) {
    console.error(`release-notes: ${message}`);
    return 2;
}

export function parseArgs(argv, { root = DEFAULT_ROOT } = {}) {
    const opts = { desktop: null, check: null, out: null, root, json: false };
    const value = (flag, v) => {
        if (v === undefined || v.startsWith('--'))
            throw new Error(`${flag} needs a value`);
        return v;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--desktop') opts.desktop = value(a, argv[++i]);
        else if (a === '--check') opts.check = value(a, argv[++i]);
        else if (a === '--out') opts.out = value(a, argv[++i]);
        else if (a === '--root') opts.root = value(a, argv[++i]);
        else if (a === '--json') opts.json = true;
        else throw new Error(`unknown argument ${a}`);
    }
    if (opts.desktop && opts.check)
        throw new Error('--desktop and --check are exclusive');
    if (!opts.desktop && !opts.check)
        throw new Error(
            'pass --desktop desktop-vX.Y.Z (render the changelog entry) or --check <file> (validate a text file)'
        );
    if (opts.desktop && !DESKTOP_TAG.test(opts.desktop))
        throw new Error(`--desktop wants desktop-vX.Y.Z, got ${opts.desktop}`);
    // Stat-checked here so a directory is a usage error rather than an
    // EISDIR from readFileSync, and a missing parent an error rather than an
    // ENOENT from writeFileSync after the text was rendered.
    if (opts.check) {
        if (opts.out) throw new Error('--out only applies with --desktop');
        opts.check = path.resolve(opts.check);
        const st = statSync(opts.check, { throwIfNoEntry: false });
        if (!st) throw new Error(`--check ${opts.check} does not exist`);
        if (st.isDirectory())
            throw new Error(`--check ${opts.check} is a directory, not a file`);
        if (!st.isFile())
            throw new Error(`--check ${opts.check} is not a regular file`);
    } else {
        opts.root = path.resolve(opts.root);
        if (!existsSync(path.join(opts.root, CHANGELOG)))
            throw new Error(`--root ${opts.root} has no ${CHANGELOG}`);
    }
    if (opts.out) {
        opts.out = path.resolve(opts.out);
        if (statSync(opts.out, { throwIfNoEntry: false })?.isDirectory())
            throw new Error(`--out ${opts.out} is a directory, not a file`);
        const dir = path.dirname(opts.out);
        if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory())
            throw new Error(
                `--out ${opts.out}: its directory ${dir} does not exist`
            );
    }
    return opts;
}

function main(argv) {
    let opts;
    try {
        opts = parseArgs(argv);
    } catch (e) {
        return usage(e.message);
    }
    let text = '';
    let context = {};
    let subject;
    if (opts.check) {
        subject = opts.check;
        text = readFileSync(opts.check, 'utf8')
            .replace(/^\uFEFF/, '')
            .replace(/\r\n/g, '\n')
            .trim();
    } else {
        subject = opts.desktop;
        const changelog = readFileSync(path.join(opts.root, CHANGELOG), 'utf8');
        const entry = findEntry(changelog, opts.desktop);
        if (!entry) {
            context = {
                tag: opts.desktop,
                entryMissing: true,
                unreleased: findEntry(changelog, 'Unreleased') !== null,
            };
        } else {
            const rendered = render(
                entry.body,
                `Floe Desktop ${opts.desktop.replace(/^desktop-v/, '')}`
            );
            text = rendered.text;
            context = {
                titled: true,
                tags: entry.tags,
                urls: rendered.urls,
                mdx: rendered.mdx,
                headline: rendered.headline,
            };
        }
    }
    const { hard, notes } = check(text, context);
    const fingerprint = djb2(text);
    if (opts.out && !context.entryMissing)
        writeFileSync(opts.out, `${text}\n`, 'utf8');
    const written = opts.out && !context.entryMissing;
    const summary = `release-notes: ${subject}: ${hard.length} hard, ${notes.length} notes, ${text.length}/${STORE_MAX} chars${written ? `, written to ${opts.out}` : ''}`;
    const exitCode = hard.length ? 1 : 0;
    if (opts.json) {
        console.log(
            JSON.stringify(
                {
                    tag: opts.desktop,
                    text,
                    len: text.length,
                    djb2: fingerprint,
                    hard,
                    notes,
                    urls: context.urls || [],
                    out: written ? opts.out : null,
                    summary,
                    exitCode,
                },
                null,
                4
            )
        );
        return exitCode;
    }
    for (const h of hard) console.log(`HARD  ${h.check}  ${h.message}`);
    for (const n of notes) console.log(`NOTE  ${n.check}  ${n.message}`);
    if (!context.entryMissing) {
        console.log(`--- text (${text.length} chars, djb2 ${fingerprint}) ---`);
        console.log(text);
        console.log('--- end ---');
        console.log(`json: ${JSON.stringify(text)}`);
    }
    console.log(summary);
    return exitCode;
}

const invokedDirectly =
    process.argv[1] &&
    path.resolve(process.argv[1]).toLowerCase() ===
        fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
