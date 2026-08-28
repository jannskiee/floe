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
 * Usage:
 *   node docs-check.mjs [all|links|nav|frontmatter|labels|env|dashes] [--root <dir>]
 * Tests:
 *   node --test .claude/skills/docs-verify/scripts/docs-check.test.mjs
 * Output lines: `HARD  <check>  <file>:<line>  <message>` and the same with
 * NOTE or info, then `docs-check: N hard, M notes`. Exit 0 no HARD, 1 any
 * HARD, 2 usage or unreadable root.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKS = ['links', 'nav', 'frontmatter', 'labels', 'env', 'dashes'];
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
    'cli',
    'desktop',
    'server/server.js',
    'server/.env.example',
    '.env.docker.example',
    'docker-compose.yml',
    'unraid',
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
// Env keys read by code that are set by a build file, not by an operator.
const INTERNAL = { FLOE_DISTRIBUTABLE_IMAGE: 'set by client/Dockerfile only' };
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
// correct default there even though server.js defaults to 1.
const ALLOW = { TRUSTED_PROXY_COUNT: { docker: '0', unraid: '0' } };
// Surfaces that document a deliberate subset of the server keys. Each list is
// printed once as an info line; a missing key NOT listed here is a NOTE, and a
// listed key that turns up present is a NOTE too, so the lists stay honest.
const CURATED = {
    'SELF_HOSTING.md': [
        'MAX_CONNECTIONS_PER_IP',
        'MAX_TURN_REQUESTS_PER_IP',
        'MAX_CODE_REQUESTS_PER_IP',
        'MAX_ACTIVE_CODES',
        'MAX_REPORT_BYTES',
        'UPSTASH_REDIS_REST_URL',
        'UPSTASH_REDIS_REST_TOKEN',
    ],
    'unraid/floe-server.xml': [
        'PORT',
        'MAX_TURN_REQUESTS_PER_IP',
        'MAX_CODE_REQUESTS_PER_IP',
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
// server.js reads exactly 14 keys today. Fewer means the extractor regex broke,
// not that the server lost a setting; raise this when a key is added.
const SERVER_KEY_FLOOR = 14;

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
    let inFence = false;
    const noFences = lines
        .map((line) => {
            if (/^\s*```/.test(line)) {
                inFence = !inFence;
                return '';
            }
            return inFence ? '' : line;
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
    const pages = new Map();
    for (const file of mdxFiles) {
        const text = read(file);
        const page = rel(docsDir, file).replace(/\.mdx$/, '');
        pages.set(page, {
            file,
            text,
            fm: frontmatter(text),
            headings: headingSlugs(text),
        });
    }
    return { root, report, docsDir, docsJson, nav, mdxFiles, pages };
}

// Resolve a docs path (leading slash, no anchor) to a page record, a static
// asset, a directory URL, or nothing.
function resolveDocsPath(ctx, path) {
    const clean = path.replace(/\/+$/, '');
    if (clean === '' || clean === '/') return { kind: 'root' };
    const page = clean.slice(1);
    if (/\.[a-z0-9]+$/i.test(page)) {
        return existsSync(join(ctx.docsDir, page))
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
            checkTarget(
                ctx,
                `${where}:${lineOf(text, m.index)}`,
                m[1] || '/',
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
    const file = join(root, 'server', 'server.js');
    const keys = new Map();
    if (!existsSync(file)) return { keys, file };
    for (const line of read(file).split('\n')) {
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

function parseConfigurationMdx(root) {
    const file = join(root, 'docs', 'self-hosting', 'configuration.mdx');
    const rows = new Map();
    if (!existsSync(file)) return { rows, file };
    const text = read(file);
    let n = 0;
    for (const line of text.split('\n')) {
        n++;
        const m = line.match(
            /^\|\s*`([A-Z_][A-Z0-9_]*)`\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|/
        );
        if (!m) continue;
        const cell = m[4].trim();
        const tok = cell.match(/`([^`]*)`/);
        const def = /_\(none\)_/.test(cell) ? null : tok ? tok[1] : null;
        rows.set(m[1], { service: m[2].trim(), def, line: n });
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
        // default ("(default: 30)", "1 (default)", "(default: 5 TB)") and
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
                    /\bdefault:?\s+`?(\d[\w.]*(?:\s*(?:KB|MB|GB|TB))?)`?/i
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

// "5 TB" in a comment is the same claim as 5497558138880 in code.
function bytesOf(value) {
    const m = String(value).match(/^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)$/i);
    if (!m) return null;
    return String(
        Number(m[1]) *
            1024 ** { KB: 1, MB: 2, GB: 3, TB: 4 }[m[2].toUpperCase()]
    );
}

function parseCompose(root) {
    const file = join(root, 'docker-compose.yml');
    const present = new Set();
    const defaults = new Map();
    if (!existsSync(file)) return { present, defaults, file };
    let n = 0;
    for (const line of read(file).split('\n')) {
        n++;
        if (/^\s*#/.test(line)) continue;
        for (const m of line.matchAll(
            /\$\{([A-Z_][A-Z0-9_]*)(:-|-)([^}]*)\}/g
        )) {
            present.add(m[1]);
            if (m[2] === ':-' && m[3] !== '' && !defaults.has(m[1]))
                defaults.set(m[1], { value: m[3], line: n });
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
                `${k} is documented in ${places.join(', ')} but server/server.js never reads it`
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
                `${key} documented default ${row.def} but server/server.js defaults to ${code}`
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
                `${key} (default: ${row.def}) but server/server.js defaults to ${code}`
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
            `${claim} but server/server.js defaults to ${code}`
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
    const table = {
        links: checkLinks,
        nav: checkNav,
        frontmatter: checkFrontmatter,
        labels: checkLabels,
        env: checkEnv,
        dashes: checkDashes,
    };
    for (const name of which === 'all' ? CHECKS : [which]) table[name](ctx);
    console.log(`docs-check: ${report.hard} hard, ${report.notes} notes`);
    process.exit(report.hard ? 1 : 0);
}

const invokedDirectly =
    process.argv[1] &&
    resolve(process.argv[1]).toLowerCase() ===
        fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) run(process.argv.slice(2));
