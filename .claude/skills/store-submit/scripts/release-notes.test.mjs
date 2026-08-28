/**
 * Fixture tests for release-notes.mjs.
 *
 * Each test builds a temp root whose docs/changelog.mdx is the repo's own
 * file (line endings forced to CRLF, as the working copy is under
 * core.autocrlf=true) with one synthetic entry, desktop-v9.9.9, inserted
 * before the first real <Update>. The synthetic entry is what every test
 * renders, so no shipped number is pinned and a real entry changing shape
 * cannot break these; the real file is still underneath so the search has
 * to find the label among forty entries. One injected defect per test, and
 * the assertion is on the exit code and the printed line.
 *
 * Run: node --test .claude/skills/store-submit/scripts/release-notes.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { check, djb2, findEntry, parseArgs, render } from './release-notes.mjs';

const SCRIPT = fileURLToPath(import.meta.url).replace(/\.test\.mjs$/, '.mjs');
const REPO = resolve(dirname(SCRIPT), '..', '..', '..', '..');
const SOURCE = readFileSync(join(REPO, 'docs/changelog.mdx'), 'utf8').replace(
    /\r?\n/g,
    '\n'
);
const TAG = 'desktop-v9.9.9';
const HEAD = `<Update label="${TAG}" description="2026-01-01" tags={["Desktop"]}>`;
const BODY = [
    '  **A synthetic headline for the release-notes test**',
    '',
    '  - First bullet with `floe receive` and **bold** text.',
    '  - Second bullet with *italic*, an &amp; entity, and a &quot;quoted&quot; word.',
];
const EXPECTED = [
    'Floe Desktop 9.9.9',
    '',
    'A synthetic headline for the release-notes test',
    '',
    '- First bullet with floe receive and bold text.',
    '- Second bullet with italic, an & entity, and a "quoted" word.',
].join('\n');
const EM_DASH = String.fromCharCode(0x2014);
const made = [];

function fresh() {
    const dir = mkdtempSync(join(tmpdir(), 'release-notes-'));
    made.push(dir);
    return dir;
}

after(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
});

// The contract allows one Unreleased entry between a merge and its tag, and
// floe-release step 6 (when this script runs) is exactly that window, so
// the real file may carry one. The fixture strips it: a test that wants an
// Unreleased entry inserts its own through `extra`.
const UNRELEASED =
    /^[ \t]*<Update label="Unreleased"[^\n]*\n[\s\S]*?^[ \t]*<\/Update>[ \t]*\n(?:[ \t]*\n)?/gm;

// A root whose changelog carries the synthetic entry (and optionally more
// entries) before the first real one.
function fixture({ head = HEAD, body = BODY, extra = [], lf = false } = {}) {
    const root = fresh();
    mkdirSync(join(root, 'docs'), { recursive: true });
    const eol = lf ? '\n' : '\r\n';
    const source = SOURCE.replace(UNRELEASED, '');
    assert.doesNotMatch(source, /label="Unreleased"/);
    const at = source.indexOf('<Update label=');
    assert.ok(at > 0, 'the repo changelog has an <Update label= line');
    const entries = [[head, ...body, '</Update>'], ...extra];
    const inserted = entries.map((e) => `${e.join('\n')}\n\n`).join('');
    const text = source.slice(0, at) + inserted + source.slice(at);
    writeFileSync(join(root, 'docs/changelog.mdx'), text.replace(/\n/g, eol));
    return root;
}

function run(args) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
        encoding: 'utf8',
    });
    return { status: r.status, out: r.stdout + r.stderr, stdout: r.stdout };
}

const forTag = (root, tag = TAG) => ['--desktop', tag, '--root', root];

function textBlock(out) {
    const m = out.match(
        /^--- text \((\d+) chars, djb2 ([0-9a-f]{8})\) ---\n([\s\S]*?)\n--- end ---$/m
    );
    assert.ok(m, out);
    return { len: Number(m[1]), djb2: m[2], text: m[3] };
}

test('the synthetic entry renders to plain text with a fingerprint and a json line that round-trips', () => {
    const r = run(forTag(fixture()));
    assert.equal(r.status, 0, r.out);
    const block = textBlock(r.out);
    assert.equal(block.text, EXPECTED);
    assert.equal(block.len, EXPECTED.length);
    assert.equal(block.djb2, djb2(EXPECTED));
    const json = r.out.match(/^json: (.*)$/m);
    assert.ok(json, r.out);
    assert.equal(JSON.parse(json[1]), EXPECTED);
    assert.match(
        r.out,
        new RegExp(
            `^release-notes: ${TAG}: 0 hard, 0 notes, ${EXPECTED.length}/1500 chars$`,
            'm'
        )
    );
    assert.doesNotMatch(r.out, /^(HARD|NOTE)/m);
});

test('--json carries the text, its length, the fingerprint and the exit code', () => {
    const r = run([...forTag(fixture()), '--json']);
    assert.equal(r.status, 0, r.out);
    const report = JSON.parse(r.stdout);
    assert.equal(report.tag, TAG);
    assert.equal(report.text, EXPECTED);
    assert.equal(report.len, EXPECTED.length);
    assert.equal(report.djb2, djb2(EXPECTED));
    assert.deepEqual(report.hard, []);
    assert.deepEqual(report.notes, []);
    assert.deepEqual(report.urls, []);
    assert.equal(report.out, null);
    assert.equal(report.exitCode, 0);
});

test('--out writes the text with LF, no BOM and one trailing newline', () => {
    const out = join(fresh(), 'whats-new.txt');
    const r = run([...forTag(fixture()), '--out', out]);
    assert.equal(r.status, 0, r.out);
    const bytes = readFileSync(out);
    assert.notEqual(bytes[0], 0xef, 'no BOM');
    assert.equal(bytes.toString('utf8'), `${EXPECTED}\n`);
    assert.ok(!bytes.includes('\r'), 'no CR');
    assert.match(r.out, new RegExp(`, written to .*whats-new\\.txt$`, 'm'));
});

test('a label that is not in the changelog is HARD entry', () => {
    const r = run(forTag(fixture(), 'desktop-v8.8.8'));
    assert.equal(r.status, 1, r.out);
    assert.match(
        r.out,
        /^HARD  entry  no <Update label="desktop-v8\.8\.8"> in docs\/changelog\.mdx$/m
    );
    assert.doesNotMatch(r.out, /^--- text/m);
    assert.match(r.out, /^release-notes: desktop-v8\.8\.8: 1 hard, 0 notes/m);
});

test('a missing label while an Unreleased entry exists says to relabel it', () => {
    const root = fixture({
        extra: [
            [
                '<Update label="Unreleased" tags={["Desktop"]}>',
                '  **Not yet tagged**',
                '</Update>',
            ],
        ],
    });
    const r = run(forTag(root, 'desktop-v8.8.8'));
    assert.equal(r.status, 1, r.out);
    assert.match(
        r.out,
        /^HARD  entry  .*an Unreleased entry exists, relabel it first \(floe-release step 6\)$/m
    );
});

test('a body past 1,500 characters is HARD length with a per-line list', () => {
    const long = `  - ${'A long bullet that keeps going. '.repeat(50).trim()}`;
    const r = run(forTag(fixture({ body: [...BODY, long] })));
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /^HARD  length  \d+ chars, 1500 allowed; trim \d+$/m);
    const list = r.out.match(/^ {6} *\d+  \d+: /gm);
    assert.ok(list && list.length === EXPECTED.split('\n').length + 1, r.out);
});

test('an em dash in the rendered text is HARD dashes', () => {
    const r = run(
        forTag(
            fixture({ body: [...BODY, `  - A bullet ${EM_DASH} with a dash.`] })
        )
    );
    assert.equal(r.status, 1, r.out);
    assert.match(
        r.out,
        /^HARD  dashes  line 7 has an em or en dash: - A bullet /m
    );
});

test('a link keeps its text, drops its url as NOTE link and flags github.com as NOTE external', () => {
    const r = run(
        forTag(
            fixture({
                body: [
                    ...BODY,
                    '  - See [the release](https://github.com/jannskiee/floe/releases/tag/desktop-v9.9.9) for details.',
                ],
            })
        )
    );
    assert.equal(r.status, 0, r.out);
    const block = textBlock(r.out);
    assert.equal(
        block.text.split('\n').at(-1),
        '- See the release for details.'
    );
    assert.equal(r.out.match(/^NOTE  link  /gm).length, 1);
    assert.match(
        r.out,
        /^NOTE  link  dropped https:\/\/github\.com\/jannskiee\/floe\/releases\/tag\/desktop-v9\.9\.9 \(kept "the release"\)$/m
    );
    // The url is gone from the text, so its phrase is reported on the link.
    assert.equal(r.out.match(/^NOTE  external  /gm).length, 1);
    assert.match(
        r.out,
        /^NOTE  external  "github\.com" in the dropped link https:\/\/github\.com\/jannskiee\/floe\/releases\/tag\/desktop-v9\.9\.9 \(kept "the release"\)$/m
    );
    const r2 = run(
        forTag(
            fixture({
                body: [...BODY, '  - Also on winget and as a GitHub release.'],
            })
        )
    );
    assert.equal(r2.status, 0, r2.out);
    assert.equal(r2.out.match(/^NOTE  external  /gm).length, 2);
    assert.match(r2.out, /^NOTE  external  "winget" on line 7: /m);
    assert.match(r2.out, /^NOTE  external  "GitHub release" on line 7: /m);
});

test('a link whose text is a code span reports the code in NOTE link, not the placeholder', () => {
    const r = run(
        forTag(
            fixture({
                body: [
                    ...BODY,
                    '  - Run [`floe update`](/docs/cli) to upgrade.',
                ],
            })
        )
    );
    assert.equal(r.status, 0, r.out);
    assert.match(
        r.out,
        /^NOTE  link  dropped \/docs\/cli \(kept "floe update"\)$/m
    );
    assert.equal(
        textBlock(r.out).text.split('\n').at(-1),
        '- Run floe update to upgrade.'
    );
    assert.deepEqual(render(['**H**', '', '- [`a b`](x) and `c`']).urls, [
        { text: 'a b', url: 'x' },
    ]);
});

test('a literal < or > that is not a tag is not residue; an inline HTML tag still is', () => {
    const r = run(
        forTag(
            fixture({
                body: [
                    ...BODY,
                    '  - The characters `< > : " | ? *` become underscores, 2 &lt; 3 -> ok.',
                ],
            })
        )
    );
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /^HARD/m);
    assert.equal(
        textBlock(r.out).text.split('\n').at(-1),
        '- The characters < > : " | ? * become underscores, 2 < 3 -> ok.'
    );
    const r2 = run(
        forTag(fixture({ body: [...BODY, '  - Press <kbd>x</kbd> to go.'] }))
    );
    assert.equal(r2.status, 1, r2.out);
    assert.match(
        r2.out,
        /^HARD  residue  line 7 keeps "<kbd>": - Press <kbd>x<\/kbd> to go\.$/m
    );
    // The hand-written path sees the same rule.
    assert.deepEqual(check('T\n\n2 < 3 -> ok, < > : " | ? *').hard, []);
    assert.deepEqual(
        check('T\n\n<kbd>x</kbd>').hard.map((h) => h.check),
        ['residue']
    );
    assert.deepEqual(
        check('T\n\n</Update>').hard.map((h) => h.check),
        ['residue']
    );
});

test('the shipped desktop-v0.2.6 entry, whose code span holds < > : " | ? *, has no residue finding', () => {
    // The entry is immutable per the changelog contract, so the repo's own
    // file is read. It is over the Store limit (1,879 chars on 2026-08-28),
    // so length is the one HARD it may carry.
    const r = run(['--desktop', 'desktop-v0.2.6', '--root', REPO, '--json']);
    const report = JSON.parse(r.stdout);
    assert.ok(
        report.text.includes('The characters < > : " | ? * become underscores'),
        report.text
    );
    assert.deepEqual(
        report.hard.filter((h) => h.check !== 'length'),
        []
    );
});

test('nothing under the title line is HARD empty', () => {
    const blank = join(fresh(), 'blank.txt');
    writeFileSync(blank, ' \r\n\t\r\n');
    const r = run(['--check', blank]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /^HARD  empty  nothing to paste$/m);
    // A hand-written file is judged whole: one line is a valid paste (the
    // rehearsal marker is one line).
    const oneLine = join(fresh(), 'marker.txt');
    writeFileSync(oneLine, 'REHEARSAL, delete this draft.\n');
    const r2 = run(['--check', oneLine]);
    assert.equal(r2.status, 0, r2.out);
    assert.doesNotMatch(r2.out, /^HARD  empty/m);
    const r3 = run(forTag(fixture({ body: [] })));
    assert.equal(r3.status, 1, r3.out);
    assert.match(r3.out, /^HARD  empty  nothing to paste$/m);
    assert.equal(textBlock(r3.out).text, 'Floe Desktop 9.9.9');
    // A missing entry is reported once, as HARD entry.
    const r4 = run(forTag(fixture(), 'desktop-v8.8.8'));
    assert.doesNotMatch(r4.out, /^HARD  empty/m);
});

test('a body whose first line is not a bold headline is NOTE headline', () => {
    const r = run(
        forTag(
            fixture({
                body: [
                    '  - A bullet where the headline should be.',
                    '  - Another bullet.',
                ],
            })
        )
    );
    assert.equal(r.status, 0, r.out);
    assert.match(
        r.out,
        /^NOTE  headline  first line is not a bold headline \(changelog contract rule 4\)$/m
    );
    assert.equal(r.out.match(/^NOTE  headline/gm).length, 1);
    assert.doesNotMatch(run(forTag(fixture())).out, /^NOTE  headline/m);
});

test('a JSX line inside the entry is HARD mdx, never dropped silently', () => {
    const r = run(
        forTag(
            fixture({
                body: [
                    ...BODY,
                    '  <Note>Something the renderer does not know.</Note>',
                ],
            })
        )
    );
    assert.equal(r.status, 1, r.out);
    assert.match(
        r.out,
        /^HARD  mdx  unsupported MDX inside the entry: <Note>Something the renderer does not know\.<\/Note>$/m
    );
    assert.equal(textBlock(r.out).text, EXPECTED);
});

test('an entry whose first tag is not Desktop is NOTE tags', () => {
    const r = run(
        forTag(
            fixture({
                head: `<Update label="${TAG}" description="2026-01-01" tags={["CLI", "Desktop"]}>`,
            })
        )
    );
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /^NOTE  tags  first tag is "CLI", expected "Desktop"/m);
});

test('a bullet about another surface is NOTE surface', () => {
    const r = run(
        forTag(
            fixture({
                body: [...BODY, '  - Web app: something for the browser.'],
            })
        )
    );
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /^NOTE  surface  line 7 is about Web app/m);
});

test('--check validates a hand-written file and prints the fingerprint the helper computes', () => {
    const file = join(fresh(), 'notes.txt');
    const text =
        'Hello from a hand-written file\n\n- one thing\n- another thing';
    writeFileSync(file, `\uFEFF${text.replace(/\n/g, '\r\n')}\r\n`);
    const r = run(['--check', file]);
    assert.equal(r.status, 0, r.out);
    const block = textBlock(r.out);
    assert.equal(block.text, text);
    assert.equal(block.djb2, djb2(text));
    assert.match(
        r.out,
        new RegExp(
            `^release-notes: .*notes\\.txt: 0 hard, 0 notes, ${text.length}/1500 chars$`,
            'm'
        )
    );
    const bad = join(fresh(), 'bad.txt');
    writeFileSync(bad, 'Still **bold** and a `code` span\n');
    const r2 = run(['--check', bad]);
    assert.equal(r2.status, 1, r2.out);
    assert.match(r2.out, /^HARD  residue  line 1 keeps "\*\*"/m);
});

test('usage errors exit 2', () => {
    const root = fixture();
    const file = join(fresh(), 'x.txt');
    writeFileSync(file, 'x\n');
    const cases = [
        ['--desktop', '0.2.8', '--root', root],
        ['--check', file, '--desktop', TAG],
        ['--root', root],
        ['--check', file, '--out', 'y.txt'],
        ['--desktop', TAG, '--root', fresh()],
        ['--desktop', TAG, '--root', root, '--bogus'],
    ];
    for (const args of cases) {
        const r = run(args);
        assert.equal(r.status, 2, `${args.join(' ')}\n${r.out}`);
        assert.match(r.out, /^release-notes: /m);
    }
});

test('--out into a missing directory and --check on a directory are usage errors, not stack traces', () => {
    const root = fixture();
    const out = join(fresh(), 'missing', 'notes.txt');
    const r = run([...forTag(root), '--out', out]);
    assert.equal(r.status, 2, r.out);
    assert.match(
        r.out,
        /^release-notes: --out .*: its directory .* does not exist$/m
    );
    assert.doesNotMatch(r.out, /ENOENT/);
    const dir = fresh();
    const r2 = run([...forTag(root), '--out', dir]);
    assert.equal(r2.status, 2, r2.out);
    assert.match(
        r2.out,
        /^release-notes: --out .* is a directory, not a file$/m
    );
    const r3 = run(['--check', dir]);
    assert.equal(r3.status, 2, r3.out);
    assert.match(
        r3.out,
        /^release-notes: --check .* is a directory, not a file$/m
    );
    assert.doesNotMatch(r3.out, /EISDIR/);
});

test('a CRLF changelog and an LF changelog render the same text and fingerprint', () => {
    const crlf = run(forTag(fixture()));
    const lf = run(forTag(fixture({ lf: true })));
    assert.equal(crlf.status, 0, crlf.out);
    assert.equal(lf.status, 0, lf.out);
    assert.deepEqual(textBlock(crlf.out), textBlock(lf.out));
    assert.equal(crlf.stdout, lf.stdout);
});

test('findEntry, render, check and djb2 as units', () => {
    const entry = findEntry(
        `x\r\n${HEAD}\r\n${BODY.join('\r\n')}\r\n</Update>\r\n`,
        TAG
    );
    assert.equal(entry.line, 2);
    assert.deepEqual(entry.tags, ['Desktop']);
    assert.equal(entry.description, '2026-01-01');
    assert.deepEqual(entry.body, BODY);
    assert.equal(findEntry('nothing here', TAG), null);
    const rendered = render(BODY, 'Floe Desktop 9.9.9');
    assert.equal(rendered.text, EXPECTED);
    assert.deepEqual(rendered.urls, []);
    assert.deepEqual(rendered.mdx, []);
    // A title line first: a text with nothing under it is HARD empty.
    const c = check(`T\n\na ${EM_DASH} b`, { tags: ['Web'] });
    assert.deepEqual(
        c.hard.map((h) => h.check),
        ['dashes']
    );
    assert.deepEqual(
        c.notes.map((n) => n.check),
        ['tags']
    );
    assert.equal(djb2(''), '00001505');
    assert.equal(
        djb2('a'),
        ((Math.imul(5381, 33) + 97) >>> 0).toString(16).padStart(8, '0')
    );
    const a = parseArgs(['--desktop', TAG, '--root', REPO]);
    assert.equal(a.desktop, TAG);
    assert.equal(a.root, REPO);
    assert.throws(() => parseArgs([]), /--desktop/);
    assert.throws(() => parseArgs(['--desktop', 'v1']), /desktop-vX\.Y\.Z/);
});
