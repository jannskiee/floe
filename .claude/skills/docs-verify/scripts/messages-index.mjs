#!/usr/bin/env node
/**
 * Prints docs/messages.mdx, the message index, from references/messages.json.
 *
 * Why the page is generated: it is one row per message Floe can show, several
 * hundred of them, each with a link to the heading that explains it. Kept by
 * hand it would drift from the apps on the first reworded string. Generated,
 * the `messages` check in docs-check.mjs can hold the page to this script's
 * output and the rows to their sources.
 *
 * Why `renderIndex` takes its link labels from the caller and imports nothing
 * from docs-check.mjs: docs-check.mjs imports `renderIndex` for that compare,
 * so a static import the other way would be a cycle. The command below loads
 * docs-check.mjs only when it runs.
 *
 * What a cell has to survive, each of which has broken a docs page before:
 * MDX reads `{` as the start of an expression and `<` as the start of a tag,
 * a pipe ends the cell, and a straight double quote that opens a cell is
 * turned the wrong way by Mintlify (the `tables` check fails on it). So an
 * app's words go between typed quotation marks with those characters
 * escaped, and a terminal or log line goes in a code span, where only the
 * pipe needs anything.
 *
 * Usage:
 *   node messages-index.mjs [--root <repo>] [--write]
 * Without --write the page goes to stdout and nothing is written.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MESSAGES_FILE =
    '.claude/skills/docs-verify/references/messages.json';
export const INDEX_PAGE = 'messages';
// Every surface a row may name, in the order messages.json lists them.
export const SURFACES = [
    'web',
    'web-request',
    'site',
    'desktop',
    'cli',
    'server',
];

// The page's sections, in reading order, and the surfaces each one lists.
// The second heading carries an explicit id because of its apostrophe:
// Mintlify keeps that character in the id it would generate, and no link
// typed by hand can rely on one.
const SECTIONS = [
    ['In the browser', ['web', 'site']],
    ["On a request link's page {#on-a-request-link-page}", ['web-request']],
    ['In Floe Desktop', ['desktop']],
    ['On the command line', ['cli']],
    ['From a self-hosted server', ['server']],
];
// Surfaces whose messages are terminal or log lines, shown in code.
const CODE_SURFACES = new Set(['cli', 'server']);
const NO_HOME = 'Not explained yet';

const FRONTMATTER = [
    '---',
    'title: "Every message Floe can show"',
    'sidebarTitle: "Message index"',
    'description: "Look up a message from the Floe web app, Floe Desktop, the CLI or a self-hosted server, and follow the link to the section that explains it."',
    'keywords: ["error message", "message index", "what does this message mean", "status line", "log line"]',
    '---',
];
const OPENING = [
    'This page lists the messages Floe shows, grouped by where you see them. Find the words you saw',
    '(the find command of your browser is the quickest way), then follow the link beside them to the',
    'section that says what they mean and what to do. A part in braces, such as `{name}` or `{n}`,',
    'stands for something that changes, like a file name or a count. A message marked Not explained',
    'yet has no section of its own so far.',
];

// Sorted the way a reader scans for a message: no case, no quotation marks,
// and nothing in front of the first letter or digit. Compared by code unit,
// never by locale, so the page is the same on every machine.
function sortKey(text) {
    return text
        .toLowerCase()
        .replace(/["'`\u201c\u201d\u2018\u2019]/g, '')
        .replace(/^[^a-z0-9]+/, '');
}

function byMessage(a, b) {
    const [ka, kb] = [sortKey(a.text), sortKey(b.text)];
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
}

function proseCell(text) {
    const escaped = text
        .replace(/&(?=#?\w+;)/g, '&amp;')
        .replace(/[\\`*_[\]{}~|]/g, '\\$&')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    return `\u201c${escaped}\u201d`;
}

// A code span closes on a run of backticks as long as the one that opened it,
// so the fence is one longer than the longest run inside, with a space each
// side that Markdown takes back off.
function codeCell(text) {
    const longest = Math.max(
        0,
        ...(text.match(/`+/g) || []).map((run) => run.length)
    );
    const fence = '`'.repeat(longest + 1);
    const pad = longest > 0 ? ' ' : '';
    return `${fence}${pad}${text.replace(/\|/g, '\\|')}${pad}${fence}`;
}

function homeCell(row, labelFor) {
    if (row.anchor === null) return NO_HOME;
    const label = (labelFor(row.anchor) ?? row.anchor).replace(/\|/g, '\\|');
    return `[${label}](${row.anchor})`;
}

/**
 * The page as one string, ending in a single line feed. `labelFor(anchor)`
 * gives the words of a link, or null when it has none to give.
 */
export function renderIndex(rows, labelFor = () => null) {
    const out = [...FRONTMATTER, '', ...OPENING, ''];
    for (const [heading, surfaces] of SECTIONS) {
        const lines = new Set();
        for (const row of rows
            .filter((r) => surfaces.includes(r.surface))
            .sort(byMessage)) {
            // A message that is deliberately not explained is not listed.
            if (row.anchor === null && row.why_no_home) continue;
            const text = row.text.replace(/\s+/g, ' ').trim();
            const cell = CODE_SURFACES.has(row.surface)
                ? codeCell(text)
                : proseCell(text);
            lines.add(`| ${cell} | ${homeCell(row, labelFor)} |`);
        }
        if (!lines.size) continue;
        out.push(
            `## ${heading}`,
            '',
            '| Message | Explained at |',
            '| --- | --- |',
            ...lines,
            ''
        );
    }
    return out.join('\n');
}

export function readMessages(root) {
    return JSON.parse(
        readFileSync(join(root, MESSAGES_FILE), 'utf8').replace(/^\ufeff/, '')
    );
}

async function main(args) {
    let root = resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        '..'
    );
    let write = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--root') root = resolve(args[++i] || '');
        else if (args[i] === '--write') write = true;
        else {
            console.error(
                'usage: node messages-index.mjs [--root <repo>] [--write]'
            );
            process.exit(2);
        }
    }
    if (!existsSync(join(root, MESSAGES_FILE))) {
        console.error(`messages-index: ${root} has no ${MESSAGES_FILE}`);
        process.exit(2);
    }
    const { anchorLabel, readPages } = await import('./docs-check.mjs');
    const pages = readPages(join(root, 'docs'));
    const mdx = renderIndex(readMessages(root), (anchor) =>
        anchorLabel(pages, anchor)
    );
    if (!write) {
        // `| head` closes the pipe early; that is not an error worth a trace.
        process.stdout.on('error', (e) =>
            process.exit(e.code === 'EPIPE' ? 0 : 1)
        );
        return process.stdout.write(mdx);
    }
    const file = join(root, 'docs', `${INDEX_PAGE}.mdx`);
    writeFileSync(file, mdx);
    console.error(`messages-index: wrote ${file}`);
}

// Both sides through realpath, as docs-check.mjs does and for its reason.
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
// Not awaited: docs-check.mjs imports this module, so a top-level await here
// would wait on an import that is waiting on this file.
if (invokedDirectly)
    main(process.argv.slice(2)).catch((e) => {
        console.error(`messages-index: ${e.message}`);
        process.exit(1);
    });
