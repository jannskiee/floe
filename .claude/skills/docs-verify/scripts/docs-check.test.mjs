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
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import {
    SERVER_KEY_FLOOR,
    SURFACES,
    headingSlugs,
    headingTagProblems,
    slug,
    splitSentences,
} from './docs-check.mjs';
import { RELEASED_SURFACES, heldToRelease } from './released-strings.mjs';

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
        '| Text | Meaning |',
        '|---|---|',
        '| “Open in your browser” | x |',
        '| Reads "Offline" at the top | y |',
    ])
        appendLine(typed, 'docs/faq.mdx', line);
    const ok = run(typed);
    assert.equal(ok.status, 0, ok.out);

    const root = fresh();
    appendLine(root, 'docs/faq.mdx', '');
    appendLine(root, 'docs/faq.mdx', '| Text | Meaning |');
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
    const table = (row, header = '| Text | Meaning |') => {
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
    for (const line of ['', '~~~text', ...broken, '~~~', '', '````md', '```', ...broken, '```', '````'])
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

// A tree that holds only what the env check needs: a docs.json, and a server/
// that reads `count` keys. Nothing in it is the repository's own server/, so
// a product change that adds or drops a key cannot move the test below.
function envTree(count) {
    const tmp = mkdtempSync(join(tmpdir(), 'docs-check-env-'));
    made.push(tmp);
    mkdirSync(join(tmp, 'docs'));
    writeFileSync(join(tmp, 'docs', 'docs.json'), '{"navigation":{}}\n');
    mkdirSync(join(tmp, 'server'));
    writeFileSync(
        join(tmp, 'server', 'server.js'),
        Array.from(
            { length: count },
            (_, i) => `const k${i} = process.env.FIXTURE_KEY_${i} || 'x';\n`
        ).join('')
    );
    return tmp;
}

test('the server key floor: fewer keys is HARD, more is a NOTE to raise it, the same number is silent', () => {
    const env = (count) => {
        const r = spawnSync(
            process.execPath,
            [SCRIPT, 'env', '--root', envTree(count)],
            { encoding: 'utf8' }
        );
        return { status: r.status, out: r.stdout + r.stderr };
    };

    // One key more than the floor is what a pull request that adds a setting
    // looks like. It must pass, and it must say the floor needs raising.
    const behind = env(SERVER_KEY_FLOOR + 1);
    assert.equal(behind.status, 0, behind.out);
    assert.ok(
        behind.out
            .split(/\r?\n/)
            .includes(
                `NOTE  env  server/server.js:1  the floor is behind: ${SERVER_KEY_FLOOR + 1} keys read, floor ${SERVER_KEY_FLOOR}; raise SERVER_KEY_FLOOR in docs-check.mjs`
            ),
        behind.out
    );
    assert.doesNotMatch(behind.out, /extractor found/);

    const level = env(SERVER_KEY_FLOOR);
    assert.equal(level.status, 0, level.out);
    assert.doesNotMatch(level.out, /the floor is behind|extractor found/);

    // One fewer is the extractor losing a key: the one case that fails.
    const broken = env(SERVER_KEY_FLOOR - 1);
    assert.equal(broken.status, 1, broken.out);
    assert.match(
        broken.out,
        new RegExp(
            `HARD  env  server/server\\.js:1  extractor found ${SERVER_KEY_FLOOR - 1} keys; the regex no longer matches the source`
        )
    );
    assert.doesNotMatch(broken.out, /the floor is behind/);
});

// The six MAX_* settings are read as envLimit('NAME', default): the helper in
// server/envlimit.js looks the variable up by its name, so the line holds no
// process.env.NAME for the key scan to find, and the default is the second
// argument. A tree of its own, like envTree, one key short of the floor until
// the envLimit line is counted, so losing that pattern fails here by the count.
function envLimitTree(limitLine, variable, documented) {
    const tmp = envTree(SERVER_KEY_FLOOR - 1);
    edit(tmp, 'server/server.js', (t) => `${t}${limitLine}\n`);
    mkdirSync(join(tmp, 'docs', 'self-hosting'));
    writeFileSync(
        join(tmp, 'docs', 'self-hosting', 'configuration.mdx'),
        [
            '---',
            'title: "Configuration reference"',
            'sidebarTitle: "Configuration"',
            'description: "Every variable."',
            '---',
            '',
            '| Variable | Service | Default |',
            '| --- | --- | --- |',
            `| \`${variable}\` | server | \`${documented}\` |`,
            '',
        ].join('\n')
    );
    const r = spawnSync(process.execPath, [SCRIPT, 'env', '--root', tmp], {
        encoding: 'utf8',
    });
    return { status: r.status, hards: envHards(r.stdout + r.stderr) };
}

test('a default read through envLimit is counted as a key and compared with the documented one', () => {
    const plain = "const MAX_CONNECTIONS_PER_IP = envLimit('MAX_CONNECTIONS_PER_IP', 30);";
    const right = envLimitTree(plain, 'MAX_CONNECTIONS_PER_IP', '30');
    assert.deepEqual(right.hards, []);
    assert.equal(right.status, 0);

    const wrong = envLimitTree(plain, 'MAX_CONNECTIONS_PER_IP', '31');
    assert.equal(wrong.status, 1);
    assert.equal(wrong.hards.length, 1, wrong.hards.join('\n'));
    assert.match(
        wrong.hards[0],
        /MAX_CONNECTIONS_PER_IP documented default 31 but server\/ defaults to 30$/
    );

    // A default written as arithmetic is worked out, as the 5 TiB report cap is.
    const product =
        "const MAX_REPORT_BYTES = envLimit('MAX_REPORT_BYTES', 5 * 1024 * 1024 * 1024 * 1024); // 5 TiB";
    assert.deepEqual(
        envLimitTree(product, 'MAX_REPORT_BYTES', '5497558138880').hards,
        []
    );
    const stale = envLimitTree(product, 'MAX_REPORT_BYTES', '1099511627776');
    assert.equal(stale.hards.length, 1, stale.hards.join('\n'));
    assert.match(
        stale.hards[0],
        /MAX_REPORT_BYTES documented default 1099511627776 but server\/ defaults to 5497558138880$/
    );
});

test('an envLimit default that is not plain arithmetic is HARD, not a default nobody compares', () => {
    const named = envLimitTree(
        "const MAX_CONNECTIONS_PER_IP = envLimit('MAX_CONNECTIONS_PER_IP', DEFAULT_CONNECTIONS);",
        'MAX_CONNECTIONS_PER_IP',
        '31'
    );
    assert.equal(named.status, 1);
    assert.equal(named.hards.length, 1, named.hards.join('\n'));
    assert.match(
        named.hards[0],
        new RegExp(
            `HARD  env  server/server\\.js:1  extractor found ${SERVER_KEY_FLOOR} keys, no default for MAX_CONNECTIONS_PER_IP; the regex no longer matches the source`
        )
    );
});

test('the proxy count the server example ships is 0 by design, and any other value there is still a NOTE', () => {
    // server/.env.example describes a direct run with no proxy in front, so it
    // ships TRUSTED_PROXY_COUNT=0 beside a code default of 1, as Compose and the
    // Unraid template do. That one value is admitted; the comparison itself
    // must stay on.
    const proxyNotes = (out) =>
        out
            .split(/\r?\n/)
            .filter(
                (l) =>
                    l.startsWith('NOTE  env  server/.env.example:') &&
                    l.includes('TRUSTED_PROXY_COUNT')
            );

    const shipped = fresh();
    assert.match(
        readFileSync(join(shipped, 'server/.env.example'), 'utf8'),
        /^TRUSTED_PROXY_COUNT=0$/m
    );
    assert.deepEqual(proxyNotes(run(shipped).out), []);

    const other = fresh();
    edit(other, 'server/.env.example', (t) =>
        t.replace(/^TRUSTED_PROXY_COUNT=0$/m, 'TRUSTED_PROXY_COUNT=2')
    );
    const notes = proxyNotes(run(other).out);
    assert.equal(notes.length, 1, notes.join('\n'));
    assert.match(
        notes[0],
        /TRUSTED_PROXY_COUNT=2 here but server\/ defaults to 1$/
    );
});

test('headingTagProblems agrees with the MDX compiler on every heading here, both ways', () => {
    // Each string was compiled as "### <string>" by @mdx-js/mdx 3.1.1 on
    // 2026-10-12. REFUSED is what the compiler stops on and COMPILED is what it
    // accepts. The check sits in the required gate, so both directions count:
    // a miss lets a page through that cannot build, and a false flag blocks a
    // correct pull request.
    const REFUSED = [
        // A tag that opens and never closes, or closes what is not open.
        'Could not read <name>',
        'floe send <files> --to "<link>"',
        'Paste the <link>',
        'Line one <br> two',
        'Set <KEY>',
        '<img src="x">',
        '<b>bold',
        '<>x',
        'Paste the </name>',
        'x</b>',
        'A <b>bold</i> c',
        '<b><i>x</b></i>',
        '<name> ###',
        '**<name>**',
        '[<name>](/y)',
        // A "<" with no space after it that does not start a tag at all.
        'Relay transfers <2 GB',
        'Sizes <= 2 GB',
        'x <3 y',
        'a <',
        'a < ',
        '<& x',
        '<<name>>',
        '<!-- note -->',
        // An autolink is not MDX: the compiler reads it as a tag too.
        '<https://floe.one>',
        'See <https://floe.one> now',
        'Mail <a@b.co>',
        // A tag that starts and is never finished.
        'Under <$5',
        'a<b',
        'a <b>x</b> <c',
        '<X a=b />',
        '<X a="unterminated />',
        '<X a={1 />',
        // What looks escaped and is not.
        '\\\\<name>',
        '`open <name>',
        '`{` <name>',
        "{'}'} <name>",
        '[x](<a>) <name>',
        // Shaped like a link destination, and not one.
        '](<b>',
        '\\[t](<u v>)',
    ];
    const COMPILED = [
        // Escaped, in code, or in an expression.
        'Could not read &lt;name&gt;',
        'Could not read \\<name>',
        'Run `floe send <files>` now',
        'Run ``floe <a>`` now',
        '``a ` <b> `` c',
        "{'<name>'}",
        '{`<x>`}',
        "{a} <b>x</b> {'<'}",
        // A "<" followed by a space or a tab is text.
        'Files < 2 GB',
        '1 < 2 and 3 > 2',
        'a <\tb',
        '< name>',
        'a > b',
        // Tags that close, however they are written.
        'Install <Badge>Beta</Badge>',
        'A <b>bold <i>it</i></b> c',
        '<b>x</b><i>y</i>',
        '<Foo>x</Foo>',
        '<a href="x">link</a>',
        '[<b>x</b>](/y)',
        '<b>x</b >',
        '<b>x</ b>',
        '<name >x</name>',
        '<a.b>x</a.b>',
        '<a-b>x</a-b>',
        '<_x>y</_x>',
        '<></>',
        '<>x</>',
        'Line one <br /> two',
        '<br/>',
        '<svg:rect />',
        '<$x />',
        'Use <Icon icon="x" /> here',
        '<Icon icon="a" / >',
        '<X a />',
        '<X {...p} />',
        '<X a="1" b={2} c />',
        // A ">" inside a quoted attribute or an expression does not end the tag.
        '<Icon icon="arrow->" />',
        "<Icon icon='a>b' />",
        '<Badge color={n > 1 ? "a" : "b"} />',
        // A Markdown link or image destination in angle brackets.
        '[x](<my guide.md>)',
        '![alt](<a b.png>)',
        '[t](<u> "a title")',
        '[a [b] c](<x y>)',
    ];
    for (const h of REFUSED)
        assert.notDeepEqual(headingTagProblems(h), [], `passed, and MDX refuses it: ${h}`);
    for (const h of COMPILED)
        assert.deepEqual(headingTagProblems(h), [], `flagged, and MDX compiles it: ${h}`);
    // The explicit id every docs heading carries is Mintlify's own syntax
    // (stock MDX refuses it as an expression). The check has no opinion on
    // what is inside braces, so it stays silent on the id and still sees
    // the tag beside it.
    assert.deepEqual(headingTagProblems('Plain heading {#an-id}'), []);
    assert.deepEqual(headingTagProblems('Read <name> {#an-id}'), ['<name>']);
});

test('headingTagProblems names what it found, in the order it is written', () => {
    const cases = [
        ['Could not read <name>', ['<name>']],
        ['floe send <files> --to "<link>"', ['<files>', '<link>']],
        ['A <b>bold</i> c', ['<b>', '</i>']],
        ['Line one <br> two', ['<br>']],
        ['<>x', ['<>']],
        ['Relay transfers <2 GB', ['<2']],
        ['Sizes <= 2 GB', ['<=']],
        ['Under <$5', ['<$5']],
        ['See <https://floe.one> now', ['<https://floe.one>']],
        ['a <', ['<']],
    ];
    for (const [heading, want] of cases)
        assert.deepEqual(headingTagProblems(heading), want, heading);
});

test('a raw "<" in a heading is HARD, and the escaped, code, fenced, valid and frontmatter forms are not', () => {
    // A tree of its own, one page: nothing in the repository's docs can move
    // this test, and `headings` is the only check that runs.
    const root = mkdtempSync(join(tmpdir(), 'docs-check-headings-'));
    made.push(root);
    mkdirSync(join(root, 'docs'));
    writeFileSync(
        join(root, 'docs', 'docs.json'),
        '{"navigation":{"pages":["page"]}}\n'
    );
    const lines = [
        '---',
        'title: "A page"',
        // A YAML comment starts with "#" and is not a heading.
        '# a comment that names <name>',
        'description: "For the headings check."',
        '---',
        '',
        '### Could not read <name> on that drive',
        '### Relay transfers <2 GB',
        '### Could not read &lt;name&gt; on that drive',
        '### Run `floe send <files>` first',
        "### {'<name>'} stays text",
        '### <Icon icon="arrow->" /> Next',
        '### <Badge color={n > 1 ? "a" : "b"} /> New',
        '### [the guide](<my guide.md>)',
        '### Files < 2 GB {#files-under-2-gb}',
        '```md',
        '### Could not read <files>',
        '```',
    ];
    writeFileSync(join(root, 'docs', 'page.mdx'), `${lines.join('\n')}\n`);
    const at = (line) => lines.indexOf(line) + 1;
    const r = spawnSync(
        process.execPath,
        [SCRIPT, 'headings', '--root', root],
        { encoding: 'utf8' }
    );
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 1, out);
    // Exactly the two broken headings, so every other line above passed.
    const hard = out.split(/\r?\n/).filter((l) => l.startsWith('HARD'));
    assert.equal(hard.length, 2, out);
    assert.ok(
        hard[0].startsWith(
            `HARD  headings  docs/page.mdx:${at('### Could not read <name> on that drive')}  <name> in a heading: `
        ),
        out
    );
    assert.ok(
        hard[1].startsWith(
            `HARD  headings  docs/page.mdx:${at('### Relay transfers <2 GB')}  <2 in a heading: `
        ),
        out
    );
});

// ---------------------------------------------------------------------------
// The checks that started report-only: readability, pagestandard, glossary,
// captures. pagestandard and captures are hard since 2026-10-15.
//
// Each test builds a tree of its own with only the pages it names and runs
// one check, so nothing in the repository's docs can move a result. The real
// path is taken because the script resolves its root, and the suite's temp
// directory is an 8.3 short name on the Windows runner.
// ---------------------------------------------------------------------------

const FRONT = [
    '---',
    'title: "A page"',
    'sidebarTitle: "Page"',
    'description: "A page for one check."',
    'keywords: ["fixture"]',
    '---',
    '',
];
const page = (...body) => `${[...FRONT, ...body].join('\n')}\n`;
// The 1-based line of the first line that starts with `text`.
const lineOf = (mdx, text) =>
    mdx.split('\n').findIndex((l) => l.startsWith(text)) + 1;
const words = (n, word = 'word') =>
    Array.from({ length: n }, () => word).join(' ');

function small(files) {
    const root = realpathSync.native(
        mkdtempSync(join(tmpdir(), 'docs-check-small-'))
    );
    made.push(root);
    const pages = Object.keys(files)
        .filter((p) => p.startsWith('docs/') && p.endsWith('.mdx'))
        .map((p) => p.slice('docs/'.length, -'.mdx'.length));
    const all = {
        'docs/docs.json': `${JSON.stringify({ navigation: { pages } })}\n`,
        ...files,
    };
    for (const [path, content] of Object.entries(all)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }
    return root;
}

function only(check, root) {
    const r = spawnSync(process.execPath, [SCRIPT, check, '--root', root], {
        encoding: 'utf8',
    });
    const out = r.stdout + r.stderr;
    const lines = out.split(/\r?\n/);
    return {
        status: r.status,
        out,
        lines,
        notes: lines.filter((l) => l.startsWith(`NOTE  ${check}  `)),
        hard: lines.filter((l) => l.startsWith(`HARD  ${check}  `)),
        info: lines.filter((l) => l.startsWith(`info  ${check}  `)),
    };
}

test('splitSentences: an abbreviation, a version, a file name, a decimal and an ellipsis end nothing', () => {
    const split = (text) => splitSentences(text).map((s) => s.text.trim());
    assert.deepEqual(
        split(
            'Use a relay, e.g. Cloudflare, when a direct path fails. Then retry.'
        ),
        [
            'Use a relay, e.g. Cloudflare, when a direct path fails.',
            'Then retry.',
        ]
    );
    assert.deepEqual(
        split('Floe 1.11.0 added request links. Floe Desktop 0.3.0 followed.'),
        ['Floe 1.11.0 added request links.', 'Floe Desktop 0.3.0 followed.']
    );
    assert.deepEqual(split('Send a.bin first. Then b.tar.gz goes.'), [
        'Send a.bin first.',
        'Then b.tar.gz goes.',
    ]);
    assert.deepEqual(split('It took 2.5 seconds. That is fast.'), [
        'It took 2.5 seconds.',
        'That is fast.',
    ]);
    assert.deepEqual(
        split('The line reads Waiting for peer... Then it changes. Done.'),
        ['The line reads Waiting for peer... Then it changes.', 'Done.']
    );
    assert.deepEqual(
        split('The line reads Connecting\u2026 Then it changes.'),
        ['The line reads Connecting\u2026 Then it changes.']
    );
    // A quotation that ends on a full stop and goes on is one sentence.
    assert.deepEqual(
        split('The page says "Connection lost." and stops. Reload it.'),
        ['The page says "Connection lost." and stops.', 'Reload it.']
    );
    // A sentence that starts on a lower-case name is still a sentence.
    assert.deepEqual(
        split('Run it once. floe prints the code. Is that all? Yes!'),
        ['Run it once.', 'floe prints the code.', 'Is that all?', 'Yes!']
    );
    // A bold run-in sentence ends inside its emphasis marks.
    assert.deepEqual(
        split(
            '**Most shortcuts pause while you type.** They do nothing in a text field.'
        ),
        [
            '**Most shortcuts pause while you type.**',
            'They do nothing in a text field.',
        ]
    );
    assert.deepEqual(split('No full stop at the end'), [
        'No full stop at the end',
    ]);
});

test('readability: a sentence over 35 words is a NOTE with its line and count, and 35 is not', () => {
    const mdx = page(
        `Fine ${words(34)}.`,
        '',
        `Long ${words(35)}.`,
        '',
        `Two ${words(20)}. Halves ${words(20)}.`
    );
    const r = only('readability', small({ 'docs/faq.mdx': mdx }));
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.notes, [
        `NOTE  readability  docs/faq.mdx:${lineOf(mdx, 'Long ')}  a sentence of 36 words (the limit is 35)`,
    ]);
});

test('readability: a sentence is counted across its lines and reported at the line it starts on', () => {
    const mdx = page(
        `Short one. Long ${words(10)}`,
        words(13),
        `${words(12)}.`
    );
    const r = only('readability', small({ 'docs/faq.mdx': mdx }));
    assert.deepEqual(r.notes, [
        `NOTE  readability  docs/faq.mdx:${lineOf(mdx, 'Short one.')}  a sentence of 36 words (the limit is 35)`,
    ]);
});

test('readability: prose is what a reader sees, so code, tags, comments, imports and link targets are not words', () => {
    const mdx = page(
        "import Limits from '/snippets/limits.mdx';",
        '',
        // 34 words and a code span: 35.
        `Code ${words(33)} \`floe send a.bin --to link. Not a sentence end\`.`,
        '',
        // 34 words and a link whose target is long: 35.
        `Link ${words(33)} [label](/a/very/long/target/that/is/not/words#and-its-anchor).`,
        '',
        '```text',
        `Fenced ${words(60)}.`,
        '```',
        '',
        `{/* Comment ${words(60)}. */}`,
        '',
        // Attributes are not text; what is between the tags is.
        `<Frame caption="${words(60)}">`,
        `  <img src="/images/a.png" style={{ width: "100%" }} alt="An alt text of the right length that ends in a period." />`,
        '</Frame>',
        '',
        '<Warning>',
        `Inside ${words(35)}.`,
        '</Warning>',
        '',
        // The same once the code span is a word too many.
        `Over ${words(34)} \`floe\`.`
    );
    const r = only('readability', small({ 'docs/faq.mdx': mdx }));
    assert.deepEqual(r.notes, [
        `NOTE  readability  docs/faq.mdx:${lineOf(mdx, 'Inside ')}  a sentence of 36 words (the limit is 35)`,
        `NOTE  readability  docs/faq.mdx:${lineOf(mdx, 'Over ')}  a sentence of 36 words (the limit is 35)`,
    ]);
});

test('readability: a list item is a sentence of its own, and a table row is no sentence', () => {
    const mdx = page(
        `Intro ${words(19)}:`,
        '',
        `- First ${words(19)}`,
        `- Second ${words(19)}`,
        `  and its second line ${words(12)}`,
        `1. Numbered ${words(35)}`,
        '',
        '| Name | Meaning |',
        '| --- | --- |',
        `| ${words(30)} | ${words(40)} |`,
        `| short | ${words(41)} |`
    );
    const r = only('readability', small({ 'docs/faq.mdx': mdx }));
    assert.deepEqual(r.notes, [
        `NOTE  readability  docs/faq.mdx:${lineOf(mdx, '- Second ')}  a sentence of 36 words (the limit is 35)`,
        `NOTE  readability  docs/faq.mdx:${lineOf(mdx, '1. Numbered ')}  a sentence of 36 words (the limit is 35)`,
        `NOTE  readability  docs/faq.mdx:${lineOf(mdx, '| short ')}  a table cell of 41 words (the limit is 40)`,
    ]);
});

test('readability: an image alt text is held to 40 to 150 characters and a closing period', () => {
    const alt = (text) => `<img src="/images/a.png" alt="${text}" />`;
    const forty = 'The send card with three files, staged..';
    assert.equal(forty.length, 40);
    const mdx = page(
        'Pictures.',
        '',
        alt(forty),
        alt('Too short.'),
        alt('A long description of the card. '.repeat(5).trim()),
        alt('The send card with three files staged and no period'),
        '![Too short.](/images/b.png)',
        alt(`${forty} It also shows the relay checkbox.`)
    );
    const r = only('readability', small({ 'docs/faq.mdx': mdx }));
    const at = (n) => `NOTE  readability  docs/faq.mdx:${FRONT.length + n}  `;
    assert.deepEqual(r.notes, [
        `${at(4)}image alt text is 10 characters (the range is 40 to 150)`,
        `${at(5)}image alt text is 159 characters (the range is 40 to 150)`,
        `${at(6)}image alt text does not end in a period`,
        `${at(7)}image alt text is 10 characters (the range is 40 to 150)`,
    ]);
});

test('readability: a page over 1,200 words needs "The short version" among its first three H2s', () => {
    const body = Array.from({ length: 61 }, () => `${words(20)}.`).join('\n\n');
    const long = (...h2) =>
        page(
            'Opening.',
            '',
            ...h2.flatMap((h) => [`## ${h}`, '', 'Text.', '']),
            body
        );
    const run = (mdx) =>
        only('readability', small({ 'docs/faq.mdx': mdx })).notes;
    assert.deepEqual(run(long('First', 'Second')), [
        'NOTE  readability  docs/faq.mdx:1  1223 words of prose and no "The short version" among the first three H2 headings',
    ]);
    assert.deepEqual(
        run(long('First', 'The short version {#summary}', 'Third')),
        []
    );
    assert.equal(
        run(long('First', 'Second', 'Third', 'The short version')).length,
        1
    );
    // A page at the limit needs none.
    assert.deepEqual(
        run(
            page(Array.from({ length: 60 }, () => `${words(20)}.`).join('\n\n'))
        ),
        []
    );
});

test('readability: only user pages are listed, and every other page is one info line', () => {
    const long = page(`Long ${words(40)}.`);
    const r = only(
        'readability',
        small({
            'docs/desktop/sending.mdx': long,
            'docs/how-it-works/signaling.mdx': long,
            'docs/cli/send.mdx': long,
            'docs/reference/limits.mdx': long,
            'docs/self-hosting/overview.mdx': long,
            'docs/changelog.mdx': long,
        })
    );
    assert.deepEqual(
        r.notes.map((l) => l.split('  ')[2]),
        [
            `docs/desktop/sending.mdx:${lineOf(long, 'Long ')}`,
            `docs/how-it-works/signaling.mdx:${lineOf(long, 'Long ')}`,
        ]
    );
    assert.equal(
        r.info.filter(
            (l) =>
                l.includes('4 other pages') &&
                l.includes('4 sentences over 35 words')
        ).length,
        1,
        r.out
    );
});

test('a report-only check prints 15 notes in an `all` run and says how to see the rest', () => {
    const mdx = page(
        ...Array.from({ length: 20 }, () => [`Long ${words(35)}.`, '']).flat()
    );
    const root = small({ 'docs/faq.mdx': mdx });
    const alone = only('readability', root);
    assert.equal(alone.notes.length, 20, alone.out);

    const r = spawnSync(process.execPath, [SCRIPT, 'all', '--root', root], {
        encoding: 'utf8',
    });
    const lines = (r.stdout + r.stderr).split(/\r?\n/);
    assert.equal(
        lines.filter((l) => l.startsWith('NOTE  readability  ')).length,
        15,
        r.stdout
    );
    assert.ok(
        lines.includes(
            'info  readability  docs/  5 more notes not shown: `docs-check.mjs readability` prints them all'
        ),
        r.stdout
    );
    // Shown or not, a note is counted.
    const total = lines
        .find((l) => l.startsWith('docs-check: '))
        .match(/(\d+) notes/);
    assert.ok(Number(total[1]) >= 20, r.stdout);
});

test('pagestandard: callouts, components, frontmatter keys, the opening, and what a page must carry', () => {
    const kinds = (mdx, name = 'docs/faq.mdx') =>
        only('pagestandard', small({ [name]: mdx })).hard.map((l) =>
            l.split('  ').slice(2).join('  ')
        );
    const at = (mdx, text) => `docs/faq.mdx:${lineOf(mdx, text)}`;

    assert.deepEqual(
        kinds(
            page(
                'A clean page.',
                '',
                '<Warning>',
                'Careful.',
                '</Warning>',
                '',
                '## Next',
                '',
                '<Info>',
                'Also.',
                '</Info>'
            )
        ),
        []
    );

    const callouts = page(
        'Opening.',
        '',
        '<Note>',
        'A note.',
        '</Note>',
        '',
        '## More',
        '',
        '<Tip>A tip.</Tip>'
    );
    assert.deepEqual(kinds(callouts), [
        `${at(callouts, '<Note>')}  callout: <Note> is not used in these docs, only <Warning> and <Info>`,
        `${at(callouts, '<Tip>')}  callout: <Tip> is not used in these docs, only <Warning> and <Info>`,
    ]);

    const parts = page(
        'Opening.',
        '',
        '<AccordionGroup>',
        '<Accordion title="One">Text.</Accordion>',
        '</AccordionGroup>',
        '',
        'A <Tooltip tip="x">word</Tooltip> and a <Badge>Beta</Badge>.',
        '',
        '<Expandable title="more">Text.</Expandable>',
        '',
        // Named in code, a component is only being written about.
        'Never `<Accordion>` or `<Badge>`.',
        '',
        '```mdx',
        '<Tooltip tip="x">word</Tooltip>',
        '```'
    );
    assert.deepEqual(kinds(parts), [
        `${at(parts, '<AccordionGroup>')}  component: <AccordionGroup> is not used in these docs`,
        `${at(parts, '<Accordion title')}  component: <Accordion> is not used in these docs`,
        `${at(parts, 'A <Tooltip')}  component: <Tooltip> is not used in these docs`,
        `${at(parts, 'A <Tooltip')}  component: <Badge> is not used in these docs`,
        `${at(parts, '<Expandable')}  component: <Expandable> is not used in these docs`,
    ]);

    const keys = page('Opening.').replace(
        'keywords: ["fixture"]',
        'icon: "bolt"\ntag: "NEW"'
    );
    assert.deepEqual(kinds(keys), [
        'docs/faq.mdx:1  frontmatter: no keywords',
        'docs/faq.mdx:5  frontmatter: icon is not used in these docs',
        'docs/faq.mdx:6  frontmatter: tag is not used in these docs',
    ]);
    assert.deepEqual(
        kinds(page('Opening.').replace('sidebarTitle: "Page"\n', '')),
        ['docs/faq.mdx:1  frontmatter: no sidebarTitle']
    );

    const fits = 'x'.repeat(160);
    assert.deepEqual(
        kinds(page('Opening.').replace('A page for one check.', fits)),
        []
    );
    assert.deepEqual(
        kinds(page('Opening.').replace('A page for one check.', `${fits}x`)),
        [
            'docs/faq.mdx:4  frontmatter: the description is 161 characters (the limit is 160)',
        ]
    );

    const heading = page('## Starts on a heading', '', 'Text.');
    assert.deepEqual(kinds(heading), [
        `${at(heading, '## Starts')}  opening: the page starts on a heading`,
    ]);
    const table = page(
        "import X from '/snippets/x.mdx';",
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |'
    );
    assert.deepEqual(kinds(table), [
        `${at(table, '| A | B |')}  opening: the page starts on a table`,
    ]);
});

test('pagestandard: every troubleshooting H3 carries an explicit id, and the changelog is exempt', () => {
    const mdx = page(
        'Opening.',
        '',
        '## In the browser',
        '',
        '### Link invalid {#link-invalid}',
        '',
        'Text.',
        '',
        '### Offline',
        '',
        'Text.'
    );
    const r = only(
        'pagestandard',
        small({ 'docs/troubleshooting.mdx': mdx, 'docs/faq.mdx': mdx })
    );
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(r.hard, [
        `HARD  pagestandard  docs/troubleshooting.mdx:${lineOf(mdx, '### Offline')}  id: a troubleshooting H3 has no explicit {#id}`,
    ]);

    const log = [
        '---',
        'title: "Changelog"',
        'description: "Releases."',
        'icon: "clock"',
        '---',
        '',
        '## Starts on a heading',
        '',
        '<Note>Old.</Note>',
        '',
    ].join('\n');
    assert.deepEqual(
        only('pagestandard', small({ 'docs/changelog.mdx': log })).hard,
        []
    );
});

const GLOSSARY = page(
    'Words these docs use.',
    '',
    '## Words you see in Floe {#words-you-see-in-floe}',
    '',
    '### room code {#room-code}',
    '',
    'The short phrase that stands for a room.',
    '',
    '### drop {#drop}',
    '',
    'One sending through a request link.',
    '',
    '## Technical terms',
    '',
    '### relay / TURN relay {#relay}',
    '',
    'A server that carries the encrypted stream.',
    '',
    '### signaling server',
    '',
    'The server that introduces two devices.',
    '',
    '### PATH {#path}',
    '',
    'The folders a terminal searches.'
);

test('glossary: one info line and nothing else while docs/glossary.mdx does not exist', () => {
    const r = only(
        'glossary',
        small({ 'docs/faq.mdx': page('A room code and a relay.') })
    );
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.notes, []);
    assert.deepEqual(r.info, [
        'info  glossary  docs/glossary.mdx  the page does not exist, so there is nothing to check',
    ]);
});

test('glossary: a term used on a user page with no link to its entry is one NOTE per page and term', () => {
    const faq = page(
        'Share the Room Code with the other person.',
        '',
        'The room code expires. A TURN relay may carry the stream, and the relays differ.',
        '',
        'The `signaling server` is named in code here.',
        '',
        '```text',
        'signaling server',
        '```'
    );
    const linked = page(
        'A [relay](/glossary#relay) carries the stream when a direct path fails.',
        '',
        'The signaling server only introduces the two devices.'
    );
    const r = only(
        'glossary',
        small({
            'docs/glossary.mdx': GLOSSARY,
            'docs/faq.mdx': faq,
            'docs/web-app/sending.mdx': linked,
            // Not a user page: never listed.
            'docs/cli/send.mdx': page('The room code is printed first.'),
        })
    );
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.notes, [
        `NOTE  glossary  docs/faq.mdx:${lineOf(faq, 'Share the Room Code')}  "room code" is used and the page has no link to /glossary#room-code`,
        `NOTE  glossary  docs/faq.mdx:${lineOf(faq, 'The room code expires')}  "TURN relay" is used and the page has no link to /glossary#relay`,
        `NOTE  glossary  docs/web-app/sending.mdx:${lineOf(linked, 'The signaling server')}  "signaling server" is used and the page has no link to /glossary#signaling-server`,
    ]);
});

test('glossary: a group heading is not a term, a capital is matched as written, and an everyday word is left to the writer', () => {
    const faq = page(
        'These are the words you see in Floe, and a few technical terms.',
        '',
        'Put the folder on your PATH. A file keeps its path, and a long path is refused.',
        '',
        'Drop the files on the page. A drop through a request link is one sending.'
    );
    const lower = page('The path to a file is not the list a terminal searches.');
    const r = only(
        'glossary',
        small({
            'docs/glossary.mdx': GLOSSARY,
            'docs/faq.mdx': faq,
            'docs/troubleshooting.mdx': lower,
        })
    );
    assert.equal(r.status, 0, r.out);
    // Only PATH as the glossary spells it. Not the two group headings, not
    // "path" in lower case on either page, and not "drop" as verb or noun.
    assert.deepEqual(r.notes, [
        `NOTE  glossary  docs/faq.mdx:${lineOf(faq, 'Put the folder on your PATH')}  "PATH" is used and the page has no link to /glossary#path`,
    ]);
    assert.ok(
        r.info.includes(
            'info  glossary  docs/glossary.mdx  not checked, because a script cannot tell the term from the everyday word: drop'
        ),
        r.out
    );
});

test('captures: a shot with no strings is summarized, and a recorded string must still be in one of its sources', () => {
    const manifest = (shots) => `${JSON.stringify({ shots }, null, 2)}\n`;
    const REFS = '.claude/skills/docs-verify/references';
    const r = only(
        'captures',
        small({
            'docs/faq.mdx': page('Pictures.'),
            'docs/images/web/capture-manifest.json': manifest([
                {
                    name: '01-send.png',
                    strings: [
                        'Create secure link ({n} files)',
                        'Network relay fallback',
                        'A label that was renamed',
                    ],
                    sources: [
                        'client/components/Card.tsx',
                        'client/lib/copy.ts',
                    ],
                },
                { name: '02-share.png' },
                { name: '03-wait.png', strings: [] },
                { name: '04-loose.png', strings: ['Copy'] },
            ]),
            'docs/images/desktop/capture-manifest.json': manifest([
                {
                    name: 'receive.png',
                    strings: ['Request link', 'Save to'],
                    sources: ['desktop/frontend/src/App.tsx'],
                },
            ]),
            'client/components/Card.tsx':
                '<button>Create secure link ({count} files)</button>\n',
            'client/lib/copy.ts':
                "export const RELAY = 'Network relay fallback';\n",
            // main has both words; the released app has only the first.
            'desktop/frontend/src/App.tsx':
                '<b>Request link</b><b>Save to</b>\n',
            [`${REFS}/released-strings.json`]: `${JSON.stringify({ refs: { cli: 'v1.11.0', desktop: 'desktop-v0.3.0' }, cli: {}, desktop: { 'desktop/frontend/src/App.tsx': ['Request link'] } })}\n`,
        })
    );
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(r.hard, [
        'HARD  captures  docs/images/desktop/capture-manifest.json  receive.png: \u201cSave to\u201d is not in the snapshot of desktop-v0.3.0 for desktop/frontend/src/App.tsx',
        'HARD  captures  docs/images/web/capture-manifest.json  01-send.png: \u201cA label that was renamed\u201d is in none of client/components/Card.tsx, client/lib/copy.ts',
        'HARD  captures  docs/images/web/capture-manifest.json  04-loose.png: strings are recorded with no sources to hold them to',
        'HARD  captures  docs/images/web/capture-manifest.json  2 of 4 shots record no strings: 02-share.png, 03-wait.png',
    ]);
});

// The baseline test copies SURFACES and nothing else. A row or a picture that
// names a file outside them would be reported in the copy and not in the
// repository, and the two runs would stop being the same run.
test('every file the messages and captures checks read from the working tree is inside SURFACES', () => {
    const inside = (path) =>
        SURFACES.some((s) => path === s || path.startsWith(`${s}/`));
    const refs = join(REPO, '.claude', 'skills', 'docs-verify', 'references');
    assert.ok(inside('.claude/skills/docs-verify/references/messages.json'));
    const outside = [];
    if (existsSync(join(refs, 'messages.json'))) {
        for (const row of JSON.parse(
            readFileSync(join(refs, 'messages.json'), 'utf8')
        ))
            if (!heldToRelease(row) && !inside(row.source))
                outside.push(row.source);
    }
    const images = join(REPO, 'docs', 'images');
    for (const dir of existsSync(images) ? readdirSync(images) : []) {
        const file = join(images, dir, 'capture-manifest.json');
        if (RELEASED_SURFACES.includes(dir) || !existsSync(file)) continue;
        for (const shot of JSON.parse(readFileSync(file, 'utf8')).shots || [])
            for (const source of shot.sources || [])
                if (!inside(source)) outside.push(source);
    }
    assert.deepEqual([...new Set(outside)], []);
});

test('parseCompose reads a nested default whole, and the default inside it too', async () => {
    const { parseCompose } = await import('./docs-check.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'dc-compose-'));
    try {
        writeFileSync(
            join(dir, 'docker-compose.yml'),
            [
                'services:',
                '  server:',
                '    environment:',
                '      CLIENT_URL: ${CLIENT_URL:-http://localhost:${CLIENT_PORT:-3000}}',
                '      SOCKET_URL: ${NEXT_PUBLIC_SOCKET_URL-http://localhost:${PORT:-3001}}${NEEDS_CHECK+}',
                '',
            ].join('\n')
        );
        const { present, defaults } = parseCompose(dir);
        assert.equal(defaults.get('CLIENT_URL').value, 'http://localhost:${CLIENT_PORT:-3000}');
        assert.equal(defaults.get('CLIENT_PORT').value, '3000');
        assert.equal(defaults.get('PORT').value, '3001');
        for (const k of ['CLIENT_URL', 'CLIENT_PORT', 'NEXT_PUBLIC_SOCKET_URL', 'PORT', 'SOCKET_URL'])
            assert.ok(present.has(k), k);
        // "-" without the colon is not a default the checks compare.
        assert.equal(defaults.has('NEXT_PUBLIC_SOCKET_URL'), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
