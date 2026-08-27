/**
 * Fixture tests for docs-check.mjs.
 *
 * Each test copies the script's declared SURFACES into a fresh temp directory,
 * injects one defect, and runs the script as a child process with --root, so
 * the assertion is on the exit code and the printed line a reviewer would see,
 * not on an internal function. The baseline test proves the untouched copy
 * exits 0; without it a fixture that "fails" could be failing for a reason
 * unrelated to its injected defect.
 *
 * Run: node --test .claude/skills/docs-verify/scripts/docs-check.test.mjs
 * (a directory argument fails on Node 22; positional arguments are files or
 * globs).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    cpSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { SURFACES, headingSlugs, slug } from './docs-check.mjs';

const SCRIPT = fileURLToPath(import.meta.url).replace(/\.test\.mjs$/, '.mjs');
const REPO = resolve(dirname(SCRIPT), '..', '..', '..', '..');
const SKIP = new Set(['node_modules', '.next', 'dist', 'build', '.git']);
const EM_DASH = String.fromCharCode(0x2014);
const made = [];

function fresh() {
    const tmp = mkdtempSync(join(tmpdir(), 'docs-check-'));
    made.push(tmp);
    for (const surface of SURFACES) {
        const src = join(REPO, surface);
        if (!existsSync(src)) continue;
        cpSync(src, join(tmp, surface), {
            recursive: true,
            filter: (p) => !SKIP.has(basename(p)),
        });
    }
    return tmp;
}

function run(root) {
    const r = spawnSync(process.execPath, [SCRIPT, 'all', '--root', root], {
        encoding: 'utf8',
    });
    return { status: r.status, out: r.stdout + r.stderr };
}

function edit(root, relPath, fn) {
    const file = join(root, relPath);
    writeFileSync(file, fn(readFileSync(file, 'utf8')));
}

// Appends one line to a file and returns its 1-based line number.
function appendLine(root, relPath, line) {
    let n = 0;
    edit(root, relPath, (t) => {
        const norm = t.replace(/\r\n/g, '\n');
        const lines = norm.split('\n');
        n = norm.endsWith('\n') ? lines.length : lines.length + 1;
        return t + (norm.endsWith('\n') ? '' : '\n') + line + '\n';
    });
    return n;
}

after(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
});

test('baseline copy exits 0', () => {
    const r = run(fresh());
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /docs-check: 0 hard/);
});

test('a link to a page that does not exist is HARD', () => {
    const root = fresh();
    const n = appendLine(
        root,
        'docs/faq.mdx',
        'See [ghost](/self-hosting/ghost).'
    );
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(
        r.out,
        new RegExp(`HARD  links  docs/faq\\.mdx:${n}  /self-hosting/ghost`)
    );
});

test('an anchor that matches nothing on a page with only stable headings is HARD', () => {
    const root = fresh();
    const n = appendLine(
        root,
        'docs/faq.mdx',
        'See [x](/reference/transfer-protocol#nope).'
    );
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(
        r.out,
        new RegExp(`HARD  links  docs/faq\\.mdx:${n}  #nope not found`)
    );
});

test('a link to an unstable heading (the live-id case) is NOTE, not HARD', () => {
    const root = fresh();
    const n = appendLine(
        root,
        'docs/faq.mdx',
        'See [x](/web-app/receiving#if-floe-says-open-in-your-browser).'
    );
    const r = run(root);
    assert.equal(r.status, 0, r.out);
    assert.match(
        r.out,
        new RegExp(
            `NOTE  links  docs/faq\\.mdx:${n}  #if-floe-says-open-in-your-browser targets an unstable heading`
        )
    );
    assert.doesNotMatch(r.out, new RegExp(`HARD  links  docs/faq\\.mdx:${n}`));
});

test('a link to an explicit {#id} passes silently', () => {
    const root = fresh();
    const n = appendLine(
        root,
        'docs/faq.mdx',
        'See [x](/quickstart#cross-platform-transfers).'
    );
    const r = run(root);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, new RegExp(`docs/faq\\.mdx:${n}`));
});

test('a nav entry removed leaves an orphan page: HARD', () => {
    const root = fresh();
    edit(root, 'docs/docs.json', (t) => {
        assert.ok(
            t.includes('"self-hosting/unraid",'),
            'fixture assumes the unraid nav entry exists'
        );
        return t.replace('"self-hosting/unraid",', '');
    });
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(r.out, /HARD  nav  docs\/self-hosting\/unraid\.mdx:1/);
});

test('a nav entry without a page is HARD', () => {
    const root = fresh();
    edit(root, 'docs/docs.json', (t) =>
        t.replace(
            '"self-hosting/unraid",',
            '"self-hosting/unraid",\n          "self-hosting/ghost",'
        )
    );
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(
        r.out,
        /HARD  nav  docs\/docs\.json:1  nav entry "self-hosting\/ghost"/
    );
});

test('a navigation shape that yields no pages is one HARD, not one per page', () => {
    const root = fresh();
    edit(root, 'docs/docs.json', (t) => {
        const cfg = JSON.parse(t);
        cfg.navigation = { tabs: [{ tab: 'Guides', menu: [] }] };
        return JSON.stringify(cfg, null, 2);
    });
    const r = run(root);
    assert.equal(r.status, 1);
    assert.equal(
        r.out.split('navigation resolved to zero pages').length - 1,
        1
    );
    assert.doesNotMatch(r.out, /page is not in docs\.json navigation/);
});

test('an em dash is HARD with file:line', () => {
    const root = fresh();
    const n = appendLine(
        root,
        'docs/faq.mdx',
        `A sentence ${EM_DASH} with a dash.`
    );
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(r.out, new RegExp(`HARD  dashes  docs/faq\\.mdx:${n}:`));
});

test('a documented server default that contradicts server.js is HARD', () => {
    const root = fresh();
    edit(root, 'docs/self-hosting/configuration.mdx', (t) => {
        const row = '| `MAX_CONNECTIONS_PER_IP` | server | No | `30` |';
        assert.ok(
            t.includes(row),
            'fixture assumes the MAX_CONNECTIONS_PER_IP row shape'
        );
        return t.replace(
            row,
            '| `MAX_CONNECTIONS_PER_IP` | server | No | `31` |'
        );
    });
    const r = run(root);
    assert.equal(r.status, 1);
    const hard = r.out
        .split('\n')
        .find(
            (l) =>
                l.startsWith('HARD  env') &&
                l.includes('MAX_CONNECTIONS_PER_IP')
        );
    assert.ok(hard, r.out);
    assert.match(hard, /31/);
    assert.match(hard, /30/);
});

test('a page without a title is HARD', () => {
    const root = fresh();
    edit(root, 'docs/faq.mdx', (t) => t.replace(/^title:.*\r?\n/m, ''));
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(r.out, /HARD  frontmatter  docs\/faq\.mdx:1  missing title/);
});

test('headingSlugs: the three heading shapes the docs use', () => {
    // (i) The live-id case: Mintlify renders this id with the quotes kept, so
    // the heading is unstable and its collapsed slug is only a NOTE key.
    const live = headingSlugs('### If Floe says "Open in your browser"');
    assert.equal(live.ids.size, 0);
    assert.equal(live.unstable.length, 1);
    assert.equal(live.unstable[0].slug, 'if-floe-says-open-in-your-browser');
    assert.equal(live.unstable[0].line, 1);
    // A slash makes a heading unstable too (live id: post-/api/code).
    assert.equal(headingSlugs('### POST /api/code').unstable.length, 1);
    // (ii) An explicit id wins and is stable whatever the text contains.
    const explicit = headingSlugs(
        '## Any Floe can talk to any other {#cross-platform-transfers}'
    );
    assert.equal(
        explicit.ids.get('cross-platform-transfers'),
        'Any Floe can talk to any other'
    );
    assert.equal(explicit.unstable.length, 0);
    // (iii) Changelog entries anchor by their label (confirmed live: #v1-10-4).
    const update = headingSlugs(
        '<Update label="v1.10.4" description="2026-08-20" tags={["CLI"]}>'
    );
    assert.ok(update.ids.has('v1-10-4'));
    assert.equal(slug('v1.10.4'), 'v1-10-4');
});

test('a server/.env.example value or comment default that contradicts server.js is a NOTE', () => {
    const root = fresh();
    edit(root, 'server/.env.example', (t) => {
        assert.ok(
            t.includes('(default: 30).') &&
                t.includes('MAX_CONNECTIONS_PER_IP=30'),
            'fixture assumes the MAX_CONNECTIONS_PER_IP block shape'
        );
        return t
            .replace('(default: 30).', '(default: 31).')
            .replace('MAX_CONNECTIONS_PER_IP=30', 'MAX_CONNECTIONS_PER_IP=32');
    });
    const r = run(root);
    assert.equal(r.status, 0, r.out);
    const notes = r.out
        .split('\n')
        .filter(
            (l) =>
                l.startsWith('NOTE  env  server/.env.example') &&
                l.includes('MAX_CONNECTIONS_PER_IP')
        );
    assert.equal(notes.length, 2, r.out);
    assert.ok(
        notes.some((l) => l.includes('=32') && l.includes('defaults to 30'))
    );
    assert.ok(
        notes.some(
            (l) => l.includes('default 31') && l.includes('defaults to 30')
        )
    );
});
