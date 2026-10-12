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
    readdirSync,
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
    // #340 gave the live heading an explicit id, so synthesize an unstable
    // one: Mintlify keeps the quotes in the id it generates for it.
    appendLine(root, 'docs/faq.mdx', '### Says "hello" to the reader');
    const n = appendLine(
        root,
        'docs/faq.mdx',
        'See [x](/faq#says-hello-to-the-reader).'
    );
    const r = run(root);
    assert.equal(r.status, 0, r.out);
    assert.match(
        r.out,
        new RegExp(
            `NOTE  links  docs/faq\\.mdx:${n}  #says-hello-to-the-reader targets an unstable heading`
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

test('an image src with no file under docs/ is HARD', () => {
    const root = fresh();
    const n = appendLine(
        root,
        'docs/faq.mdx',
        '<img src="/images/web/ghost.png" alt="A capture that was never taken" />'
    );
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(
        r.out,
        new RegExp(
            `HARD  links  docs/faq\\.mdx:${n}  src /images/web/ghost\\.png has no file`
        )
    );
});

test('a snippet import that names no file is HARD', () => {
    const root = fresh();
    const n = appendLine(
        root,
        'docs/faq.mdx',
        "import Ghost from '/snippets/ghost.mdx';"
    );
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(
        r.out,
        new RegExp(
            `HARD  links  docs/faq\\.mdx:${n}  import of /snippets/ghost\\.mdx`
        )
    );
});

test('a snippet imported and never rendered is a NOTE, and so is a snippet nothing imports', () => {
    const root = fresh();
    writeFileSync(join(root, 'docs', 'snippets', 'orphan.mdx'), 'Nobody imports this.\n');
    const n = appendLine(
        root,
        'docs/faq.mdx',
        "import StatsOptOut from '/snippets/stats-optout.mdx';"
    );
    const r = run(root);
    assert.equal(r.status, 0, r.out);
    assert.match(
        r.out,
        new RegExp(
            `NOTE  links  docs/faq\\.mdx:${n}  StatsOptOut is imported from /snippets/stats-optout\\.mdx and never rendered`
        )
    );
    assert.match(
        r.out,
        /NOTE  links  docs\/snippets\/orphan\.mdx:1  snippet is imported by no page/
    );
});

test('a bare /docs path in client code that names no page is HARD', () => {
    const root = fresh();
    const n = appendLine(
        root,
        'client/lib/request/constants.ts',
        "export const GHOST_DOCS_PATH = '/docs/web-app/ghost';"
    );
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(
        r.out,
        new RegExp(
            `HARD  links  client/lib/request/constants\\.ts:${n}  /web-app/ghost has no docs/web-app/ghost\\.mdx`
        )
    );
});

test('a route pattern under /docs in client code is not read as a link', () => {
    const root = fresh();
    const n = appendLine(
        root,
        'client/lib/request/constants.ts',
        "export const DOCS_ROUTE = '/docs/:path*';"
    );
    const r = run(root);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(
        r.out,
        new RegExp(`client/lib/request/constants\\.ts:${n}`)
    );
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
        // The variable's table row, whatever columns the table has and
        // whether the name is plain or a link to its entry.
        const row = t
            .split('\n')
            .find((l) =>
                /^\|\s*\[?`MAX_CONNECTIONS_PER_IP`/.test(l.replace(/\r$/, ''))
            );
        assert.ok(
            row && row.includes('`30`'),
            'fixture assumes a MAX_CONNECTIONS_PER_IP table row whose default is `30`'
        );
        return t.replace(row, row.replace('`30`', '`31`'));
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
            t.includes('(default: 30 per IP per minute).') &&
                t.includes('MAX_CONNECTIONS_PER_IP=30'),
            'fixture assumes the MAX_CONNECTIONS_PER_IP block shape'
        );
        return t
            .replace('(default: 30 per IP per minute).', '(default: 31 per IP per minute).')
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

// reference/limits shipped five of these in #518: the rows went from four
// cells to three and the delimiter rows did not, so production showed each
// table as a paragraph of raw pipes.
test('a table whose delimiter row is wider than its header is HARD', () => {
    const root = fresh();
    appendLine(root, 'docs/faq.mdx', '');
    const n = appendLine(
        root,
        'docs/faq.mdx',
        '| Limit | Value | At the limit |'
    );
    appendLine(root, 'docs/faq.mdx', '|---|---|---|---|');
    appendLine(root, 'docs/faq.mdx', '| One | 2 | three |');
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(
        r.out,
        new RegExp(
            `HARD  tables  docs/faq\\.mdx:${n + 1}  the header has 3 cells and the delimiter row under it has 4`
        )
    );
});

test('a table drawn inside a code fence is not read as a table', () => {
    const root = fresh();
    for (const line of [
        '',
        '```text Example',
        '| A | B |',
        '|---|---|---|',
        '```',
    ])
        appendLine(root, 'docs/faq.mdx', line);
    const r = run(root);
    assert.equal(r.status, 0, r.out);
});

// If `\|` were a column boundary this row would have three cells, and its
// third would open with a straight quote.
test('an escaped pipe inside a cell is not a column boundary', () => {
    const root = fresh();
    for (const line of [
        '',
        '| Field | Type |',
        '|---|---|',
        '| `kind` | `"a" \\| "b"` |',
    ])
        appendLine(root, 'docs/faq.mdx', line);
    const r = run(root);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /(HARD|NOTE)  tables  docs\/faq\.mdx/);
});

// docs/style.css lowers the cell floor for a table with a fourth header cell,
// so four columns fit at 1280. Five get the same floor and fill the column to
// within 9 px, so they still need a look at the rendered page.
test('a table of five columns is a NOTE, and one of four is not', () => {
    const root = fresh();
    for (const line of [
        '',
        '| A | B | C | D |',
        '|---|---|---|---|',
        '| 1 | 2 | 3 | 4 |',
        '',
        '| A | B | C | D | E |',
        '|---|---|---|---|---|',
        '| 1 | 2 | 3 | 4 | 5 |',
    ])
        appendLine(root, 'docs/faq.mdx', line);
    const r = run(root);
    assert.equal(r.status, 0, r.out);
    const notes = r.out
        .split('\n')
        .filter((l) => l.startsWith('NOTE  tables  docs/faq.mdx'));
    assert.equal(notes.length, 1, r.out);
    assert.match(notes[0], /5 columns/);
});

// Mintlify's smart-quote pass renders a straight quote that opens a cell as a
// closing mark. #526 typed all 93 of them, and the rule went from NOTE to
// HARD so the next one is caught before it ships.
test('a straight quote that opens a table cell is HARD, and typed marks pass', () => {
    const typed = fresh();
    for (const line of [
        '',
        '| Message | Meaning |',
        '|---|---|',
        '| “Open in your browser” | x |',
        '| Reads "Offline" at the top | y |',
    ])
        appendLine(typed, 'docs/faq.mdx', line);
    const ok = run(typed);
    assert.equal(ok.status, 0, ok.out);

    const root = fresh();
    appendLine(root, 'docs/faq.mdx', '');
    appendLine(root, 'docs/faq.mdx', '| Message | Meaning |');
    appendLine(root, 'docs/faq.mdx', '|---|---|');
    const n = appendLine(
        root,
        'docs/faq.mdx',
        '| "Open in your browser" | x |'
    );
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(
        r.out,
        new RegExp(
            `HARD  tables  docs/faq\\.mdx:${n}  a straight double quote opens a table cell`
        )
    );
});

// The smart-quote pass sees the text and not the markup around it, and it
// joins a row's cells with nothing between them. A quotation behind emphasis
// or a link at the start of a cell therefore goes wrong the same way, in any
// cell and in the header, and one that closes a cell after a colon or a
// parenthesis is drawn as an opening mark (production showed that on two
// request-link messages before #526).
test('a quote at a cell edge is HARD behind markup, in any cell, and when it closes after punctuation', () => {
    const table = (row, header = '| Message | Meaning |') => {
        const root = fresh();
        appendLine(root, 'docs/faq.mdx', '');
        const h = appendLine(root, 'docs/faq.mdx', header);
        appendLine(root, 'docs/faq.mdx', '|---|---|');
        const n = appendLine(root, 'docs/faq.mdx', row);
        return { r: run(root), h, n };
    };
    for (const [row, which] of [
        ['| **"Open in your browser"** | x |', 'opens a table cell'],
        ['| ["Open"](/faq) | x |', 'opens a table cell'],
        ['| x | "Second cell" opens it |', 'opens a table cell'],
        ['| Reads "low space on C:" | Because the drive is full |', 'closes a table cell after punctuation'],
        ['| Make your proxy forward "/ws)" | y |', 'closes a table cell after punctuation'],
    ]) {
        const { r, n } = table(row);
        assert.equal(r.status, 1, row);
        assert.ok(
            r.out.includes(`HARD  tables  docs/faq.mdx:${n}  a straight double quote ${which}`),
            `${row}\n${r.out}`
        );
    }
    const head = table('| a | b |', '| "Quoted" | Meaning |');
    assert.equal(head.r.status, 1, head.r.out);
    assert.ok(
        head.r.out.includes(`HARD  tables  docs/faq.mdx:${head.h}  a straight double quote opens a table cell`),
        head.r.out
    );
    // A quotation that ends a cell after a word or a full stop is drawn right.
    for (const row of ['| Ends with a "word" | y |', '| Ends with "a sentence." | y |']) {
        const { r } = table(row);
        assert.equal(r.status, 0, `${row}\n${r.out}`);
    }
});

// A tilde fence is a code block too, and a three-backtick fence shown inside
// a four-backtick one does not end the outer block.
test('a table drawn inside a tilde fence or a nested fence is not read as a table', () => {
    const broken = ['| A | B |', '|---|---|---|', '| 1 | 2 |'];
    const root = fresh();
    for (const line of ['', '~~~', ...broken, '~~~', '', '````md', '```', ...broken, '```', '````'])
        appendLine(root, 'docs/faq.mdx', line);
    const r = run(root);
    assert.equal(r.status, 0, r.out);

    // The fences above really closed: the same block after them is caught.
    appendLine(root, 'docs/faq.mdx', '');
    const n = appendLine(root, 'docs/faq.mdx', broken[0]);
    appendLine(root, 'docs/faq.mdx', broken[1]);
    const after = run(root);
    assert.equal(after.status, 1, after.out);
    assert.ok(after.out.includes(`HARD  tables  docs/faq.mdx:${n + 1}  the header has 2 cells`), after.out);
});

// The path class of a docs URL has to allow a dot, so a URL that ends a
// sentence used to be looked up with its full stop, and every such sentence in
// code, a workflow or a Markdown file was a HARD "no such page".
test('a docs URL that ends a sentence is checked without its full stop', () => {
    const root = fresh();
    appendLine(root, 'README.md', 'The flags are listed at https://www.floe.one/docs/cli/flags.');
    const ok = run(root);
    assert.equal(ok.status, 0, ok.out);

    const n = appendLine(root, 'README.md', 'See https://www.floe.one/docs/cli/no-such-page.');
    const r = run(root);
    assert.equal(r.status, 1, r.out);
    assert.ok(r.out.includes(`HARD  links  README.md:${n}  /cli/no-such-page has no docs/cli/no-such-page.mdx`), r.out);
});

// The dash rule covers every Markdown file, and this check used to look only
// at the root and docs/. .goreleaser.yml's comments are the release runbook.
// desktop/build/README.md is on the list too and cannot be planted here: this
// harness skips every directory named build when it copies the tree.
test('an em dash in .goreleaser.yml, under unraid/ or desktop/, or in docs/style.css is HARD', () => {
    for (const file of ['.goreleaser.yml', 'unraid/README.md', 'desktop/README.md', 'docs/style.css']) {
        const root = fresh();
        const n = appendLine(
            root,
            file,
            `# A comment ${EM_DASH} with a dash.`
        );
        const r = run(root);
        assert.equal(r.status, 1, file);
        assert.match(
            r.out,
            new RegExp(
                `HARD  dashes  ${file.replace(/[.]/g, '\\.')}:${n}:`
            ),
            file
        );
    }
});

// cli/self-hosted-server's description named `--server` on 2026-10-11 and the
// rendered page showed an em dash followed by "server".
test('two hyphens in a description are HARD', () => {
    const root = fresh();
    edit(root, 'docs/faq.mdx', (t) =>
        t.replace(
            /^description:.*$/m,
            'description: "Point the CLI at a server with --server."'
        )
    );
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(
        r.out,
        /HARD  frontmatter  docs\/faq\.mdx:1  description contains "--"/
    );
});

// Windows and macOS resolve this path by folding case. Mintlify builds on
// Linux, where it names no file.
test('an image path that differs from the file only by letter case is HARD', () => {
    const root = fresh();
    const real = readdirSync(join(root, 'docs', 'images', 'web')).find((n) =>
        /[a-z]/.test(n)
    );
    assert.ok(real, 'fixture assumes at least one image under docs/images/web');
    const wrong = real.replace(/[a-z]/, (c) => c.toUpperCase());
    const n = appendLine(
        root,
        'docs/faq.mdx',
        `<img src="/images/web/${wrong}" alt="x" />`
    );
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(
        r.out,
        new RegExp(`HARD  links  docs/faq\\.mdx:${n}  src /images/web/`)
    );
});

// The configuration page in the shape "one entry per variable": the table
// keeps the three columns the check reads and the description moves out. The
// earlier parser counted cells and would have read none of these rows.
function configurationPage(header, row) {
    const columns = header.split('|').slice(1, -1);
    return [
        '---',
        'title: "Configuration reference"',
        'sidebarTitle: "Configuration"',
        'description: "Every variable."',
        '---',
        '',
        '## Variables',
        '',
        header,
        `|${columns.map(() => ' --- ').join('|')}|`,
        row,
        '',
        '### `MAX_CONNECTIONS_PER_IP` {#max-connections-per-ip}',
        '',
        'Connections per address per minute.',
        '',
    ].join('\n');
}

function envHards(out) {
    return out.split('\n').filter((l) => l.startsWith('HARD  env'));
}

test('the configuration table is read by column name, whatever its shape', () => {
    const shapes = [
        // Three columns, the name a link to its entry.
        [
            '| Variable | Service | Default |',
            (d) =>
                `| [\`MAX_CONNECTIONS_PER_IP\`](#max-connections-per-ip) | server | \`${d}\` |`,
        ],
        // The same columns in another order.
        [
            '| Default | Variable | Service |',
            (d) => `| \`${d}\` | \`MAX_CONNECTIONS_PER_IP\` | server |`,
        ],
        // Today's five columns.
        [
            '| Variable | Service | Required | Default | Purpose |',
            (d) =>
                `| \`MAX_CONNECTIONS_PER_IP\` | server | No | \`${d}\` | Limit. |`,
        ],
    ];
    for (const [header, row] of shapes) {
        const wrong = fresh();
        writeFileSync(
            join(wrong, 'docs/self-hosting/configuration.mdx'),
            configurationPage(header, row('31'))
        );
        const bad = envHards(run(wrong).out);
        assert.equal(bad.length, 1, `${header}\n${bad.join('\n')}`);
        assert.match(bad[0], /MAX_CONNECTIONS_PER_IP documented default 31/);

        const right = fresh();
        writeFileSync(
            join(right, 'docs/self-hosting/configuration.mdx'),
            configurationPage(header, row('30'))
        );
        assert.deepEqual(envHards(run(right).out), [], header);
    }
});

test('a configuration page that yields no variable rows is HARD, not a silent pass', () => {
    const root = fresh();
    // The columns merged into one: nothing names a Service column any more.
    writeFileSync(
        join(root, 'docs/self-hosting/configuration.mdx'),
        configurationPage(
            '| Variable | Used by and default |',
            '| `MAX_CONNECTIONS_PER_IP` | server, `31` |'
        )
    );
    const hards = envHards(run(root).out);
    assert.equal(hards.length, 1, hards.join('\n'));
    assert.match(
        hards[0],
        /HARD  env  docs\/self-hosting\/configuration\.mdx:1  no variable rows found/
    );
});
