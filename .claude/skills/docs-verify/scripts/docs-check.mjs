#!/usr/bin/env node
/**
 * Docs pre-flight: the decidable half of a docs review, run before a PR opens.
 *
 * Why it exists: the docs have shipped a dead link target, a nav entry without a
 * page, a link label naming a page by a title it does not have (#330, #332 and
 * #338 each found more of those after the previous sweep had "finished"), and a
 * documented server default that contradicted server/server.js (the
 * TRUSTED_PROXY_COUNT default and the #239 stack-trace note are the same
 * commit). Mintlify's own checks run on its side after the push, Vale runs
 * there too, and nothing local looked at any of this. Every check here is a
 * defect class that actually happened.
 *
 * Why HARD and NOTE: exit 1 is reserved for what a script can decide (a target
 * that does not exist, a dash character, a default that disagrees with code).
 * Everything that needs judgment (is this label prose or a page name, is this
 * heading id stable) prints as NOTE and exits 0, because a naive label
 * heuristic is noisy and a check that cries wolf gets ignored. Read every
 * NOTE; do not tune the escapes until the script says nothing.
 *
 * Why anchors have an "unstable" class: Mintlify keeps quotes, apostrophes and
 * slashes in the ids it generates, smart-quoting straight quotes on the way
 * (live ids: `if-floe-says-“open-in-your-browser”`,
 * `two-other-limits-which-are-not-floe’s`, `post-/api/code`). A hand-typed
 * link cannot reliably hit those, and a checker that collapsed them blessed
 * two links that are dead on the live site. So a heading containing any of
 * those characters and no explicit {#id} is unstable: a link to it is a NOTE
 * telling the author to add an id, and every such heading gets one NOTE of
 * its own. Everything else collapses to [a-z0-9-], which is how the docs'
 * own links are written.
 *
 * Why pure node:fs and no subprocess: it must run identically from the repo
 * root, from a node:test temp copy, and on a machine with no pnpm or jq on
 * PATH (both have been missing here).
 *
 * Why `tables` exists: Mintlify renders what no local check sees. A delimiter
 * row with one cell more than its header is not a table to GFM, so the block
 * renders as a paragraph of raw pipes (reference/limits shipped five of those
 * in #518, found on production the next day). A straight quote at the edge of
 * a cell is judged by the neighboring cell's text and can be turned the wrong
 * way by the smart-quote pass, where typed marks are always right. Both are
 * decidable from the source and HARD. A table of five or more columns is cut
 * at 1280 wide by the theme's cell floor unless the stylesheet makes room for
 * it, which depends on the rendered page, so that one prints as NOTE.
 *
 * Why `headings` exists: nothing in this repo compiles MDX. A heading that
 * quotes an in-app string with a placeholder in it, `### Could not read
 * <name>`, is a JSX tag with no closing tag to the compiler, and the page
 * stops building on Mintlify's side while every local check and every CI job
 * stays green (it happened on a release day). So does any other `<` with no
 * space after it that is not a complete tag: `<2 GB`, `<=`, an autolink. A
 * heading is one line, so "is every such `<` a tag that closes in the same
 * heading" is decidable from the source with a small scanner, and the scanner
 * is held to the compiler's answer in both directions by the test's table
 * (this runs in the required gate, where a false flag blocks a correct PR).
 * Braces are skipped whole and never judged. Body prose is not checked: a
 * JSX block there may close many lines later, and telling that from a stray
 * tag needs the real compiler.
 *
 * Why the last five checks only report: `readability`, `pagestandard`,
 * `glossary`, `messages` and `captures` each measure something the docs were
 * not clear of on the day the check was written (2026-10-14: 85 sentences of
 * more than 35 words on the pages people read, 280 messages with no docs
 * heading that explains them, no picture with its strings recorded). A check
 * that failed on its first day would have been switched off, so each prints
 * NOTE lines until the docs are cleared and one constant is flipped. The
 * section they share, near the end of this file, says how.
 *
 * Usage:
 *   node docs-check.mjs [all|links|nav|frontmatter|headings|labels|tables|env|dashes|
 *                        readability|pagestandard|glossary|messages|captures] [--root <dir>]
 * Tests:
 *   node --test .claude/skills/docs-verify/scripts/docs-check.test.mjs
 * Output lines: `HARD  <check>  <file>:<line>  <message>` and the same with
 * NOTE or info, then `docs-check: N hard, M notes`. Exit 0 no HARD, 1 any
 * HARD, 2 usage or unreadable root.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { haystack, textOccurs } from './message-match.mjs';
import {
    INDEX_PAGE,
    MESSAGES_FILE,
    SURFACES as MESSAGE_SURFACES,
    renderIndex,
} from './messages-index.mjs';
import {
    RELEASED_FILE,
    RELEASED_SURFACES,
    heldToRelease,
} from './released-strings.mjs';

const CHECKS = [
    'links',
    'nav',
    'frontmatter',
    'headings',
    'labels',
    'tables',
    'env',
    'dashes',
    'readability',
    'pagestandard',
    'glossary',
    'messages',
    'captures',
];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.git']);
const SITE = 'https://www.floe.one';

// Every path this script reads, relative to the repo root. The node:test file
// copies exactly these into a temp directory, so a new surface must be added
// here or the test's baseline silently diverges from a real run.
export const SURFACES = [
    'docs',
    'README.md',
    'SELF_HOSTING.md',
    'CONTRIBUTING.md',
    'DESKTOP.md',
    'SECURITY.md',
    'CODE_OF_CONDUCT.md',
    'CLAUDE.md',
    '.github',
    'client/app',
    'client/components',
    'client/lib',
    'client/hooks',
    'client/instrumentation.ts',
    'client/instrumentation-client.ts',
    'client/next.config.mjs',
    'client/playwright.config.ts',
    'client/sentry.client.config.ts',
    'client/sentry.edge.config.ts',
    'client/sentry.server.config.ts',
    'client/vitest.config.ts',
    'client/.env.example',
    'client/public/install.sh',
    'client/public/install.ps1',
    'client/docker',
    'cli',
    'desktop',
    'server/server.js',
    'server/turn.js',
    'server/stats.js',
    'server/policy.js',
    'server/envlimit.js',
    'server/.env.example',
    '.env.docker.example',
    'docker-compose.yml',
    'unraid',
    '.goreleaser.yml',
    '.claude/skills/docs-verify/references',
];

// ---------------------------------------------------------------------------
// Policy constants. Each escape is named so a reviewer can see what the script
// deliberately does not report, and why.
// ---------------------------------------------------------------------------

// An anchor that matches no stable heading and no explicit id is HARD. Flip
// to false only if Mintlify's id rule for plain headings is shown to differ.
const ANCHORS_HARD = true;
// A heading containing any of these has an id Mintlify builds with the
// characters kept, so no hand-typed link matches it reliably.
const UNSTABLE = /["'\u201c\u201d\u2018\u2019/]/;
// Pages that legitimately live outside the nav.
const NAV_EXEMPT = [/^snippets\//];
// Pages allowed to have no sidebarTitle (the changelog's title is its label).
const SIDEBAR_EXEMPT = ['changelog.mdx'];
// Labels that name a surface rather than a page, accepted for any target
// under the given prefix.
const LABEL_ALIASES = { 'Floe Desktop': /^\/desktop\// };
// A label longer than this is a sentence, not a page name. 12, not 6: the
// 7-word "Receiving Files with the Floe Web App" was one of #338's defects,
// and 12 adds no NOTE on today's tree. With LABEL_ESCAPE_CARDS empty, a
// replay of the pre-#338 tree reports all 14 of its defects.
const LABEL_MAX_WORDS = 12;
// The changelog names pages the way each release did at the time.
const LABEL_ESCAPE_FILES = ['changelog.mdx'];
// Card grids exempted from the label rule. Empty on purpose: the former
// self-hosting/overview.mdx entry hid 2 of #338's 14 defects and hides
// nothing legitimate today (all ten Cards match their sidebarTitle).
const LABEL_ESCAPE_CARDS = [];
// Env keys read by code that are set by a build file or a test harness, not by
// an operator.
const INTERNAL = {
    FLOE_DISTRIBUTABLE_IMAGE: 'set by client/Dockerfile only',
    HEARTBEAT_MS: 'test knob read by server/crashguard.test.js; not an operator setting',
    FLOE_TEST_REQUEST_GRACE_MS: 'test knob read by server/crashguard.test.js; can only shorten the request-room grace',
};
// Documented keys the server never reads, and why that is fine.
const NOT_READ = {
    NODE_ENV: 'Express app.get("env") only; Floe never reads it (#239)',
};
// Rows whose documented value cannot be compared with code because it is
// inlined at build time and the published image omits it.
const BUILD_DEPENDENT = {
    NEXT_PUBLIC_SITE_URL: 'inlined by next build; the image carries no value',
};
// Docker and Unraid publish container ports directly, so 0 proxy hops is the
// correct default there even though server.js defaults to 1. server/.env.example
// ships 0 for the same reason: it describes a direct run with no proxy in front.
const ALLOW = {
    TRUSTED_PROXY_COUNT: { docker: '0', unraid: '0', 'server-example': '0' },
};
// Surfaces that document a deliberate subset of the server keys. Each list is
// printed once as an info line; a missing key NOT listed here is a NOTE, and a
// listed key that turns up present is a NOTE too, so the lists stay honest.
const CURATED = {
    'SELF_HOSTING.md': [
        'MAX_CONNECTIONS_PER_IP',
        'MAX_TURN_REQUESTS_PER_IP',
        'MAX_CODE_REQUESTS_PER_IP',
        'MAX_FAILED_CODE_RESOLVES',
        'MAX_ACTIVE_CODES',
        'MAX_REPORT_BYTES',
        'UPSTASH_REDIS_REST_URL',
        'UPSTASH_REDIS_REST_TOKEN',
    ],
    'unraid/floe-server.xml': [
        'PORT',
        'MAX_TURN_REQUESTS_PER_IP',
        'MAX_CODE_REQUESTS_PER_IP',
        'MAX_FAILED_CODE_RESOLVES',
        'MAX_ACTIVE_CODES',
        'MAX_REPORT_BYTES',
    ],
};
// Runtime flags the client reads that no operator sets (Vercel sets
// VERCEL_GIT_COMMIT_SHA itself; a self-host uses SOURCE_COMMIT instead).
const ENV_IGNORE_CLIENT = new Set([
    'NODE_ENV',
    'NEXT_RUNTIME',
    'VERCEL',
    'CI',
    'VERCEL_GIT_COMMIT_SHA',
]);
// A table this wide or wider gets a NOTE. Mintlify's theme gives every cell a
// 150 px minimum and the article column is 529 px at 1280, so three columns
// fit and four were cut mid-word with no scrollbar shown (measured
// 2026-10-11). docs/style.css now lowers that floor to 104 px for a table with
// a fourth header cell, which is what lets the four-column comparison grid on
// choosing-floe fit. Five columns get the same floor, which is 520 px of the
// 529, so they need a look at the rendered page. Three is still the docs' own
// limit for anything that is not a comparison grid.
const WIDE_TABLE_COLUMNS = 5;
// A quotation at the edge of a table cell, behind any emphasis or link markup
// (the smart-quote pass sees the text, not the markup). The closing form is a
// quote straight after punctuation other than a sentence end.
const OPENS_WITH_QUOTE = /^(?:\*\*|__|\*|_|~~|\[)*"/;
const CLOSES_WITH_QUOTE = /[^\s\w.!?"`]"(?:\*\*|__|\*|_|~~|\]\([^)]*\))*$/;
// Frontmatter keys Mintlify typesets: two hyphens in any of them render as one
// em dash in the visible page while the meta tag keeps both, so a description
// naming `--server` showed a flag that does not exist (cli/self-hosted-server,
// 2026-10-11).
const TYPESET_KEYS = ['title', 'sidebarTitle', 'description'];
// The server modules read exactly 18 keys between them today: ten in
// server.js, five in turn.js and three in stats.js, the six MAX_* ones
// through envLimit. Fewer means the extractor
// regex broke, not that the server lost a setting; raise this when a key is
// added, in the same PR. It stood at 16 for two keys after #503 added
// POLICY_FILE and FLOE_TEST_REQUEST_GRACE_MS, so the extractor could have lost
// two keys with nothing said; the env check now prints a NOTE whenever the
// count is above the floor, on the PR that adds the key and without failing
// it. Exported so the test can build trees around it instead of reading the
// repository's own server/, whose count a product PR is free to change.
// Counting across the directory rather than one file is what keeps
// a module extraction from tripping this: the five TURN keys moving to
// server/turn.js would otherwise have read as five lost, and the hard fail
// below returns early, taking every downstream env comparison with it.
export const SERVER_KEY_FLOOR = 18;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function walk(dir, exts, skip = () => false, out = []) {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        if (skip(full)) continue;
        const st = statSync(full);
        if (st.isDirectory()) walk(full, exts, skip, out);
        else if (exts.includes(extname(name))) out.push(full);
    }
    return out;
}

// CRLF and a UTF-8 BOM are normalized on read: a Windows checkout leaves \r on
// every line and a per-line `(.*)$` then matches nothing, which once emptied
// every heading set and every .env parser at the same time; a BOM would make
// the first line of a frontmatter block fail to equal "---".
function read(file) {
    return readFileSync(file, 'utf8')
        .replace(/^\uFEFF/, '')
        .replace(/\r\n/g, '\n');
}

function unquote(v) {
    return v.trim().replace(/^["']|["']$/g, '');
}

// existsSync follows the file system's own rule, and on Windows and macOS that
// rule ignores letter case. Mintlify builds on Linux, where /images/Send.png
// and /images/send.png are two files, so a path that only resolves by case
// folding is a broken image or a failed snippet import in production. This
// walks the path one segment at a time against the real directory listing.
const dirListings = new Map();
function existsExact(base, relPath) {
    let dir = base;
    for (const seg of relPath.split('/').filter(Boolean)) {
        if (!dirListings.has(dir)) {
            let names = [];
            try {
                names = readdirSync(dir);
            } catch {
                names = [];
            }
            dirListings.set(dir, new Set(names));
        }
        if (!dirListings.get(dir).has(seg)) return false;
        dir = join(dir, seg);
    }
    return existsSync(dir);
}

// Why a path failed, for the message: nothing there at all, or a file whose
// name differs only by letter case.
function missingReason(base, relPath) {
    return existsSync(join(base, relPath))
        ? ' (a file exists there under a different letter case; Mintlify builds on Linux, where case matters)'
        : '';
}

// One Markdown table row as trimmed cells, or null when the line is not a
// row. `\|` is a literal pipe inside a cell, in code spans too (GFM), so it is
// taken out before the split and put back after.
function tableCells(line) {
    const t = line.trim();
    if (!t.includes('|')) return null;
    const body = t
        .replace(/\\\|/g, '\u0000')
        .replace(/^\|/, '')
        .replace(/\|$/, '');
    return body.split('|').map((c) => c.replace(/\u0000/g, '\\|').trim());
}

function isDelimiterRow(line) {
    const cells = tableCells(line);
    return (
        cells !== null &&
        cells.length > 0 &&
        cells.every((c) => /^:?-+:?$/.test(c))
    );
}

function frontmatter(mdx) {
    const lines = mdx.split('\n');
    if (lines[0] !== '---') return { present: false };
    const fm = { present: true };
    for (let i = 1; i < lines.length; i++) {
        if (lines[i] === '---') break;
        const m = lines[i].match(/^([A-Za-z]+):\s*(.*)$/);
        if (m) fm[m[1]] = unquote(m[2]);
    }
    return fm;
}

// Blank fenced code blocks and MDX comment spans while keeping every line, so
// indexes still map to the original line numbers and a link or heading inside
// either is never scanned.
function stripFences(mdx) {
    const lines = mdx.split('\n');
    // The fence that is open: its character and its length. A block closes
    // only on a line of the same character, at least as long, with nothing
    // after it, so a tilde fence, and a three-backtick fence shown inside a
    // four-backtick one, are blanked whole.
    let open = null;
    const noFences = lines
        .map((line) => {
            const m = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
            if (m && open === null) {
                open = { mark: m[1][0], length: m[1].length };
                return '';
            }
            if (m && m[1][0] === open.mark && m[1].length >= open.length && m[2].trim() === '') {
                open = null;
                return '';
            }
            return open ? '' : line;
        })
        .join('\n');
    return noFences.replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) =>
        m.replace(/[^\n]/g, '')
    );
}

export function slug(text) {
    return text
        .replace(/[`*"'\u201c\u201d\u2018\u2019]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

// Returns { ids: Map<id, raw heading text>, unstable: [{ slug, raw, line }] }.
// Explicit {#id} always wins. <Update label> entries become ids the way
// Mintlify renders the changelog. A heading with UNSTABLE characters and no
// explicit id goes to `unstable` with its collapsed slug, so a link aimed at
// it can be recognized and reported as a NOTE rather than a dead anchor.
export function headingSlugs(mdx) {
    const ids = new Map();
    const unstable = [];
    const lines = stripFences(mdx).split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const h = line.match(/^#{1,6}\s+(.*)$/);
        if (h) {
            const explicit = h[1].match(/^(.*?)\s*\{#([^}]+)\}\s*$/);
            if (explicit) ids.set(explicit[2], explicit[1].trim());
            else if (UNSTABLE.test(h[1]))
                unstable.push({
                    slug: slug(h[1]),
                    raw: h[1].trim(),
                    line: i + 1,
                });
            else ids.set(slug(h[1]), h[1].trim());
            continue;
        }
        const u = line.match(/<Update\s+label="([^"]+)"/);
        if (u) ids.set(slug(u[1]), u[1]);
    }
    return { ids, unstable };
}

// Raw heading text for an anchor, from a stable id or an unstable heading.
function headingAt(headings, id) {
    if (headings.ids.has(id)) return headings.ids.get(id);
    const collapsed = slug(id);
    return headings.unstable.find((h) => h.slug === collapsed)?.raw;
}

// Walks every array and object under `navigation` (groups, tabs, anchors,
// dropdowns, versions, languages all wrap groups). Only strings that sit
// directly in a `pages` array are pages; the nearest enclosing `group` names
// them.
function navPages(docsJson) {
    const pages = [];
    const groupOf = new Map();
    (function visit(node, group, inPages) {
        if (typeof node === 'string') {
            if (!inPages) return;
            pages.push(node);
            if (!groupOf.has(node)) groupOf.set(node, group);
        } else if (Array.isArray(node)) {
            node.forEach((n) => visit(n, group, inPages));
        } else if (node && typeof node === 'object') {
            const g = typeof node.group === 'string' ? node.group : group;
            for (const [k, v] of Object.entries(node))
                visit(v, g, k === 'pages');
        }
    })(docsJson.navigation, null, false);
    return { pages, groupOf };
}

function lineOf(text, index) {
    let n = 1;
    for (let i = 0; i < index && i < text.length; i++)
        if (text[i] === '\n') n++;
    return n;
}

function rel(root, file) {
    return relative(root, file).split('\\').join('/');
}

function isTest(file) {
    return (
        /\.test\.(ts|tsx|mjs|js)$|_test\.go$/.test(file) ||
        /[\\/]e2e[\\/]/.test(file)
    );
}

class Report {
    constructor() {
        this.hard = 0;
        this.notes = 0;
    }
    line(kind, check, where, msg) {
        console.log(`${kind}  ${check}  ${where}  ${msg}`);
    }
    hardLine(check, where, msg) {
        this.hard++;
        this.line('HARD', check, where, msg);
    }
    note(check, where, msg) {
        this.notes++;
        this.line('NOTE', check, where, msg);
    }
    info(check, where, msg) {
        this.line('info', check, where, msg);
    }
}

// ---------------------------------------------------------------------------
// Shared context: everything more than one check needs.
// ---------------------------------------------------------------------------

function buildContext(root, report) {
    const docsDir = join(root, 'docs');
    const docsJsonPath = join(docsDir, 'docs.json');
    let docsJson = { navigation: {} };
    try {
        docsJson = JSON.parse(read(docsJsonPath));
    } catch (e) {
        report.hardLine(
            'nav',
            'docs/docs.json:1',
            `cannot parse: ${e.message}`
        );
    }
    const nav = navPages(docsJson);
    const mdxFiles = walk(docsDir, ['.mdx']);
    const pages = readPages(docsDir);
    return { root, report, docsDir, docsJson, nav, mdxFiles, pages };
}

// Every page under docs/ by its nav path. Exported for the message index
// scripts, which resolve an anchor against the same heading ids the `links`
// check uses: a second reading of which ids exist would let the two disagree.
export function readPages(docsDir) {
    const pages = new Map();
    for (const file of walk(docsDir, ['.mdx'])) {
        const text = read(file);
        const page = rel(docsDir, file).replace(/\.mdx$/, '');
        pages.set(page, {
            file,
            text,
            fm: frontmatter(text),
            headings: headingSlugs(text),
        });
    }
    return pages;
}

// The words a link to `anchor` (/page or /page#id) should carry: the heading's
// own text, or the page's sidebar name. Those are what the `labels` check
// accepts, so a generated page that uses them adds no label note. null when
// the anchor names nothing.
export function anchorLabel(pages, anchor) {
    const [path, id] = anchor.split('#');
    const rec = pages.get(path.replace(/^\/+|\/+$/g, ''));
    if (!rec) return null;
    if (id === undefined) return rec.fm.sidebarTitle || rec.fm.title || null;
    const raw = rec.headings.ids.get(id);
    return raw ? raw.replace(/["\u201c\u201d]/g, '') : null;
}

// Resolve a docs path (leading slash, no anchor) to a page record, a static
// asset, a directory URL, or nothing.
function resolveDocsPath(ctx, path) {
    const clean = path.replace(/\/+$/, '');
    if (clean === '' || clean === '/') return { kind: 'root' };
    const page = clean.slice(1);
    if (/\.[a-z0-9]+$/i.test(page)) {
        return existsExact(ctx.docsDir, page)
            ? { kind: 'asset' }
            : { kind: 'missing' };
    }
    if (ctx.pages.has(page))
        return { kind: 'page', page, rec: ctx.pages.get(page) };
    const first = ctx.nav.pages.find((p) => p.startsWith(page + '/'));
    if (first) return { kind: 'dir', first };
    return { kind: 'missing' };
}

// ---------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------

const ABS_DOCS_URL =
    /https?:\/\/(?:www\.)?floe\.one\/docs(\/[A-Za-z0-9/_.-]*)?(#[A-Za-z0-9_-]+)?/g;
const REL_LINK = /\]\((\/[^)\s#]*)(#[^)\s]*)?\)/g;
const REL_HREF = /href="(\/[^"#]*)(#[^"]*)?"/g;

function absoluteSources(root) {
    const files = [];
    for (const f of [
        'README.md',
        'SELF_HOSTING.md',
        'CONTRIBUTING.md',
        'DESKTOP.md',
        'SECURITY.md',
        'docs/docs.json',
    ]) {
        if (existsSync(join(root, f))) files.push(join(root, f));
    }
    files.push(...walk(join(root, '.github'), ['.md', '.yml']));
    for (const d of ['app', 'components', 'lib', 'hooks']) {
        files.push(
            ...walk(join(root, 'client', d), ['.ts', '.tsx']).filter(
                (f) => !isTest(f)
            )
        );
    }
    files.push(...walk(join(root, 'cli'), ['.go']));
    files.push(
        ...walk(join(root, 'desktop'), ['.go'], (p) =>
            /[\\/]frontend[\\/]wailsjs$/.test(p)
        )
    );
    files.push(
        ...walk(join(root, 'desktop', 'frontend', 'src'), ['.ts', '.tsx'])
    );
    return files;
}

function checkTarget(ctx, where, path, anchor) {
    const r = resolveDocsPath(ctx, path);
    if (r.kind === 'missing') {
        ctx.report.hardLine(
            'links',
            where,
            `${path} has no docs/${path.slice(1)}.mdx and is not a static asset`
        );
        return;
    }
    if (r.kind === 'dir') {
        ctx.report.note(
            'links',
            where,
            `${path} is a directory URL; Mintlify redirects to /${r.first} (measured 2026-08-28)`
        );
        return;
    }
    if (!anchor || r.kind !== 'page') return;
    const id = anchor.slice(1);
    const h = r.rec.headings;
    if (h.ids.has(id)) return;
    const collapsed = slug(id);
    const u = h.unstable.find((x) => x.slug === collapsed);
    if (u) {
        ctx.report.note(
            'links',
            where,
            `${anchor} targets an unstable heading ("${u.raw}"); give the heading an explicit {#id} and link to that`
        );
        return;
    }
    const known = [...h.ids.keys()];
    const shown =
        known.slice(0, 8).join(', ') + (known.length > 8 ? ', ...' : '');
    const msg = `${anchor} not found in docs/${r.page}.mdx (known: ${shown})`;
    if (ANCHORS_HARD) ctx.report.hardLine('links', where, msg);
    else ctx.report.note('links', where, msg);
}

function checkLinks(ctx) {
    for (const [, rec] of ctx.pages) {
        const text = stripFences(rec.text);
        const where = rel(ctx.root, rec.file);
        for (const re of [REL_LINK, REL_HREF]) {
            for (const m of text.matchAll(re)) {
                checkTarget(
                    ctx,
                    `${where}:${lineOf(text, m.index)}`,
                    m[1],
                    m[2] || ''
                );
            }
        }
    }
    for (const file of absoluteSources(ctx.root)) {
        const text = read(file);
        const where = rel(ctx.root, file);
        for (const m of text.matchAll(ABS_DOCS_URL)) {
            // The path class has to allow a dot, so a URL that ends a
            // sentence takes the full stop with it. No docs path ends in one.
            const path = (m[1] || '/').replace(/\.+$/, '') || '/';
            checkTarget(
                ctx,
                `${where}:${lineOf(text, m.index)}`,
                path,
                m[2] || ''
            );
        }
    }
    for (const [, rec] of ctx.pages) {
        const where = rel(ctx.root, rec.file);
        for (const u of rec.headings.unstable) {
            ctx.report.note(
                'links',
                `${where}:${u.line}`,
                `unstable heading "${u.raw}": Mintlify keeps quotes, apostrophes and slashes in the generated id; add an explicit {#id}`
            );
        }
    }
    checkFooterMirror(ctx);
    checkAssets(ctx);
    checkSnippets(ctx);
    checkClientDocsPaths(ctx);
}

// An <img> or any other src= that names a file which is not under docs/
// renders as a broken image, and nothing else looks: Mintlify's own link check
// follows links, not image sources. A screenshot renamed or dropped without
// its page is how this happens.
const ASSET_SRC = /\bsrc="(\/[^"#?]+)"/g;

function checkAssets(ctx) {
    for (const [, rec] of ctx.pages) {
        const text = stripFences(rec.text);
        const where = rel(ctx.root, rec.file);
        for (const m of text.matchAll(ASSET_SRC)) {
            if (existsExact(ctx.docsDir, m[1].slice(1))) continue;
            ctx.report.hardLine(
                'links',
                `${where}:${lineOf(text, m.index)}`,
                `src ${m[1]} has no file at docs${m[1]}${missingReason(ctx.docsDir, m[1].slice(1))}`
            );
        }
    }
}

// A page takes a snippet in with `import Name from '/snippets/x.mdx';` and
// renders it as <Name />. A path that names no file fails that page's build on
// Mintlify's side, and Mintlify then keeps serving the page's previous build
// while every check reports success (what #506 did to troubleshooting.mdx by
// another route). An import that is never rendered, and a snippet that no
// page imports, are text nobody sees: both are NOTEs.
const SNIPPET_IMPORT =
    /^import\s+([A-Za-z_][\w]*)\s+from\s+['"](\/[^'"]+)['"];?[ \t]*$/gm;

function checkSnippets(ctx) {
    const imported = new Set();
    for (const [, rec] of ctx.pages) {
        const text = stripFences(rec.text);
        const where = rel(ctx.root, rec.file);
        for (const m of text.matchAll(SNIPPET_IMPORT)) {
            const [, name, path] = m;
            const at = `${where}:${lineOf(text, m.index)}`;
            if (!existsExact(ctx.docsDir, path.slice(1))) {
                ctx.report.hardLine(
                    'links',
                    at,
                    `import of ${path}: no file at docs${path}${missingReason(ctx.docsDir, path.slice(1))}`
                );
                continue;
            }
            imported.add(path.slice(1).replace(/\.mdx$/, ''));
            if (!new RegExp(`<${name}[\\s/>]`).test(text))
                ctx.report.note(
                    'links',
                    at,
                    `${name} is imported from ${path} and never rendered`
                );
        }
    }
    for (const [page, rec] of ctx.pages) {
        if (!page.startsWith('snippets/') || imported.has(page)) continue;
        ctx.report.note(
            'links',
            `${rel(ctx.root, rec.file)}:1`,
            'snippet is imported by no page'
        );
    }
}

// The web client reaches the docs through the /docs rewrite, so a link it
// writes as a bare path ('/docs/web-app/request-links') carries no site origin
// and ABS_DOCS_URL cannot see it. The request page's help link is one
// (REQUEST_LINK_DOCS_PATH in client/lib/request/constants.ts), and it went
// unchecked when its target section moved to a page of its own. The character
// class stops at ':' and '*', so a route pattern such as '/docs/:path*' is not
// a match.
const REL_DOCS_LITERAL =
    /(['"`])\/docs(\/[A-Za-z0-9/_.-]*)?(#[A-Za-z0-9_-]+)?\1/g;

function checkClientDocsPaths(ctx) {
    for (const d of ['app', 'components', 'lib', 'hooks']) {
        for (const file of walk(join(ctx.root, 'client', d), ['.ts', '.tsx'])) {
            if (isTest(file)) continue;
            const text = read(file);
            const where = rel(ctx.root, file);
            for (const m of text.matchAll(REL_DOCS_LITERAL)) {
                checkTarget(
                    ctx,
                    `${where}:${lineOf(text, m.index)}`,
                    m[2] || '/',
                    m[3] || ''
                );
            }
        }
    }
}

// Footer.tsx `columns` and docs.json `footer.links` are documented mirrors
// (client/components/layout/Footer.tsx header comment). Report-only: the
// script cannot know which side is right.
function checkFooterMirror(ctx) {
    const tsxPath = join(
        ctx.root,
        'client',
        'components',
        'layout',
        'Footer.tsx'
    );
    if (!existsSync(tsxPath) || !Array.isArray(ctx.docsJson.footer?.links))
        return;
    const norm = (href) =>
        (href.startsWith('/') ? SITE + href : href).replace(/\/+$/, '');
    const docs = [];
    for (const col of ctx.docsJson.footer.links) {
        docs.push({ header: col.header });
        for (const it of col.items || [])
            docs.push({ label: it.label, href: norm(it.href) });
    }
    const tsx = read(tsxPath);
    const site = [];
    for (const m of tsx.matchAll(
        /label:\s*'([^']*)'|\{\s*name:\s*'([^']*)',\s*href:\s*'([^']*)'/g
    )) {
        if (m[1] !== undefined) site.push({ header: m[1] });
        else site.push({ label: m[2], href: norm(m[3]) });
    }
    const where = 'docs/docs.json:1';
    const len = Math.max(docs.length, site.length);
    for (let i = 0; i < len; i++) {
        const a = docs[i];
        const b = site[i];
        if (JSON.stringify(a) === JSON.stringify(b)) continue;
        ctx.report.note(
            'links',
            where,
            `footer mirror differs at item ${i + 1}: docs.json ${JSON.stringify(a ?? null)} vs Footer.tsx ${JSON.stringify(b ?? null)}`
        );
    }
}

// ---------------------------------------------------------------------------
// nav
// ---------------------------------------------------------------------------

function checkNav(ctx) {
    if (!ctx.nav.pages.length) {
        ctx.report.hardLine(
            'nav',
            'docs/docs.json:1',
            'navigation resolved to zero pages (no strings under a pages key; the shape is not one this script walks)'
        );
        return;
    }
    const seen = new Set();
    for (const page of ctx.nav.pages) {
        if (seen.has(page))
            ctx.report.note(
                'nav',
                'docs/docs.json:1',
                `duplicate nav entry "${page}"`
            );
        seen.add(page);
        if (!ctx.pages.has(page))
            ctx.report.hardLine(
                'nav',
                'docs/docs.json:1',
                `nav entry "${page}" has no docs/${page}.mdx`
            );
    }
    for (const [page, rec] of ctx.pages) {
        if (seen.has(page) || NAV_EXEMPT.some((re) => re.test(page))) continue;
        ctx.report.hardLine(
            'nav',
            `${rel(ctx.root, rec.file)}:1`,
            `page is not in docs.json navigation`
        );
    }
}

// ---------------------------------------------------------------------------
// frontmatter
// ---------------------------------------------------------------------------

function checkFrontmatter(ctx) {
    for (const [page, rec] of ctx.pages) {
        if (NAV_EXEMPT.some((re) => re.test(page))) continue;
        const where = `${rel(ctx.root, rec.file)}:1`;
        if (!rec.fm.present) {
            ctx.report.hardLine('frontmatter', where, 'no frontmatter block');
            continue;
        }
        if (!rec.fm.title)
            ctx.report.hardLine('frontmatter', where, 'missing title');
        if (!rec.fm.description)
            ctx.report.hardLine('frontmatter', where, 'missing description');
        if (
            !rec.fm.sidebarTitle &&
            !SIDEBAR_EXEMPT.includes(basename(rec.file))
        ) {
            ctx.report.note(
                'frontmatter',
                where,
                'missing sidebarTitle (falls back to title)'
            );
        }
        for (const key of TYPESET_KEYS) {
            if (!rec.fm[key] || !rec.fm[key].includes('--')) continue;
            ctx.report.hardLine(
                'frontmatter',
                where,
                `${key} contains "--": Mintlify renders two hyphens there as an em dash, so a flag name comes out wrong. Name the flag in the body, in code`
            );
        }
    }
}

// ---------------------------------------------------------------------------
// headings
// ---------------------------------------------------------------------------

// What can start a JSX name and what can continue one, and the characters a
// backslash escapes in Markdown (the ASCII punctuation).
const JSX_NAME_START = /[\p{L}$_]/u;
const JSX_NAME_PART = /[\p{L}\p{N}$_-]/u;
const ASCII_PUNCTUATION = /[!-\/:-@[-`{-~]/;
// A Markdown link destination in angle brackets, an optional title, and the
// `)` that closes the link: `<my guide.md>)` or `<a b.png> "title")`.
const LINK_DESTINATION = /^<[^<>]*>\s*(?:"[^"]*"|'[^']*'|\([^()]*\))?\s*\)/;

// The index after the `}` that closes the `{` at `at`, or -1 when nothing
// closes it. A quoted string inside is skipped, so a brace in one is text.
function expressionEnd(text, at) {
    let depth = 0;
    for (let i = at; i < text.length; i++) {
        const c = text[i];
        if (c === '"' || c === "'" || c === '`') {
            let j = i + 1;
            while (j < text.length && text[j] !== c)
                j += text[j] === '\\' ? 2 : 1;
            if (j >= text.length) return -1;
            i = j;
        } else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return i + 1;
    }
    return -1;
}

// The JSX tag that starts at the `<` at `at`, as { kind, name, end }, or null
// when what follows cannot be one. kind is open, close or self; a fragment
// has the empty name. A `>` inside a quoted attribute value or inside an
// attribute's braces does not end the tag.
function jsxTagAt(text, at) {
    const blank = (i) => {
        while (text[i] === ' ' || text[i] === '\t') i++;
        return i;
    };
    // The end of the name that starts at `i`, or -1 when none does.
    const nameEnd = (i) => {
        if (i >= text.length || !JSX_NAME_START.test(text[i])) return -1;
        while (i < text.length && JSX_NAME_PART.test(text[i])) i++;
        return i;
    };
    let i = at + 1;
    const closing = text[i] === '/';
    if (closing) i = blank(i + 1);
    const start = i;
    let end = nameEnd(i);
    if (end < 0 && text[i] !== '>') return null;
    // a.b.c, or one ns:local, each part a name of its own.
    while (end >= 0 && (text[end] === '.' || text[end] === ':')) {
        const local = text[end] === ':';
        end = nameEnd(end + 1);
        if (end < 0) return null;
        if (local) break;
    }
    if (end >= 0) i = end;
    const name = text.slice(start, i);
    if (closing) {
        i = blank(i);
        return text[i] === '>' ? { kind: 'close', name, end: i + 1 } : null;
    }
    for (;;) {
        i = blank(i);
        if (text[i] === '>') return { kind: 'open', name, end: i + 1 };
        if (text[i] === '/') {
            i = blank(i + 1);
            return text[i] === '>' ? { kind: 'self', name, end: i + 1 } : null;
        }
        if (text[i] === '{') {
            i = expressionEnd(text, i);
            if (i < 0) return null;
            continue;
        }
        // An attribute: a name, then perhaps `=` and a quoted or braced value.
        let attr = nameEnd(i);
        if (attr >= 0 && text[attr] === ':') attr = nameEnd(attr + 1);
        if (attr < 0) return null;
        i = blank(attr);
        if (text[i] !== '=') continue;
        i = blank(i + 1);
        if (text[i] === '"' || text[i] === "'") {
            const quote = text.indexOf(text[i], i + 1);
            if (quote < 0) return null;
            i = quote + 1;
        } else if (text[i] === '{') {
            i = expressionEnd(text, i);
            if (i < 0) return null;
        } else return null;
    }
}

// What in one heading's text stops MDX compiling the page, as written and in
// the order written; an empty list is a heading the compiler accepts.
//
// MDX reads a `<` as the start of a JSX tag unless a space or a tab follows
// it, and a heading is one block, so the tag has to be complete and has to
// close inside the heading. Three things therefore break the page: a tag left
// open (`<name>`, `<br>` without its slash), a closing tag with nothing open
// to close, and a `<` that starts no tag at all (`<2 GB`, `<=`, a `<` at the
// end, and an autolink such as `<https://floe.one>`, which is Markdown and
// not MDX). Nothing else is a tag: a code span, a backslash escape, a
// `<...>` link destination straight after `](`, and anything inside braces.
// Braces are skipped whole, because what is inside is JavaScript to MDX and
// the `{#id}` every heading here carries is Mintlify's own syntax, so a
// broken expression is not this check's to find. Whether a component exists
// is not judged either. The test's two lists (what the compiler refuses and
// what it accepts) were each run through @mdx-js/mdx 3.1.1, and this function
// has to agree with every entry.
export function headingTagProblems(heading) {
    const text = heading.trimEnd();
    const open = [];
    const found = [];
    // Whether a `[` that could open a link has been read: one that is not
    // escaped and not inside a code span or braces.
    let bracket = false;
    for (let i = 0; i < text.length; ) {
        const c = text[i];
        if (c === '\\' && ASCII_PUNCTUATION.test(text[i + 1] ?? '')) {
            i += 2;
        } else if (c === '[') {
            bracket = true;
            i++;
        } else if (c === '`') {
            // A code span closes on a run of the same length. Without one the
            // backticks are text and what follows is still read.
            const run = text.slice(i).match(/^`+/)[0].length;
            let close = -1;
            for (const m of text.slice(i + run).matchAll(/`+/g)) {
                if (m[0].length !== run) continue;
                close = i + run + m.index + run;
                break;
            }
            i = close < 0 ? i + run : close;
        } else if (c === '{') {
            const end = expressionEnd(text, i);
            if (end < 0) break;
            i = end;
        } else if (c !== '<' || text[i + 1] === ' ' || text[i + 1] === '\t') {
            i++;
        } else if (
            // A link or image destination: `[` somewhere before, `](` right
            // before, and the `)` that ends the link after the `>`.
            bracket &&
            text.slice(Math.max(0, i - 2), i) === '](' &&
            LINK_DESTINATION.test(text.slice(i))
        ) {
            i = text.indexOf('>', i) + 1;
        } else {
            const tag = jsxTagAt(text, i);
            if (!tag) {
                // The compiler stops here, so nothing after it is read.
                found.push({
                    at: i,
                    text: text.slice(i).match(/^<[^\s>]*>?/)[0],
                });
                break;
            }
            const written = text.slice(i, tag.end);
            if (tag.kind === 'open') {
                open.push({ at: i, name: tag.name, text: written });
            } else if (tag.kind === 'close') {
                if (open.length && open[open.length - 1].name === tag.name)
                    open.pop();
                else found.push({ at: i, text: written });
            }
            i = tag.end;
        }
    }
    return [...found, ...open].sort((a, b) => a.at - b.at).map((p) => p.text);
}

function checkHeadings(ctx) {
    for (const [, rec] of ctx.pages) {
        const where = rel(ctx.root, rec.file);
        const lines = stripFences(rec.text).split('\n');
        // A YAML comment in the frontmatter starts with "#" and is no heading.
        const fmEnd = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
        for (let i = fmEnd + 1; i < lines.length; i++) {
            const h = lines[i].match(/^#{1,6}\s+(.*)$/);
            if (!h) continue;
            const found = headingTagProblems(h[1]);
            if (!found.length) continue;
            ctx.report.hardLine(
                'headings',
                `${where}:${i + 1}`,
                `${found.join(', ')} in a heading: MDX reads a "<" with no space after it as the start of a tag, and unless that tag closes in the same heading the page stops compiling on Mintlify while every local check stays green. Write &lt; for the bracket, or put the text in backticks`
            );
        }
    }
}

// ---------------------------------------------------------------------------
// tables
// ---------------------------------------------------------------------------

// A table is a header row directly above a delimiter row. Rows are read until
// the first line that is not a row. Fenced code and MDX comments are blanked
// first, so a table drawn inside either is never read.
function tablesIn(mdx) {
    const lines = stripFences(mdx).split('\n');
    const tables = [];
    for (let i = 1; i < lines.length; i++) {
        if (!isDelimiterRow(lines[i]) || !lines[i].includes('|')) continue;
        const header = tableCells(lines[i - 1]);
        if (header === null || isDelimiterRow(lines[i - 1])) continue;
        const rows = [];
        let j = i + 1;
        for (; j < lines.length; j++) {
            const cells = tableCells(lines[j]);
            if (cells === null || lines[j].trim() === '') break;
            rows.push({ cells, line: j + 1 });
        }
        tables.push({
            header,
            headerLine: i,
            delimiter: tableCells(lines[i]),
            rows,
        });
        i = j;
    }
    return tables;
}

function checkTables(ctx) {
    for (const [, rec] of ctx.pages) {
        const where = rel(ctx.root, rec.file);
        for (const t of tablesIn(rec.text)) {
            if (t.header.length !== t.delimiter.length) {
                ctx.report.hardLine(
                    'tables',
                    `${where}:${t.headerLine + 1}`,
                    `the header has ${t.header.length} cells and the delimiter row under it has ${t.delimiter.length}: that is not a table, and the block renders as a paragraph of raw pipes`
                );
                continue;
            }
            if (t.header.length >= WIDE_TABLE_COLUMNS)
                ctx.report.note(
                    'tables',
                    `${where}:${t.headerLine}`,
                    `${t.header.length} columns: check the rendered table at 1280 wide, where the theme's cell floor cuts a table this wide`
                );
            // HARD since the docs were cleared of these (#526 typed all 93).
            // Mintlify's smart-quote pass joins the text of a whole row with
            // nothing between the cells, so a straight quote at the edge of a
            // cell is judged by the neighboring cell's character: one that
            // opens a cell reads as a closing mark, and one that closes a cell
            // after a colon or a parenthesis reads as an opening one. Typed
            // marks are right either way, so this is decidable from the source.
            const all = [{ cells: t.header, line: t.headerLine }, ...t.rows];
            for (const row of all) {
                if (row.cells.some((c) => OPENS_WITH_QUOTE.test(c)))
                    ctx.report.hardLine(
                        'tables',
                        `${where}:${row.line}`,
                        'a straight double quote opens a table cell: Mintlify renders it as a closing mark. Type that quotation with curly marks, “ and ”'
                    );
                else if (row.cells.some((c) => CLOSES_WITH_QUOTE.test(c)))
                    ctx.report.hardLine(
                        'tables',
                        `${where}:${row.line}`,
                        'a straight double quote closes a table cell after punctuation: Mintlify renders it as an opening mark. Type that quotation with curly marks, “ and ”'
                    );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

function labelIsProse(label) {
    if (/^`.*`$/.test(label) || label.includes('`')) return true;
    if (/^[a-z]/.test(label)) return true;
    if (label.split(/\s+/).length > LABEL_MAX_WORDS) return true;
    return false;
}

function labelMatches(ctx, label, path, anchor) {
    const r = resolveDocsPath(ctx, path);
    if (r.kind !== 'page') return { ok: true };
    const expected = [
        r.rec.fm.title,
        r.rec.fm.sidebarTitle,
        ctx.nav.groupOf.get(r.page),
    ];
    if (anchor) {
        const raw = headingAt(r.rec.headings, anchor.slice(1));
        if (raw) expected.push(raw.replace(/["\u201c\u201d]/g, ''));
    }
    const set = [...new Set(expected.filter(Boolean))];
    if (set.includes(label)) return { ok: true };
    const alias = LABEL_ALIASES[label];
    if (alias && alias.test(path)) return { ok: true };
    return { ok: false, expected: set };
}

function reportLabel(ctx, where, label, url, path, anchor) {
    const clean = label.replace(/\*\*/g, '').trim();
    const urlish = url.replace(/^https?:\/\/(www\.)?/, '');
    if (clean.replace(/^https?:\/\/(www\.)?/, '') === urlish) return;
    if (labelIsProse(clean)) return;
    const res = labelMatches(ctx, clean, path, anchor);
    if (res.ok) return;
    const exp = res.expected.map((s) => `"${s}"`).join(' | ');
    ctx.report.note(
        'labels',
        where,
        `[${clean}] -> ${path}${anchor}  expected one of ${exp}`
    );
}

function checkLabels(ctx) {
    let docsCount = 0;
    ctx.report.info(
        'labels',
        'docs/',
        'labels that do not name their target by title, sidebarTitle, group, or heading'
    );
    for (const [page, rec] of ctx.pages) {
        if (LABEL_ESCAPE_FILES.includes(page + '.mdx')) continue;
        const text = stripFences(rec.text);
        const where = rel(ctx.root, rec.file);
        for (const m of text.matchAll(
            /\[([^\]\n]+)\]\((\/[^)\s#]*)(#[^)\s]*)?\)/g
        )) {
            docsCount++;
            reportLabel(
                ctx,
                `${where}:${lineOf(text, m.index)}`,
                m[1],
                m[2] + (m[3] || ''),
                m[2],
                m[3] || ''
            );
        }
        if (LABEL_ESCAPE_CARDS.includes(page + '.mdx')) continue;
        for (const m of text.matchAll(/<Card\b[^>]*>/g)) {
            const title = m[0].match(/\btitle="([^"]*)"/);
            const href = m[0].match(/\bhref="(\/[^"#]*)(#[^"]*)?"/);
            if (!title || !href) continue;
            docsCount++;
            reportLabel(
                ctx,
                `${where}:${lineOf(text, m.index)}`,
                title[1],
                href[1] + (href[2] || ''),
                href[1],
                href[2] || ''
            );
        }
    }
    ctx.report.info('labels', 'docs/', `${docsCount} labeled links checked`);

    let siteCount = 0;
    ctx.report.info(
        'labels',
        'client/ + docs.json footer',
        'labels on absolute floe.one/docs links'
    );
    const absLabel = (file, text, re, pick) => {
        const where = rel(ctx.root, file);
        for (const m of text.matchAll(re)) {
            const { label, url } = pick(m);
            const u = url.match(
                /floe\.one\/docs(\/[A-Za-z0-9/_.-]*)?(#[A-Za-z0-9_-]+)?/
            );
            if (!u) continue;
            siteCount++;
            reportLabel(
                ctx,
                `${where}:${lineOf(text, m.index)}`,
                label,
                url,
                u[1] || '/',
                u[2] || ''
            );
        }
    };
    for (const f of [
        'README.md',
        'SELF_HOSTING.md',
        'CONTRIBUTING.md',
        'DESKTOP.md',
        'SECURITY.md',
    ]) {
        const file = join(ctx.root, f);
        if (!existsSync(file)) continue;
        absLabel(
            file,
            read(file),
            /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
            (m) => ({ label: m[1], url: m[2] })
        );
    }
    for (const d of ['app', 'components', 'lib', 'hooks']) {
        for (const file of walk(join(ctx.root, 'client', d), [
            '.ts',
            '.tsx',
        ]).filter((f) => !isTest(f))) {
            absLabel(
                file,
                read(file),
                /\{\s*(?:name|label):\s*'([^']*)'\s*,\s*href:\s*'(https?:\/\/[^']*floe\.one\/docs[^']*)'/g,
                (m) => ({ label: m[1], url: m[2] })
            );
        }
    }
    for (const col of ctx.docsJson.footer?.links || []) {
        for (const it of col.items || []) {
            const u = String(it.href).match(
                /floe\.one\/docs(\/[A-Za-z0-9/_.-]*)?(#[A-Za-z0-9_-]+)?/
            );
            if (!u) continue;
            siteCount++;
            reportLabel(
                ctx,
                'docs/docs.json:1',
                it.label,
                it.href,
                u[1] || '/',
                u[2] || ''
            );
        }
    }
    ctx.report.info(
        'labels',
        'client/ + docs.json footer',
        `${siteCount} labeled links checked`
    );
}

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

function serverEnv(root) {
    const dir = join(root, 'server');
    // server.js stays the anchor every report line points at; the scan is
    // the whole directory. Tests are excluded because they set env vars to
    // drive cases, which would invent keys the server never reads.
    const file = join(dir, 'server.js');
    const keys = new Map();
    if (!existsSync(file)) return { keys, file };
    const sources = readdirSync(dir)
        .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
        .sort()
        .map((f) => join(dir, f));
    for (const line of sources.flatMap((s) => read(s).split(String.fromCharCode(10)))) {
        for (const m of line.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) {
            const key = m[1];
            const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            let def = null;
            let mm;
            if (
                (mm = line.match(
                    new RegExp(
                        `parseInt\\(process\\.env\\.${esc} \\|\\| '', 10\\) \\|\\| \\(([^)]*)\\)`
                    )
                ))
            ) {
                def = /^[\d\s*+()-]+$/.test(mm[1])
                    ? String(Function(`"use strict"; return (${mm[1]});`)())
                    : null;
            } else if (
                (mm = line.match(
                    new RegExp(
                        `parseInt\\(process\\.env\\.${esc} \\|\\| '([^']+)', 10\\)`
                    )
                ))
            ) {
                def = mm[1];
            } else if (
                (mm = line.match(
                    new RegExp(
                        `parseInt\\(process\\.env\\.${esc}, 10\\) \\|\\| ([\\w.]+)`
                    )
                ))
            ) {
                def = mm[1];
            } else if (
                (mm = line.match(
                    new RegExp(
                        `process\\.env\\.${esc} \\|\\| ('[^']*'|"[^"]*"|[\\w.]+)`
                    )
                ))
            ) {
                def = unquote(mm[1]);
            }
            if (!keys.has(key) || (keys.get(key) === null && def !== null))
                keys.set(key, def);
        }
        // The six MAX_* settings are read as envLimit('NAME', default):
        // server/envlimit.js looks the variable up by its name, so the line
        // holds no process.env.NAME for the scan above, and the default is the
        // second argument. Plain arithmetic only (30, or the 5 TiB product);
        // anything else leaves the default unknown, which checkEnv fails on
        // for a MAX_* key rather than compare nothing.
        for (const m of line.matchAll(
            /\benvLimit\('([A-Z_][A-Z0-9_]*)',\s*([^)]*)\)/g
        )) {
            let def = null;
            if (/^[\d\s*+-]*\d[\d\s*+-]*$/.test(m[2])) {
                try {
                    def = String(Function(`"use strict"; return (${m[2]});`)());
                } catch {
                    def = null;
                }
            }
            if (!keys.has(m[1]) || (keys.get(m[1]) === null && def !== null))
                keys.set(m[1], def);
        }
    }
    return { keys, file };
}

function clientEnv(root) {
    const keys = new Set();
    const files = [];
    const top = join(root, 'client');
    if (existsSync(top)) {
        for (const name of readdirSync(top)) {
            if (/\.(ts|mjs)$/.test(name) && statSync(join(top, name)).isFile())
                files.push(join(top, name));
        }
    }
    for (const d of ['app', 'lib', 'components', 'hooks']) {
        files.push(
            ...walk(join(root, 'client', d), ['.ts', '.tsx']).filter(
                (f) => !isTest(f)
            )
        );
    }
    for (const file of files) {
        for (const m of read(file).matchAll(
            /process\.env\.([A-Z_][A-Z0-9_]*)/g
        )) {
            if (!ENV_IGNORE_CLIENT.has(m[1])) keys.add(m[1]);
        }
    }
    return keys;
}

// Reads every table on the page whose header names a Variable, a Service and a
// Default column, in any order and with any other columns beside them. The
// columns are found by name because the earlier parser counted cells: it read
// "name, then exactly three more", so a table that merged, dropped or reordered
// a column either matched nothing or read the service cell as the default, and
// in both cases the HARD default comparison stopped firing with exit 0. A name
// may be plain (`KEY`) or a link to its own entry ([`KEY`](#key)). The first
// row for a key wins.
function parseConfigurationMdx(root) {
    const file = join(root, 'docs', 'self-hosting', 'configuration.mdx');
    const rows = new Map();
    if (!existsSync(file)) return { rows, file };
    for (const t of tablesIn(read(file))) {
        const col = (name) =>
            t.header.findIndex((h) => h.toLowerCase() === name);
        const [vi, si, di] = [col('variable'), col('service'), col('default')];
        if (vi < 0 || si < 0 || di < 0) continue;
        for (const row of t.rows) {
            const name = (row.cells[vi] || '').match(
                /^(?:\[)?`([A-Z_][A-Z0-9_]*)`(?:\]\([^)]*\))?$/
            );
            if (!name || rows.has(name[1])) continue;
            const cell = row.cells[di] || '';
            const tok = cell.match(/`([^`]*)`/);
            const def = /_\(none\)_/.test(cell) ? null : tok ? tok[1] : null;
            rows.set(name[1], {
                service: row.cells[si] || '',
                def,
                line: row.line,
            });
        }
    }
    return { rows, file };
}

function parseContributing(root) {
    const file = join(root, 'CONTRIBUTING.md');
    const client = new Map();
    const server = new Map();
    if (!existsSync(file)) return { client, server, file };
    let section = null;
    let n = 0;
    for (const line of read(file).split('\n')) {
        n++;
        const h = line.match(/^###\s+(.*)$/);
        if (h)
            section = /client/i.test(h[1])
                ? client
                : /server/i.test(h[1])
                  ? server
                  : null;
        const m = line.match(/^\|\s*`([A-Z_][A-Z0-9_]*)`\s*\|/);
        if (!m || !section) continue;
        const d = line.match(/\(default:\s*`([^`]+)`\)/);
        section.set(m[1], { def: d ? d[1] : null, line: n });
    }
    return { client, server, file };
}

function parseSelfHosting(root) {
    const file = join(root, 'SELF_HOSTING.md');
    const keys = new Set();
    if (!existsSync(file)) return { keys, file };
    for (const line of read(file).split('\n')) {
        const m = line.match(/^\|\s*((?:`[A-Z_][A-Z0-9_]*`\s*\/?\s*)+)\|/);
        if (!m) continue;
        for (const k of m[1].matchAll(/`([A-Z_][A-Z0-9_]*)`/g)) keys.add(k[1]);
    }
    return { keys, file };
}

function parseEnvFile(root, relPath) {
    const file = join(root, relPath);
    const vals = new Map();
    if (!existsSync(file)) return { vals, file, relPath };
    const lines = read(file).split('\n');
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^#?\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (!m || vals.has(m[1])) continue;
        // The contiguous comment block right above a key often restates the
        // default ("(default: 30)", "1 (default)", "(default: 5 TiB)") and
        // drifts on its own: a sim changed the code default and two stale
        // lines here would have shipped on exit 0. The nearest mention wins,
        // and the scan stops at a blank line or another key.
        let commentDefault = null;
        let commentLine = 0;
        for (
            let j = i - 1;
            j >= 0 &&
            /^\s*#/.test(lines[j]) &&
            !/^#?\s*[A-Z_][A-Z0-9_]*=/.test(lines[j]);
            j--
        ) {
            const d =
                lines[j].match(
                    /\bdefault:?\s+`?(\d[\w.]*(?:\s*(?:[KMGT]i?B))?)`?/i
                ) || lines[j].match(/(\d[\w.]*)\s+\(default\)/i);
            if (d && commentDefault === null) {
                commentDefault = d[1];
                commentLine = j + 1;
            }
        }
        vals.set(m[1], {
            value: m[2].replace(/\s+#.*$/, '').trim(),
            line: i + 1,
            commentDefault,
            commentLine,
        });
    }
    return { vals, file, relPath };
}

// "5 TiB" in a comment is the same claim as 5497558138880 in code. The suffix
// is read as binary either way: the multiplier below has always been 1024**n,
// so both the accurate label and the loose one resolve to the same number.
function bytesOf(value) {
    const m = String(value).match(/^(\d+(?:\.\d+)?)\s*([KMGT]i?B)$/i);
    if (!m) return null;
    return String(
        Number(m[1]) *
            1024 ** { K: 1, M: 2, G: 3, T: 4 }[m[2][0].toUpperCase()]
    );
}

// Every ${NAME:-value} and ${NAME-value} on a line, with braces balanced so
// a default that holds another reference (${CLIENT_URL:-http://localhost:${CLIENT_PORT:-3000}})
// is read whole, and the references inside a default are read too.
function composeRefs(line) {
    const out = [];
    const re = /\$\{([A-Z_][A-Z0-9_]*)(:-|-|:\?|\?|:\+|\+)?/g;
    let m;
    while ((m = re.exec(line))) {
        let depth = 1;
        let i = re.lastIndex;
        const start = i;
        for (; i < line.length && depth > 0; i++) {
            if (line[i] === '$' && line[i + 1] === '{') {
                depth++;
                i++;
            } else if (line[i] === '}') depth--;
        }
        if (depth !== 0) break;
        const value = line.slice(start, i - 1);
        out.push([m[1], m[2] ?? '', value]);
        out.push(...composeRefs(value));
        re.lastIndex = i;
    }
    return out;
}

export function parseCompose(root) {
    const file = join(root, 'docker-compose.yml');
    const present = new Set();
    const defaults = new Map();
    if (!existsSync(file)) return { present, defaults, file };
    let n = 0;
    for (const line of read(file).split('\n')) {
        n++;
        if (/^\s*#/.test(line)) continue;
        for (const [name, op, value] of composeRefs(line)) {
            present.add(name);
            if (op === ':-' && value !== '' && !defaults.has(name))
                defaults.set(name, { value, line: n });
        }
        const lit = line.match(/^\s+([A-Z_][A-Z0-9_]*):\s*(.*)$/);
        if (lit) {
            present.add(lit[1]);
            if (
                !lit[2].includes('${') &&
                lit[2] !== '' &&
                !defaults.has(lit[1])
            )
                defaults.set(lit[1], { value: lit[2].trim(), line: n });
        }
    }
    return { present, defaults, file };
}

function parseUnraid(root) {
    const dir = join(root, 'unraid');
    const present = new Set();
    const defaults = new Map();
    for (const file of walk(dir, ['.xml'])) {
        const text = read(file);
        for (const m of text.matchAll(
            /Target="([A-Z_][A-Z0-9_]*)"\s+Default="([^"]*)"/g
        )) {
            present.add(m[1]);
            if (m[2] !== '')
                defaults.set(m[1], {
                    value: m[2],
                    where: `${rel(root, file)}:${lineOf(text, m.index)}`,
                });
        }
    }
    return { present, defaults };
}

function sameValue(a, b) {
    if (a === null || b === null || a === undefined || b === undefined)
        return true;
    const na = Number(a);
    const nb = Number(b);
    if (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb))
        return na === nb;
    return String(a) === String(b);
}

function checkEnv(ctx) {
    const { root, report } = ctx;
    const server = serverEnv(root);
    const serverKeys = [...server.keys.keys()];
    const serverFile = rel(root, server.file);
    const noDefault = serverKeys.filter(
        (k) => k.startsWith('MAX_') && server.keys.get(k) === null
    );
    if (serverKeys.length < SERVER_KEY_FLOOR || noDefault.length) {
        report.hardLine(
            'env',
            `${serverFile}:1`,
            `extractor found ${serverKeys.length} keys${noDefault.length ? `, no default for ${noDefault.join(', ')}` : ''}; the regex no longer matches the source`
        );
        return;
    }
    // More keys than the floor is what an ordinary PR that adds a setting
    // looks like. Nothing is wrong with it, but until the floor is raised the
    // check above cannot notice the extractor losing that many keys.
    if (serverKeys.length > SERVER_KEY_FLOOR)
        report.note(
            'env',
            `${serverFile}:1`,
            `the floor is behind: ${serverKeys.length} keys read, floor ${SERVER_KEY_FLOOR}; raise SERVER_KEY_FLOOR in docs-check.mjs`
        );
    const client = clientEnv(root);
    const conf = parseConfigurationMdx(root);
    const contrib = parseContributing(root);
    const selfHost = parseSelfHosting(root);
    const serverExample = parseEnvFile(root, 'server/.env.example');
    const clientExample = parseEnvFile(root, 'client/.env.example');
    const dockerExample = parseEnvFile(root, '.env.docker.example');
    const compose = parseCompose(root);
    const unraid = parseUnraid(root);

    const confRel = rel(root, conf.file);
    const contribRel = rel(root, contrib.file);
    // The page exists and gave no variable rows: its table changed shape. The
    // default comparison below would then compare nothing and pass, so this
    // is a failure of the check itself, like the server extractor's above.
    if (existsSync(conf.file) && conf.rows.size === 0)
        report.hardLine(
            'env',
            `${confRel}:1`,
            'no variable rows found: the page needs a table whose header names Variable, Service and Default, with each variable in backticks'
        );
    const anywhere = (k) =>
        conf.rows.has(k) ||
        contrib.client.has(k) ||
        contrib.server.has(k) ||
        selfHost.keys.has(k) ||
        serverExample.vals.has(k) ||
        clientExample.vals.has(k) ||
        dockerExample.vals.has(k) ||
        compose.present.has(k) ||
        unraid.present.has(k);
    const curatedSurfaces = [
        { name: 'SELF_HOSTING.md', present: selfHost.keys },
        { name: 'unraid/floe-server.xml', present: unraid.present },
    ];
    const curatedAbsent = new Map(curatedSurfaces.map((s) => [s.name, []]));

    // Presence: server keys.
    for (const key of serverKeys) {
        if (INTERNAL[key]) continue;
        if (!anywhere(key)) {
            report.note(
                'env',
                `${serverFile}:1`,
                `${key} is read by the server but documented nowhere`
            );
            continue;
        }
        const gaps = [];
        if (!conf.rows.has(key)) gaps.push(confRel);
        if (!contrib.server.has(key)) gaps.push(`${contribRel} (server table)`);
        if (!serverExample.vals.has(key)) gaps.push(serverExample.relPath);
        if (!dockerExample.vals.has(key)) gaps.push(dockerExample.relPath);
        if (!compose.present.has(key)) gaps.push('docker-compose.yml');
        for (const g of gaps)
            report.note('env', `${serverFile}:1`, `${key} missing from ${g}`);
        for (const s of curatedSurfaces) {
            const listed = (CURATED[s.name] || []).includes(key);
            if (!s.present.has(key) && listed)
                curatedAbsent.get(s.name).push(key);
            else if (!s.present.has(key))
                report.note(
                    'env',
                    `${s.name}:1`,
                    `${key} missing (not in CURATED; add it there if the omission is deliberate)`
                );
            else if (listed)
                report.note(
                    'env',
                    `${s.name}:1`,
                    `${key} is listed in CURATED as deliberately absent but is present; drop it from the list`
                );
        }
    }
    for (const s of curatedSurfaces) {
        const keys = curatedAbsent.get(s.name);
        if (keys.length)
            report.info(
                'env',
                `${s.name}:1`,
                `documents a curated subset; keys deliberately absent: ${keys.join(', ')}`
            );
    }
    // Presence: client keys.
    for (const key of client) {
        if (INTERNAL[key]) {
            report.info(
                'env',
                'client/:1',
                `${key}: ${INTERNAL[key]}; not expected in any operator surface`
            );
            continue;
        }
        if (!anywhere(key)) {
            report.note(
                'env',
                'client/:1',
                `${key} is read by the client but documented nowhere`
            );
            continue;
        }
        if (!contrib.client.has(key))
            report.note(
                'env',
                `${contribRel}:1`,
                `${key} missing from the client table`
            );
        if (!clientExample.vals.has(key))
            report.note('env', `${clientExample.relPath}:1`, `${key} missing`);
    }
    // Documented but not read.
    const documentedServer = new Map();
    for (const [k, row] of conf.rows)
        if (/^server/.test(row.service))
            documentedServer.set(k, [
                ...(documentedServer.get(k) || []),
                confRel,
            ]);
    for (const k of contrib.server.keys())
        documentedServer.set(k, [
            ...(documentedServer.get(k) || []),
            `${contribRel} (server table)`,
        ]);
    for (const k of serverExample.vals.keys())
        documentedServer.set(k, [
            ...(documentedServer.get(k) || []),
            serverExample.relPath,
        ]);
    for (const [k, places] of documentedServer) {
        if (server.keys.has(k)) continue;
        if (NOT_READ[k])
            report.info(
                'env',
                `${serverFile}:1`,
                `${k} is documented (${places.join(', ')}) but not read: ${NOT_READ[k]}`
            );
        else
            report.note(
                'env',
                `${serverFile}:1`,
                `${k} is documented in ${places.join(', ')} but no module in server/ reads it`
            );
    }
    for (const k of contrib.client.keys()) {
        if (!client.has(k))
            report.note(
                'env',
                `${contribRel}:${contrib.client.get(k).line}`,
                `${k} is in the client table but no client source reads it`
            );
    }
    for (const [k, v] of clientExample.vals) {
        if (!client.has(k))
            report.note(
                'env',
                `${clientExample.relPath}:${v.line}`,
                `${k} is in the example but no client source reads it`
            );
    }
    // Defaults: HARD where the docs make a claim about the server.
    for (const [key, row] of conf.rows) {
        if (
            BUILD_DEPENDENT[key] ||
            !/^server/.test(row.service) ||
            !server.keys.has(key)
        )
            continue;
        const code = server.keys.get(key);
        if (row.def !== null && code !== null && !sameValue(row.def, code)) {
            report.hardLine(
                'env',
                `${confRel}:${row.line}`,
                `${key} documented default ${row.def} but server/ defaults to ${code}`
            );
        }
    }
    for (const [key, row] of contrib.server) {
        if (BUILD_DEPENDENT[key] || !server.keys.has(key)) continue;
        const code = server.keys.get(key);
        if (row.def !== null && code !== null && !sameValue(row.def, code)) {
            report.hardLine(
                'env',
                `${contribRel}:${row.line}`,
                `${key} (default: ${row.def}) but server/ defaults to ${code}`
            );
        }
    }
    // Defaults: NOTE for the operator surfaces (they may legitimately differ):
    // server/.env.example (the value line and the comment above it),
    // .env.docker.example (same two), docker-compose.yml `:-` defaults and
    // the unraid templates.
    const soft = (key, value, where, kind, how = 'value') => {
        if (BUILD_DEPENDENT[key] || !server.keys.has(key)) return;
        const code = server.keys.get(key);
        const cmp = bytesOf(value) ?? value;
        if (code === null || value === '' || sameValue(cmp, code)) return;
        if (ALLOW[key]?.[kind] === value) return;
        const claim =
            how === 'comment'
                ? `${key}: the comment says default ${value}`
                : `${key}=${value} here`;
        report.note(
            'env',
            where,
            `${claim} but server/ defaults to ${code}`
        );
    };
    const softFile = (parsed, kind) => {
        for (const [k, v] of parsed.vals) {
            soft(k, v.value, `${parsed.relPath}:${v.line}`, kind);
            if (v.commentDefault !== null)
                soft(
                    k,
                    v.commentDefault,
                    `${parsed.relPath}:${v.commentLine}`,
                    kind,
                    'comment'
                );
        }
    };
    softFile(serverExample, 'server-example');
    softFile(dockerExample, 'docker');
    for (const [k, v] of compose.defaults)
        soft(k, v.value, `docker-compose.yml:${v.line}`, 'docker');
    for (const [k, v] of unraid.defaults) soft(k, v.value, v.where, 'unraid');
}

// ---------------------------------------------------------------------------
// dashes
// ---------------------------------------------------------------------------

function checkDashes(ctx) {
    const { root, report } = ctx;
    const files = [];
    files.push(
        ...walk(join(root, 'docs'), ['.mdx'], (p) =>
            /[\\/]docs[\\/]styles$/.test(p)
        )
    );
    if (existsSync(join(root, 'docs', 'docs.json')))
        files.push(join(root, 'docs', 'docs.json'));
    for (const name of readdirSync(root)) {
        if (name.endsWith('.md') && statSync(join(root, name)).isFile())
            files.push(join(root, name));
    }
    files.push(...walk(join(root, '.github'), ['.md']));
    // Markdown and reader-facing config outside the two places above. The rule
    // in CLAUDE.md covers every Markdown file, and this check only ever looked
    // at the root and docs/: .goreleaser.yml carried two em dashes for months
    // (its comments are the release runbook people read). desktop/build is
    // named because walk() skips any directory called build.
    files.push(...walk(join(root, 'unraid'), ['.md']));
    for (const f of [
        'desktop/README.md',
        'desktop/build/README.md',
        '.goreleaser.yml',
        'docs/style.css',
    ]) {
        if (existsSync(join(root, f))) files.push(join(root, f));
    }
    for (const file of files) {
        const text = read(file);
        const where = rel(root, file);
        for (const m of text.matchAll(/\u2014|\u2013/g)) {
            const line = lineOf(text, m.index);
            const lineStart = text.lastIndexOf('\n', m.index - 1) + 1;
            const col = m.index - lineStart + 1;
            const context = text
                .slice(Math.max(lineStart, m.index - 30), m.index + 30)
                .split('\n')[0];
            report.hardLine(
                'dashes',
                `${where}:${line}:${col}`,
                `"...${context}..."`
            );
        }
    }
}

// ---------------------------------------------------------------------------
// The report-only checks: readability, pagestandard, glossary, messages,
// captures
// ---------------------------------------------------------------------------

// Each of the five checks below measures something the docs have not been
// cleared of yet, so each prints NOTE lines and cannot fail a run. Each has
// one constant, named <CHECK>_HARD, at the top of its section: set it to true
// in the change that clears the docs of what the check reports, and every
// line it prints becomes HARD (the path `tables` took in #526).
//
// A check with hundreds of notes would bury the lines of every other check,
// and a script whose output nobody reads is the failure the header warns of.
// So in an `all` run each of these prints its first NOTE_CAP notes and one
// line saying how many it kept back; run alone, it prints them all. A note
// that is kept back is still counted in the closing total.
const NOTE_CAP = 15;

class Findings {
    constructor(ctx, check, hard) {
        Object.assign(this, { ctx, check, hard, count: 0 });
    }
    add(where, msg) {
        const { report, single } = this.ctx;
        this.count++;
        if (this.hard) report.hardLine(this.check, where, msg);
        else if (single || this.count <= NOTE_CAP)
            report.note(this.check, where, msg);
        else report.notes++;
    }
    // The lines of one file, in the order a reader meets them.
    addAll(file, found) {
        for (const f of found.sort((a, b) => a.line - b.line))
            this.add(`${file}:${f.line}`, f.msg);
    }
    end() {
        const kept = this.count - NOTE_CAP;
        if (this.hard || this.ctx.single || kept <= 0) return;
        this.ctx.report.info(
            this.check,
            'docs/',
            `${kept} more notes not shown: \`docs-check.mjs ${this.check}\` prints them all`
        );
    }
}

// The pages a person reads to use Floe, as against the ones an operator or a
// contributor looks things up in. `readability` and `glossary` list findings
// on these only.
const USER_PAGES = [
    /^(introduction|quickstart|choosing-floe|faq|troubleshooting|glossary|security-privacy)$/,
    /^(web-app|desktop|how-it-works)\//,
];
const isUserPage = (page) => USER_PAGES.some((re) => re.test(page));

// What stands in for an inline code span: one word, whatever the code holds,
// so `floe send a.bin --to <link>` is neither five words nor a sentence end.
const CODE_WORD = '\ue000';

// The index after the code span that opens with `run` backticks at `at`, or
// -1 when no run of the same length closes it before the paragraph ends.
function codeSpanEnd(text, at, run) {
    const stop = text.slice(at).search(/\n[ \t]*\n/);
    const body =
        stop < 0 ? text.slice(at + run) : text.slice(at + run, at + stop);
    for (const m of body.matchAll(/`+/g))
        if (m[0].length === run) return at + run + m.index + run;
    return -1;
}

// The text with every inline code span emptied, line for line. A span is read
// the way Markdown reads one, so a double-backtick span that shows a backtick
// is one span; `line.replace(/`[^`]*`/g, ...)` reads it as two and leaves the
// middle standing as prose.
function withoutCodeSpans(text) {
    let out = '';
    for (let i = 0; i < text.length; ) {
        const run = text[i] === '`' ? text.slice(i).match(/^`+/)[0].length : 0;
        const end = run ? codeSpanEnd(text, i, run) : -1;
        const step = text[i] === '\\' ? 2 : run || 1;
        out +=
            end < 0
                ? text.slice(i, i + step)
                : `\`\`${text.slice(i, end).replace(/[^\n]/g, '')}`;
        i = end < 0 ? i + step : end;
    }
    return out;
}

// The index after the `>` that closes the tag opening at `at`, or -1 when
// what follows is not a tag. Unlike jsxTagAt this one crosses lines (an <img>
// with one attribute per line) and does not judge the tag: prose only needs
// to know where it stops. A `>` inside a quoted value or an attribute's
// braces does not close it; a blank line or another `<` means it was text.
function tagEnd(text, at) {
    let quote = null;
    for (let i = at + 1; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '{') {
            const end = expressionEnd(text, i);
            if (end < 0) return -1;
            i = end - 1;
        } else if (c === '>') return i + 1;
        else if (
            c === '<' ||
            (c === '\n' && /^[ \t]*\n/.test(text.slice(i + 1)))
        )
            return -1;
    }
    return -1;
}

// A page as a reader sees it, line for line with the source: the frontmatter,
// fenced code, MDX comments and import lines are blank, a tag is gone and the
// text between its tags stays, an expression in braces is gone (the {#id} of
// a heading with it), a code span is one CODE_WORD, and a link is its label.
// Also returns every image's alt text with its line, which is not prose.
function proseOf(mdx) {
    const lines = stripFences(mdx).split('\n');
    const fmEnd = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
    for (let i = 0; i < lines.length; i++)
        if (i <= fmEnd || /^(import|export)\s/.test(lines[i])) lines[i] = '';
    const text = lines.join('\n');
    const images = [];
    const blank = (s) => s.replace(/[^\n]/g, ' ');
    let out = '';
    for (let i = 0; i < text.length; ) {
        const c = text[i];
        let end = -1;
        if (c === '\\' && ASCII_PUNCTUATION.test(text[i + 1] ?? '')) {
            out += text[i + 1];
            i += 2;
            continue;
        }
        if (c === '`') {
            const run = text.slice(i).match(/^`+/)[0].length;
            end = codeSpanEnd(text, i, run);
            if (end >= 0)
                out += CODE_WORD + text.slice(i, end).replace(/[^\n]/g, '');
        } else if (c === '{') {
            end = expressionEnd(text, i);
            if (end >= 0) out += blank(text.slice(i, end));
        } else if (c === '<' && /[A-Za-z/>]/.test(text[i + 1] ?? '')) {
            end = tagEnd(text, i);
            if (end >= 0) {
                const tag = text.slice(i, end);
                const alt =
                    /^<img\b/.test(tag) &&
                    tag.match(/\balt=(?:"([^"]*)"|'([^']*)')/);
                if (alt)
                    images.push({
                        line: lineOf(text, i),
                        alt: alt[1] ?? alt[2],
                    });
                out += blank(tag);
            }
        }
        if (end >= 0) i = end;
        else out += text[i++];
    }
    out = out.replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, (m, alt, at) => {
        images.push({ line: lineOf(out, at), alt });
        return blank(m);
    });
    out = out.replace(/\[([^\]]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, '$1');
    return { text: out, images: images.sort((a, b) => a.line - b.line) };
}

// A word is anything between white space that holds a letter, a digit or a
// code span, so a bullet, a pipe or a lone hyphen is not one.
function wordCount(text) {
    return (text.match(/\S+/g) || []).filter((w) =>
        /[\p{L}\p{N}\ue000]/u.test(w)
    ).length;
}

// What a full stop may follow without ending a sentence, and what it may
// follow that ends one only before a capital.
const ABBREVIATION = /(?:^|[^A-Za-z])(?:e\.g|i\.e|vs|cf|approx)$/;
const ETC = /(?:^|[^A-Za-z])etc$/;

/**
 * The sentences of one block of prose, as { text, offset }. A sentence ends
 * at `.`, `!` or `?` (and any closing quote, bracket or emphasis mark, so a
 * bold run-in sentence is one of its own) followed by white
 * space or the end. The full stops inside 1.11.0, a.bin and 2.5 are followed
 * by neither, so they end nothing; nor does an abbreviation, an ellipsis
 * (it trails off), or a quotation that closes in mid-sentence ('says
 * "Connection lost." and stops'). Whether the next word has a capital is not
 * asked: in these docs a sentence often starts with `floe` or `nginx`.
 */
export function splitSentences(text) {
    const out = [];
    let start = 0;
    for (const m of text.matchAll(
        /([.!?]+)(["'\u201d\u2019)\]*_]*)(?=\s|$)/g
    )) {
        const [whole, marks, closers] = m;
        const before = text.slice(start, m.index);
        const next = text.slice(m.index + whole.length).trimStart()[0] ?? '';
        const goesOn = /[a-z]/.test(next);
        if (/^\.{2,}$/.test(marks) || before.endsWith('\u2026')) continue;
        if (
            marks === '.' &&
            (ABBREVIATION.test(before) || (ETC.test(before) && goesOn))
        )
            continue;
        if (/["'\u201d\u2019]/.test(closers) && goesOn) continue;
        out.push({
            text: text.slice(start, m.index + whole.length),
            offset: start,
        });
        start = m.index + whole.length;
    }
    if (/\S/.test(text.slice(start)))
        out.push({ text: text.slice(start), offset: start });
    return out;
}

// ---------------------------------------------------------------------------
// readability
// ---------------------------------------------------------------------------

const READABILITY_HARD = false;
const SENTENCE_MAX_WORDS = 35;
const CELL_MAX_WORDS = 40;
const ALT_MIN_CHARS = 40;
const ALT_MAX_CHARS = 150;
// A page longer than this, in words of prose, opens with a summary under an
// H2 of this name, which has to be one of the first SHORT_VERSION_WITHIN.
const LONG_PAGE_WORDS = 1200;
const SHORT_VERSION = 'The short version';
const SHORT_VERSION_WITHIN = 3;

// Every finding on one page, with the page's word count. A paragraph is one
// block and so is each list item (an item with no full stop is a sentence of
// its own, never joined to the next); a table row is no sentence, and its
// cells are measured one by one. Headings are not prose and are not counted.
function measureProse(mdx) {
    const { text, images } = proseOf(mdx);
    const lines = text.split('\n');
    const found = [];
    const h2 = [];
    let words = 0;

    const inTable = new Set();
    for (const t of tablesIn(text)) {
        inTable.add(t.headerLine).add(t.headerLine + 1);
        for (const row of [
            { cells: t.header, line: t.headerLine },
            ...t.rows,
        ]) {
            inTable.add(row.line);
            for (const cell of row.cells) {
                const n = wordCount(cell);
                words += n;
                if (n > CELL_MAX_WORDS)
                    found.push({
                        kind: 'cell',
                        line: row.line,
                        msg: `a table cell of ${n} words (the limit is ${CELL_MAX_WORDS})`,
                    });
            }
        }
    }

    const blocks = [];
    let open = null;
    const close = () => {
        if (open) blocks.push(open);
        open = null;
    };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/^\s*>\s?/, '');
        const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
        const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
        if (inTable.has(i + 1) || line.trim() === '') close();
        else if (heading) {
            close();
            if (heading[1].length === 2) h2.push(heading[2].trim());
        } else if (item) {
            close();
            open = { line: i + 1, text: item[1] };
        } else if (open) open.text += `\n${line}`;
        else open = { line: i + 1, text: line };
    }
    close();
    for (const block of blocks)
        for (const s of splitSentences(block.text)) {
            const n = wordCount(s.text);
            words += n;
            if (n <= SENTENCE_MAX_WORDS) continue;
            const lead = s.offset + s.text.search(/\S/);
            found.push({
                kind: 'sentence',
                line:
                    block.line +
                    block.text.slice(0, lead).split('\n').length -
                    1,
                msg: `a sentence of ${n} words (the limit is ${SENTENCE_MAX_WORDS})`,
            });
        }

    for (const { line, alt } of images) {
        const n = alt.trim().length;
        if (n < ALT_MIN_CHARS || n > ALT_MAX_CHARS)
            found.push({
                kind: 'alt',
                line,
                msg: `image alt text is ${n} characters (the range is ${ALT_MIN_CHARS} to ${ALT_MAX_CHARS})`,
            });
        if (!alt.trim().endsWith('.'))
            found.push({
                kind: 'alt',
                line,
                msg: 'image alt text does not end in a period',
            });
    }

    const summarized = h2
        .slice(0, SHORT_VERSION_WITHIN)
        .some((h) => h.toLowerCase() === SHORT_VERSION.toLowerCase());
    if (words > LONG_PAGE_WORDS && !summarized)
        found.push({
            kind: 'long',
            line: 1,
            msg: `${words} words of prose and no "${SHORT_VERSION}" among the first three H2 headings`,
        });
    return { found, words };
}

function checkReadability(ctx) {
    const findings = new Findings(ctx, 'readability', READABILITY_HARD);
    const count = (found, kind) => found.filter((f) => f.kind === kind).length;
    const user = { pages: 0, sentence: 0, cell: 0, alt: 0, long: 0 };
    const other = { pages: 0, sentence: 0, cell: 0 };
    for (const [page, rec] of ctx.pages) {
        const { found } = measureProse(rec.text);
        const tally = isUserPage(page) ? user : other;
        tally.pages++;
        for (const kind of Object.keys(tally))
            if (kind !== 'pages') tally[kind] += count(found, kind);
        if (tally === user) findings.addAll(rel(ctx.root, rec.file), found);
    }
    findings.end();
    ctx.report.info(
        'readability',
        'docs/',
        `${user.pages} user pages: ${user.sentence} sentences over ${SENTENCE_MAX_WORDS} words, ${user.cell} table cells over ${CELL_MAX_WORDS} words, ${user.alt} image alt text findings, ${user.long} long pages with no "${SHORT_VERSION}"`
    );
    ctx.report.info(
        'readability',
        'docs/',
        `${other.pages} other pages (cli/, self-hosting/, reference/, the changelog, snippets) are not listed: ${other.sentence} sentences over ${SENTENCE_MAX_WORDS} words, ${other.cell} table cells over ${CELL_MAX_WORDS} words`
    );
}

// ---------------------------------------------------------------------------
// pagestandard
// ---------------------------------------------------------------------------

// The page standard the docs were rewritten to in #518 to #522, as far as a
// script can decide it. What needs a reader is not here: whether a page opens
// by saying what the reader will have done, whether a callout is the right
// one of the two, whether a fact is stated on the page that owns it.
const PAGESTANDARD_HARD = false;
// The changelog describes each release in the words of its day.
const STANDARD_EXEMPT = ['changelog'];
// Pages that only quote the apps. The message index is generated: its words
// are the apps' own ("host name" is what Floe Desktop says), and its tables
// are headed Message and Explained at, so the wording rules and the
// message-table rule do not apply to it.
const QUOTING_PAGES = [INDEX_PAGE];
const REQUIRED_KEYS = ['title', 'sidebarTitle', 'description', 'keywords'];
const BANNED_KEYS = ['icon', 'tag'];
const DESCRIPTION_MAX = 160;
// Two callouts exist in these docs. The render probe of 2026-10-11 showed
// <Note> blue and <Tip> green against a neutral design.
const CALLOUTS_USED = ['Warning', 'Info'];
const CALLOUTS_NOT_USED = ['Note', 'Tip', 'Check', 'Danger', 'Callout'];
const COMPONENTS_NOT_USED = [
    'Accordion',
    'AccordionGroup',
    'Tooltip',
    'Badge',
    'Expandable',
];
const MESSAGE_TABLE =
    /^\|\s*Message\s*\|\s*What it means\s*\|\s*What to do\s*\|\s*$/;
// Lower-case tags a page may carry. Any other `<word>` outside code is a tag
// MDX cannot close (a placeholder typed raw), and the page stops compiling.
const HTML_USED = new Set(
    'img span br a div p kbd code sub sup strong em b i table thead tbody tr td th ul ol li details summary hr pre'.split(
        ' '
    )
);
const WORDS = [
    [/\bafterwards\b/i, '"afterwards" (use "afterward")'],
    [/\be\.g\./, '"e.g." (use "for example")'],
    [/\bi\.e\./, '"i.e." (use "that is")'],
    [/\bhost name\b/i, '"host name" (use "hostname")'],
    [/\bNginx\b(?! Proxy Manager)/, '"Nginx" (use "nginx")'],
    [
        /\b(?:from|before|in) this release\b/i,
        '"this release" (name the version)',
    ],
    [
        /\b(?:two|three|four|five|six|ten|twenty|thirty|forty|sixty|ninety)[ -](?:second|minute|hour|day)s?\b/i,
        'a spelled-out number with a unit (use a numeral)',
    ],
    [
        /\b(?:behaviour|cancelled|cancelling|colour|centre)\b/i,
        'British spelling',
    ],
];

function pageStandardFindings(page, rec) {
    const found = [];
    const note = (line, msg) => found.push({ line, msg });
    const snippet = NAV_EXEMPT.some((re) => re.test(page));
    const raw = rec.text.split('\n');
    const fmEnd = raw[0] === '---' ? raw.indexOf('---', 1) : -1;

    if (!snippet) {
        const keys = new Map();
        for (let i = 1; i < fmEnd; i++) {
            const m = raw[i].match(/^([A-Za-z]+):/);
            if (m && !keys.has(m[1])) keys.set(m[1], i + 1);
        }
        for (const key of REQUIRED_KEYS)
            if (!keys.has(key)) note(1, `frontmatter: no ${key}`);
        for (const key of BANNED_KEYS)
            if (keys.has(key))
                note(
                    keys.get(key),
                    `frontmatter: ${key} is not used in these docs`
                );
        const length = (rec.fm.description || '').length;
        if (length > DESCRIPTION_MAX)
            note(
                keys.get('description'),
                `frontmatter: the description is ${length} characters (the limit is ${DESCRIPTION_MAX})`
            );

        let first = fmEnd + 1;
        while (
            first < raw.length &&
            (raw[first].trim() === '' || /^import\s/.test(raw[first]))
        )
            first++;
        if (/^#{1,6}\s/.test(raw[first] ?? ''))
            note(first + 1, 'opening: the page starts on a heading');
        else if (/^\|/.test(raw[first] ?? ''))
            note(first + 1, 'opening: the page starts on a table');
    }

    // Fences are read from the source, since what opens one is what is judged.
    let fence = null;
    for (let i = fmEnd + 1; i < raw.length; i++) {
        const m = raw[i].match(/^\s*(`{3,}|~{3,})(.*)$/);
        if (!m) continue;
        if (fence === null) {
            fence = { mark: m[1][0], length: m[1].length };
            const info = m[2].trim();
            if (info === '') note(i + 1, 'fence: a code fence has no language');
            else if (/^mermaid\b/.test(info))
                note(i + 1, 'diagram: these docs carry no diagrams');
        } else if (
            m[1][0] === fence.mark &&
            m[1].length >= fence.length &&
            m[2].trim() === ''
        )
            fence = null;
    }

    const lines = withoutCodeSpans(stripFences(rec.text)).split('\n');
    const quoting = QUOTING_PAGES.includes(page);
    let heading = null;
    let callouts = 0;
    let lastCalloutClose = -10;
    const emptySection = (until) => {
        if (
            heading &&
            !raw.slice(heading.at + 1, until).some((l) => l.trim() !== '')
        )
            note(heading.at + 1, 'section: a heading with nothing under it');
    };
    for (let i = fmEnd + 1; i < lines.length; i++) {
        const line = lines[i];
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) {
            if (snippet)
                note(i + 1, 'snippet: a snippet must not contain a heading');
            // A heading followed at once by a deeper one is a parent with its
            // first child, not an empty section.
            if (heading && h[1].length <= heading.level) emptySection(i);
            heading = { at: i, level: h[1].length };
            if (h[1].length <= 2) callouts = 0;
            if (
                page === 'troubleshooting' &&
                h[1].length === 3 &&
                !/\{#[^}]+\}\s*$/.test(h[2])
            )
                note(i + 1, 'id: a troubleshooting H3 has no explicit {#id}');
            continue;
        }
        for (const m of line.matchAll(/<([A-Za-z][A-Za-z0-9-]*)[\s>/]/g)) {
            const name = m[1];
            if (COMPONENTS_NOT_USED.includes(name))
                note(i + 1, `component: <${name}> is not used in these docs`);
            else if (CALLOUTS_NOT_USED.includes(name))
                note(
                    i + 1,
                    `callout: <${name}> is not used in these docs, only <Warning> and <Info>`
                );
            else if (CALLOUTS_USED.includes(name)) {
                if (++callouts > 1)
                    note(i + 1, 'callout: more than one callout under one H2');
                if (i - lastCalloutClose <= 2)
                    note(i + 1, 'callout: two callouts in a row');
            } else if (/^[a-z]/.test(name) && !HTML_USED.has(name))
                note(
                    i + 1,
                    `tag: a raw <${name}> outside code is a tag MDX cannot close; put it in backticks`
                );
        }
        if (/<\/(Warning|Info)>/.test(line)) lastCalloutClose = i;
        if (snippet && /\]\(#/.test(line))
            note(i + 1, 'snippet: a snippet must not contain a #fragment link');
        if (quoting) continue;
        for (const [re, what] of WORDS)
            if (re.test(line)) note(i + 1, `words: ${what}`);
        if (/^\|\s*Message\s*\|/.test(line) && !MESSAGE_TABLE.test(line))
            note(
                i + 1,
                'table: a message table is headed "Message | What it means | What to do"'
            );
    }
    emptySection(raw.length);
    return found;
}

function checkPageStandard(ctx) {
    const findings = new Findings(ctx, 'pagestandard', PAGESTANDARD_HARD);
    // Every message starts with its kind ("callout: ..."), which is what the
    // closing line counts by.
    const kinds = new Map();
    let pages = 0;
    for (const [page, rec] of ctx.pages) {
        if (STANDARD_EXEMPT.includes(page)) continue;
        pages++;
        const found = pageStandardFindings(page, rec);
        for (const { msg } of found) {
            const kind = msg.split(':')[0];
            kinds.set(kind, (kinds.get(kind) || 0) + 1);
        }
        findings.addAll(rel(ctx.root, rec.file), found);
    }
    findings.end();
    const byKind = [...kinds].map(([kind, n]) => `${kind} ${n}`).join(', ');
    ctx.report.info(
        'pagestandard',
        'docs/',
        `${pages} pages: ${findings.count} findings${byKind ? ` (${byKind})` : ''}`
    );
}

// ---------------------------------------------------------------------------
// glossary
// ---------------------------------------------------------------------------

const GLOSSARY_HARD = false;
const GLOSSARY_PAGE = 'glossary';

// One everyday word is a term too, and a script cannot tell the two apart:
// "drop" is what one sending through a request link is called, and it is
// also what a person does with files on the drop area. A name listed here is
// left to the writer and the reviewer, and the check says so in one line.
const GLOSSARY_LEFT_TO_THE_WRITER = ['drop'];

// A term is an H3 of the glossary. The H2s are the page's groups ("Words you
// see in Floe"), not terms. One heading may give several spellings of a
// term, separated by " / "; they share the heading's id.
function glossaryTerms(rec) {
    const terms = [];
    const lines = stripFences(rec.text).split('\n');
    const fmEnd = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
    for (const line of lines.slice(fmEnd + 1)) {
        const h = line.match(/^###\s+(.*)$/);
        if (!h) continue;
        const explicit = h[1].match(/^(.*?)\s*\{#([^}]+)\}\s*$/);
        const text = (explicit ? explicit[1] : h[1]).trim();
        const names = text
            .split(' / ')
            .map((n) => n.trim())
            .filter(Boolean)
            .filter((n) => !GLOSSARY_LEFT_TO_THE_WRITER.includes(n));
        terms.push({ id: explicit ? explicit[2] : slug(text), names });
    }
    return terms;
}

function checkGlossary(ctx) {
    const glossary = ctx.pages.get(GLOSSARY_PAGE);
    if (!glossary) {
        ctx.report.info(
            'glossary',
            `docs/${GLOSSARY_PAGE}.mdx`,
            'the page does not exist, so there is nothing to check'
        );
        return;
    }
    const findings = new Findings(ctx, 'glossary', GLOSSARY_HARD);
    const terms = glossaryTerms(glossary);
    for (const [page, rec] of ctx.pages) {
        if (page === GLOSSARY_PAGE || !isUserPage(page)) continue;
        const source = stripFences(rec.text);
        // Headings are not prose: a term in a heading needs no link.
        const prose = proseOf(rec.text)
            .text.split('\n')
            .map((l) => (/^\s{0,3}#{1,6}\s/.test(l) ? '' : l))
            .join('\n');
        const found = [];
        for (const term of terms) {
            const target = `/${GLOSSARY_PAGE}#${term.id}`;
            if (
                source.includes(`(${target})`) ||
                source.includes(`"${target}"`)
            )
                continue;
            // The spelling that comes first on the page, the longer one on a
            // tie ("TURN relay" before the "relay" inside it).
            let first = null;
            for (const name of term.names) {
                const words = name
                    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                    .replace(/\s+/g, '\\s+');
                // A name the glossary writes with a capital is matched as
                // written: "PATH" is the list of folders a terminal
                // searches, and "a file's path" is not that. A name in
                // lower case is matched in any case, because it can start a
                // sentence.
                const m = prose.match(
                    new RegExp(
                        `(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`,
                        /\p{Lu}/u.test(name) ? 'u' : 'iu'
                    )
                );
                if (m && (first === null || m.index < first.at))
                    first = { at: m.index, name };
            }
            if (first)
                found.push({
                    line: lineOf(prose, first.at),
                    msg: `"${first.name}" is used and the page has no link to ${target}`,
                });
        }
        findings.addAll(rel(ctx.root, rec.file), found);
    }
    findings.end();
    ctx.report.info(
        'glossary',
        `docs/${GLOSSARY_PAGE}.mdx`,
        `${terms.length} terms: ${findings.count} uses on a user page with no link to the entry`
    );
    ctx.report.info(
        'glossary',
        `docs/${GLOSSARY_PAGE}.mdx`,
        `not checked, because a script cannot tell the term from the everyday word: ${GLOSSARY_LEFT_TO_THE_WRITER.join(', ')}`
    );
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

// references/messages.json is one row per message Floe can show: its surface,
// its text, the file that types it and the docs heading that explains it. The
// check holds each row to all three, and docs/messages.mdx to the rows.
//
// Which tree a row's text is looked up in depends on its surface. The docs
// describe the RELEASED CLI and desktop app, and main runs ahead of both
// between releases, so those rows are held to references/released-strings.json
// (written by released-strings.mjs from the two release tags) and never to
// the working tree. The web app and the server have no such gap, and neither
// has a cli row typed in a file floe.one serves (`heldToRelease` says which).
const MESSAGES_HARD = false;

// A source file as message-match.mjs searches it, or null when the path is
// not a file under the root. An environment file is never opened: server/.env
// holds live credentials, and a row or a manifest must not be able to name it.
function sourceHay(ctx, path) {
    ctx.hays ??= new Map();
    if (!ctx.hays.has(path)) {
        const name = basename(path);
        const secret = /^\.env(\.|$)/.test(name) && !name.endsWith('.example');
        const file = resolve(ctx.root, path);
        const inside =
            !relative(ctx.root, file).startsWith('..') && file !== ctx.root;
        let hay = null;
        if (!secret && inside && existsSync(file) && statSync(file).isFile())
            hay = haystack(read(file));
        ctx.hays.set(path, hay);
    }
    return ctx.hays.get(path);
}

// The snapshot of the released apps, or null when there is none to read.
function releasedStrings(ctx) {
    if (ctx.released === undefined) {
        ctx.released = null;
        try {
            ctx.released = JSON.parse(read(join(ctx.root, RELEASED_FILE)));
        } catch {
            // No file, or not JSON: both mean nothing can be held to it.
        }
    }
    return ctx.released;
}

function checkMessages(ctx) {
    const file = join(ctx.root, MESSAGES_FILE);
    if (!existsSync(file)) {
        ctx.report.info(
            'messages',
            MESSAGES_FILE,
            'no messages.json in this tree, so there is nothing to check'
        );
        return;
    }
    const findings = new Findings(ctx, 'messages', MESSAGES_HARD);
    let rows;
    try {
        rows = JSON.parse(read(file));
        if (!Array.isArray(rows)) throw new Error('not an array of rows');
    } catch (e) {
        findings.add(MESSAGES_FILE, `cannot read the rows: ${e.message}`);
        return;
    }
    const released = releasedStrings(ctx);
    if (!released && rows.some(heldToRelease))
        findings.add(
            RELEASED_FILE,
            'no released-strings.json to read, so no cli or desktop row can be checked; released-strings.mjs writes it'
        );
    let homeless = 0;
    for (const row of rows) {
        const said = `\u201c${String(row.text).replace(/\s+/g, ' ')}\u201d`;
        if (!MESSAGE_SURFACES.includes(row.surface))
            findings.add(
                MESSAGES_FILE,
                `${said}: unknown surface "${row.surface}"`
            );
        else if (heldToRelease(row)) {
            if (
                released &&
                !released[row.surface]?.[row.source]?.includes(row.text)
            )
                findings.add(
                    row.source,
                    `${said} is not in the snapshot of ${released.refs?.[row.surface]}`
                );
        } else {
            const hay = sourceHay(ctx, String(row.source));
            if (!hay)
                findings.add(
                    String(row.source),
                    `${said} (${row.surface}): no such file`
                );
            else if (!textOccurs(row.text, hay))
                findings.add(row.source, `${said} is no longer in this file`);
        }

        if (row.anchor === null || row.anchor === undefined) {
            if (!row.why_no_home) homeless++;
            continue;
        }
        const [path, id] = String(row.anchor).split('#');
        const target = resolveDocsPath(ctx, path);
        if (
            target.kind !== 'page' ||
            (id !== undefined && !target.rec.headings.ids.has(id))
        )
            findings.add(
                MESSAGES_FILE,
                `${said}: the anchor ${row.anchor} does not exist`
            );
    }
    // One line, not one per row: several hundred messages had no docs home
    // on the day the file was seeded.
    if (homeless)
        findings.add(
            MESSAGES_FILE,
            `${homeless} of ${rows.length} rows have no docs anchor and no why_no_home`
        );

    const index = ctx.pages.get(INDEX_PAGE);
    if (index) {
        const want = renderIndex(rows, (anchor) =>
            anchorLabel(ctx.pages, anchor)
        ).split('\n');
        const have = index.text.split('\n');
        const at = want.findIndex((line, i) => line !== have[i]);
        const differs =
            at >= 0 ? at : have.length > want.length ? want.length : -1;
        if (differs >= 0)
            findings.add(
                `docs/${INDEX_PAGE}.mdx:${differs + 1}`,
                'differs from what messages-index.mjs prints from messages.json; run it with --write, never edit the page by hand'
            );
    }
    findings.end();
    const held = rows.filter(heldToRelease).length;
    ctx.report.info(
        'messages',
        MESSAGES_FILE,
        `${rows.length} rows: ${rows.length - held} read from the working tree, ${held} held to the release snapshot, ${homeless} with no docs anchor and no reason`
    );
}

// ---------------------------------------------------------------------------
// captures
// ---------------------------------------------------------------------------

// Each docs/images/<dir>/capture-manifest.json lists the pictures in its
// directory under `shots`. A shot may record what can be read in the picture:
// `strings`, the UI texts visible in it (with {placeholders} where the app
// fills something in), and `sources`, the repo-relative files that type them.
// A string that has left all of its sources is a picture that no longer shows
// the app. A picture of a released app (the directory is named for the
// surface) is held to the snapshot, like a row of messages.json.
const CAPTURES_HARD = false;

function checkCaptures(ctx) {
    const findings = new Findings(ctx, 'captures', CAPTURES_HARD);
    const images = join(ctx.docsDir, 'images');
    const seen = { manifests: 0, shots: 0, recorded: 0 };
    for (const dir of existsSync(images) ? readdirSync(images).sort() : []) {
        const file = join(images, dir, 'capture-manifest.json');
        if (!existsSync(file)) continue;
        seen.manifests++;
        const where = rel(ctx.root, file);
        let shots;
        try {
            shots = JSON.parse(read(file)).shots;
            if (!Array.isArray(shots)) throw new Error('no shots array');
        } catch (e) {
            findings.add(where, `cannot read the shots: ${e.message}`);
            continue;
        }
        const released = RELEASED_SURFACES.includes(dir)
            ? releasedStrings(ctx)
            : undefined;
        const bare = [];
        let unheld = false;
        for (const shot of shots) {
            const strings = Array.isArray(shot.strings) ? shot.strings : [];
            const sources = Array.isArray(shot.sources) ? shot.sources : [];
            if (!strings.length) bare.push(shot.name);
            else if (!sources.length)
                findings.add(
                    where,
                    `${shot.name}: strings are recorded with no sources to hold them to`
                );
            else if (released === null) unheld = true;
            else
                for (const string of strings) {
                    const said = `${shot.name}: \u201c${string}\u201d`;
                    if (released) {
                        if (
                            !sources.some((p) =>
                                released[dir]?.[p]?.includes(string)
                            )
                        )
                            findings.add(
                                where,
                                `${said} is not in the snapshot of ${released.refs?.[dir]} for ${sources.join(', ')}`
                            );
                    } else if (
                        !sources.some(
                            (p) =>
                                sourceHay(ctx, p) &&
                                textOccurs(string, sourceHay(ctx, p))
                        )
                    )
                        findings.add(
                            where,
                            `${said} is in none of ${sources.join(', ')}`
                        );
                }
        }
        if (unheld)
            findings.add(
                where,
                'no released-strings.json to read, so the strings of these shots cannot be checked'
            );
        if (bare.length)
            findings.add(
                where,
                `${bare.length} of ${shots.length} shots record no strings: ${bare.join(', ')}`
            );
        seen.shots += shots.length;
        seen.recorded += shots.length - bare.length;
    }
    findings.end();
    ctx.report.info(
        'captures',
        'docs/images/',
        `${seen.shots} shots in ${seen.manifests} manifests: ${seen.recorded} with strings recorded`
    );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function usage() {
    console.error(
        `usage: node docs-check.mjs [all|${CHECKS.join('|')}] [--root <dir>]`
    );
    process.exit(2);
}

export function run(args) {
    let root = resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        '..'
    );
    let which = 'all';
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--root') {
            root = resolve(args[++i] || '');
        } else if (args[i] === 'all' || CHECKS.includes(args[i])) {
            which = args[i];
        } else {
            usage();
        }
    }
    if (!existsSync(join(root, 'docs', 'docs.json'))) {
        console.error(
            `docs-check: ${root} has no docs/docs.json; pass --root <repo>`
        );
        process.exit(2);
    }
    const report = new Report();
    const ctx = buildContext(root, report);
    ctx.single = which !== 'all';
    const table = {
        links: checkLinks,
        nav: checkNav,
        frontmatter: checkFrontmatter,
        headings: checkHeadings,
        labels: checkLabels,
        tables: checkTables,
        env: checkEnv,
        dashes: checkDashes,
        readability: checkReadability,
        pagestandard: checkPageStandard,
        glossary: checkGlossary,
        messages: checkMessages,
        captures: checkCaptures,
    };
    for (const name of which === 'all' ? CHECKS : [which]) table[name](ctx);
    console.log(`docs-check: ${report.hard} hard, ${report.notes} notes`);
    process.exit(report.hard ? 1 : 0);
}

// Both sides through realpath: node keeps a symlink in argv[1] and resolves it
// in import.meta.url, so from a checkout under a symlinked directory (or a
// Windows junction) the two differed, nothing ran, and the exit was 0.
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
if (invokedDirectly) run(process.argv.slice(2));
