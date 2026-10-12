/**
 * Fixture tests for check-version-pins.mjs.
 *
 * The script measures a tree and exits, so every test builds a temp root and
 * runs the script against it with --root. The versions are synthetic
 * (v7.8.9 to v7.9.0, desktop-v0.4.5 to desktop-v0.4.6) and passed through
 * --old-cli and --old-desktop, so no test needs a git tag and no shipped
 * number is pinned here. The base root is green: the few files that must
 * carry the new version do, and nothing carries the old one. Each test adds
 * the lines it is about.
 *
 * The floor tests are written in pairs: a sentence that measures from a
 * version (FLOOR, re-read, never bump) next to a look-alike that shows the
 * version (STALE). The direction that hurts is a real pin read as a floor,
 * because a floor does not fail the run.
 *
 * Run: node --test .claude/skills/floe-release/scripts/check-version-pins.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const SCRIPT = fileURLToPath(import.meta.url).replace(/\.test\.mjs$/, '.mjs');
const OLD_CLI = 'v7.8.9';
const NEW_CLI = 'v7.9.0';
const OLD_DESKTOP = 'desktop-v0.4.5';
const NEW_DESKTOP = 'desktop-v0.4.6';
const made = [];

after(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
});

const BASE = {
    'CLAUDE.md': `A ${NEW_CLI} tag prints floe 7.9.0; the desktop app injects ${NEW_DESKTOP}.\n`,
    '.github/ISSUE_TEMPLATE/bug_report.yml': `      placeholder: ${NEW_DESKTOP} or floe 7.9.0\n`,
    'docs/changelog.mdx': [
        `<Update label="${NEW_DESKTOP}" description="2026-01-01" tags={["Desktop"]}>`,
        '</Update>',
        `<Update label="${NEW_CLI}" description="2026-01-01" tags={["CLI"]}>`,
        '</Update>',
        '',
    ].join('\n'),
    'DESKTOP.md': `Current release: \`${NEW_DESKTOP}\`\n`,
    'desktop/wails.json': '{ "info": { "productVersion": "0.4.6" } }\n',
    'client/lib/desktopRelease.ts':
        "export const DESKTOP_VERSION = '0.4.5';\nexport const DESKTOP_RELEASE_DATE = 'Jan 1, 2026';\n",
};

// A root holding BASE plus `files` (a path to text map; an array is joined
// with LF, and null drops a BASE file).
function fixture(files = {}) {
    const root = mkdtempSync(join(tmpdir(), 'check-version-pins-'));
    made.push(root);
    for (const [rel, body] of Object.entries({ ...BASE, ...files })) {
        if (body === null) continue;
        const abs = join(root, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, Array.isArray(body) ? `${body.join('\n')}\n` : body);
    }
    return root;
}

function run(root, extra = []) {
    const r = spawnSync(
        process.execPath,
        [
            SCRIPT,
            '--cli',
            NEW_CLI,
            '--desktop',
            NEW_DESKTOP,
            '--old-cli',
            OLD_CLI,
            '--old-desktop',
            OLD_DESKTOP,
            '--root',
            root,
            ...extra,
        ],
        { encoding: 'utf8' }
    );
    return { status: r.status, out: r.stdout + r.stderr, stdout: r.stdout };
}

const lines = (out, label) =>
    out.split(/\r?\n/).filter((l) => l.startsWith(`${label} `));

test('--self-test is green and covers the floor fixtures as well as the pin fixtures', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--self-test'], {
        encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(
        r.stdout,
        /^check-version-pins: self-test green \(\d+ fixtures\)$/m
    );
    assert.doesNotMatch(r.stdout, /^FAIL/m);
    // The original pin fixtures still run.
    assert.match(
        r.stdout,
        /^ok {3}cli 1\.10\.1 matches "prints `floe 1\.10\.1`"$/m
    );
    assert.match(r.stdout, /^ok {3}desktop 0\.2\.7 ignores "0\.2\.70"$/m);
    // FR5: and so do floor fixtures, in both directions.
    assert.ok(lines(r.stdout, 'ok   floor').length >= 6, r.stdout);
    assert.ok(lines(r.stdout, 'ok   pin').length >= 6, r.stdout);
});

test('the base root is green with nothing to report', () => {
    const r = run(fixture());
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /: green$/m);
    assert.deepEqual(lines(r.out, 'STALE'), []);
    assert.deepEqual(lines(r.out, 'FLOOR'), []);
});

test('FR5: a sentence that measures from a version is FLOOR, listed apart, and does not fail the run', () => {
    const floors = [
        'Request links need Floe Desktop 0.4.5 or later, and `floe` 7.8.9 or later.',
        // The comparison ends its clause: a comma, a colon, a bracket on
        // either side, a conjunction, a semicolon, the end of the line.
        'A self-hosted web app on version 7.8.9 or earlier, every image so far, shows nothing.',
        '`floe receive` 7.8.9 and earlier: such paths were saved.',
        '`--to` needs `floe` 7.8.9 or later (to get it, see the install page).',
        '(on a self-hosted instance, a client image of 7.8.9 or later). An older sender provides none.',
        'for `floe receive` 7.8.9 or later or Floe Desktop 0.4.5 or later; a browser never does',
        'It needs Floe Desktop 0.4.5 or higher',
        'Since 7.8.9 the server checks the `Origin` of every WebSocket.',
        'words since v7.8.9)',
        'The Store build sends under its own id (since 0.4.5; before that Windows could drop it).',
        '## Upgrading to 7.8.9',
        '### Moving to 7.8.9 {#moving-to-7-8-9}',
        'See [Moving to 7.8.9](/self-hosting/operations#moving-to-7-8-9).',
        'That is what a server older than 7.8.9 does.',
        'It was sent before `floe` 7.8.9 and Floe Desktop 0.4.5.',
        'A `docker-compose.yml` downloaded before 7.8.9 does not pass it.',
        'The rule arrived with server 7.8.9.',
        '**3e - Receiver checks (shipped in v7.8.9 and desktop 0.4.5)**',
        'A server from 7.8.9 onward sends the field.',
        'A sender on versions 7.8.1 to 7.8.9 sends "remove files".',
        'with `floe` 7.8.9 or Floe Desktop 0.4.5, or later, on both sides',
        ' *  docs/desktop/request-links.mdx, which this pointed at through 7.8.9. */',
    ];
    // A blank line after each, so every sentence is its own paragraph and
    // none borrows a word from the next.
    const r = run(
        fixture({ 'docs/floors.mdx': floors.flatMap((l) => [l, '']) })
    );
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(lines(r.out, 'STALE'), [], r.out);
    assert.equal(lines(r.out, 'FLOOR').length, floors.length, r.out);
    assert.match(
        r.out,
        /^FLOOR docs\/floors\.mdx:1 \(v7\.8\.9, desktop-v0\.4\.5\): Request links need /m
    );
    assert.match(
        r.out,
        new RegExp(
            `: green; ${floors.length} floor line\\(s\\) to re-read, never bump$`,
            'm'
        )
    );
});

test('FR5: a real pin stays STALE and fails the run, whatever sits beside it', () => {
    const r = run(
        fixture({
            '.env.docker.example': [
                '# Pin an exact version, for example FLOE_IMAGE_TAG=7.8.9,',
                '# FLOE_IMAGE_TAG=7.8.9',
            ],
            'docker-compose.yml': [
                '# documented as v7.8.9, with a leading v that image tags do not carry.',
            ],
            'docs/install.mdx': [
                'curl -LO https://example.invalid/floe_7.8.9_linux_amd64.tar.gz',
                'Get-FileHash floe-desktop-setup-0.4.5.exe -Algorithm SHA256',
                'prints `Already up to date (7.8.9)` and stops',
                '"ver": "7.8.9"',
            ],
            'desktop/wails.json': '{ "info": { "productVersion": "0.4.5" } }\n',
        })
    );
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(lines(r.out, 'FLOOR'), [], r.out);
    assert.equal(lines(r.out, 'STALE').length, 8, r.out);
    assert.match(r.out, /^STALE \.env\.docker\.example:2 \(v7\.8\.9\): /m);
    assert.match(r.out, /^STALE docker-compose\.yml:1 \(v7\.8\.9\): /m);
    assert.match(
        r.out,
        /^STALE desktop\/wails\.json:1 \(desktop-v0\.4\.5\): /m
    );
    assert.match(
        r.out,
        /^MISSING desktop\/wails\.json: productVersion is '0\.4\.5', want '0\.4\.6'$/m
    );
    assert.match(r.out, /: 9 finding\(s\)$/m);
});

test('FR5: a look-alike is not a floor: the wording has to sit on the version itself', () => {
    const lookalikes = [
        // Floor words elsewhere on the line, a pin where the version is.
        'Since the last release the example reads `floe 7.8.9`.',
        'An older receiver, or later a browser, prints `Peer version: desktop-v0.4.5`.',
        'FLOE_IMAGE_TAG=7.8.9 # or later',
        'Update available: 7.8.8 -> v7.8.9',
        'Download it from the v7.8.9 release page.',
        'Take the compose file from v7.8.9 on GitHub.',
        'Tag v7.8.9 and up to three workflows start.',
        'The CLI sends 7.8.9 to the other side.',
        'Before you tag, set FLOE_IMAGE_TAG=7.8.9 in the example.',
        // One floor and one pin of the same version on one line.
        'Needs 7.8.9 or later, for example FLOE_IMAGE_TAG=7.8.9',
        // One series is a floor, the other is a pin.
        'Floe Desktop 0.4.5 or later prints `floe 7.8.9` here.',
        // A version named alone states a fact about that version.
        'A self-hosted web app on version 7.8.9 ends the line "or remove files."',
        'Version 7.8.9 changed what a self-hosted instance needs.',
    ];
    const r = run(fixture({ 'docs/lookalikes.mdx': lookalikes }));
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(lines(r.out, 'FLOOR'), [], r.out);
    assert.equal(lines(r.out, 'STALE').length, lookalikes.length, r.out);
});

test('Y2-7: a comparison that runs on is not a floor, on its own line or borrowed from the next', () => {
    const pins = [
        // The three a review found classed as floors: real pin shapes.
        'Set `FLOE_IMAGE_TAG=7.8.9` or newer images will be pulled.',
        'The first line reads `floe 7.8.9` and below it the hint names the tag.',
        'Latest: `v7.8.9` (or later, once tagged).',
        // The same three without the code span: the wording alone decides.
        'The example sets the tag to 7.8.9 or newer images will be pulled.',
        'The heading shows 7.8.9 and below it the hint names the tag.',
        'Latest: v7.8.9 (or later, once tagged).',
        // "below" and "above" say where on a page, comma or no comma.
        'The heading shows 7.8.9 and below, the hint names the tag.',
        // A quoted literal: what follows it is the rest of a sentence about
        // it, even when that reads like a comparison that ends its clause.
        'It prints `floe 7.8.9` and later, after an update, the next version.',
        'The box reads `Peer version: desktop-v0.4.5` or later.',
        // True floors the rule gives up, because it cannot tell a verb from
        // a noun: they stay STALE, which costs a re-read and nothing else.
        'A self-hosted web app on version 7.8.9 or earlier shows nothing.',
        '`floe receive` 7.8.9 and earlier tried to save such paths.',
        'Needs 7.8.9 or later versions of the image.',
    ];
    const r = run(
        fixture({
            'docs/pins.mdx': pins,
            'docs/borrowed.mdx': [
                'The example sets the image tag to 7.8.9',
                'or newer images will be pulled instead.',
                '',
                'A self-hosted web app on version 7.8.9 or earlier',
                'shows nothing at all.',
                '',
                'The line break is not the end of a clause, but the end of the',
                'paragraph is: it needs Floe Desktop 0.4.5 or later',
                '',
                'They need the compose file from v7.8.9 or',
                'later, which passes the setting.',
            ],
        })
    );
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(
        lines(r.out, 'FLOOR').map((l) => l.split(' ')[1]),
        ['docs/borrowed.mdx:8', 'docs/borrowed.mdx:10'],
        r.out
    );
    assert.deepEqual(
        lines(r.out, 'STALE')
            .map((l) => l.split(' ')[1])
            .sort(),
        [
            'docs/borrowed.mdx:1',
            'docs/borrowed.mdx:4',
            ...pins.map((_, i) => `docs/pins.mdx:${i + 1}`),
        ].sort(),
        r.out
    );
});

test('Y2-8: nothing inside a fenced code block is a floor, whatever its wording', () => {
    const r = run(
        fixture({
            'docs/fenced.mdx': [
                'Needs `floe` 7.8.9 or later.',
                '',
                '```bash',
                '# needs floe 7.8.9 or later',
                'floe update   # since 7.8.9',
                '```',
                '',
                'After the block, since 7.8.9 it works.',
                '',
                '~~~text',
                'older than 7.8.9',
                '~~~',
            ],
        })
    );
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(
        lines(r.out, 'FLOOR').map((l) => l.split(' ')[1]),
        ['docs/fenced.mdx:1', 'docs/fenced.mdx:8'],
        r.out
    );
    assert.deepEqual(
        lines(r.out, 'STALE').map((l) => l.split(' ')[1]),
        ['docs/fenced.mdx:4', 'docs/fenced.mdx:5', 'docs/fenced.mdx:11'],
        r.out
    );
});

test('FR5: a wrapped sentence keeps its floor across the line break, but never across a block', () => {
    const r = run(
        fixture({
            'docs/wrapped.mdx': [
                'when the sender provides one. A floe CLI older than',
                '7.8.9 or a Floe Desktop older than 0.4.5 provides none.',
                '',
                'They need the `docker-compose.yml` from v7.8.9 or',
                'later, which passes `POLICY_FILE` to the server.',
                '',
                '- **Your `docker-compose.yml`.** A copy from before',
                '  7.8.9 passes neither setting to the server.',
            ],
            'docs/blocks.mdx': [
                'This paragraph ends with the words older than',
                '',
                '7.8.9 is the version the example below shows.',
                '',
                '## Notes on anything older than',
                '7.8.9 opens this paragraph as an example.',
                '',
                '| Image tag | 7.8.9 |',
                '| or later  | text  |',
                '',
                '- The example tag is 7.8.9',
                '- or later ones, listed below.',
            ],
        })
    );
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(
        lines(r.out, 'FLOOR').map((l) => l.split(' ')[1]),
        ['docs/wrapped.mdx:2', 'docs/wrapped.mdx:4', 'docs/wrapped.mdx:8'],
        r.out
    );
    assert.deepEqual(
        lines(r.out, 'STALE').map((l) => l.split(' ')[1]),
        [
            'docs/blocks.mdx:3',
            'docs/blocks.mdx:6',
            'docs/blocks.mdx:8',
            'docs/blocks.mdx:11',
        ],
        r.out
    );
});

test('FR5: --json keeps floors out of findings and out of the exit code', () => {
    const root = fixture({
        'docs/floors.mdx': ['Needs `floe` 7.8.9 or later.'],
    });
    const r = run(root, ['--json']);
    assert.equal(r.status, 0, r.out);
    const report = JSON.parse(r.stdout);
    assert.deepEqual(report.findings.stale, []);
    assert.equal(report.floors.length, 1);
    assert.match(report.floors[0], /^docs\/floors\.mdx:1 \(v7\.8\.9\): Needs /);
    assert.equal(report.exitCode, 0);
    const r2 = run(
        fixture({
            'docs/floors.mdx': ['Needs `floe` 7.8.9 or later.'],
            'docs/pins.mdx': ['prints `floe 7.8.9`'],
        }),
        ['--json']
    );
    assert.equal(r2.status, 1, r2.out);
    const report2 = JSON.parse(r2.stdout);
    assert.equal(report2.findings.stale.length, 1);
    assert.equal(report2.floors.length, 1);
    assert.equal(report2.exitCode, 1);
});

test('FR3: an Unreleased entry in prep is to be renamed in the prep PR, never "at tag time"', () => {
    const r = run(
        fixture({
            'docs/changelog.mdx': [
                '<Update label="Unreleased" tags={["CLI", "Web"]}>',
                '</Update>',
            ],
        })
    );
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /at tag time/);
    assert.match(
        r.out,
        /^WARN docs\/changelog\.mdx: no label="v7\.9\.0" yet; an Unreleased entry exists: rename it in the prep PR, before the tag \(the release body links changelog#v7-9-0 when it is published\), unless none of its bullets ship in v7\.9\.0 \(rule 7\)$/m
    );
    assert.match(
        r.out,
        /^WARN docs\/changelog\.mdx: no label="desktop-v0\.4\.6" yet; .*changelog#desktop-v0-4-6 /m
    );
});

test('FR3: an Unreleased entry left after the tag is a finding that names the prep PR', () => {
    // The CLI series alone: follow-up for a desktop tag reads the tag date
    // from git, which a fixture root does not have.
    const root = fixture({
        'docs/changelog.mdx': [
            '<Update label="Unreleased" tags={["CLI", "Web"]}>',
            '</Update>',
        ],
    });
    const r = spawnSync(
        process.execPath,
        [
            SCRIPT,
            '--cli',
            NEW_CLI,
            '--old-cli',
            OLD_CLI,
            '--phase',
            'follow-up',
            '--root',
            root,
        ],
        { encoding: 'utf8' }
    );
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 1, out);
    assert.match(
        out,
        /^MISSING docs\/changelog\.mdx: an Unreleased label remains and no entry is labeled v7\.9\.0; the rename belonged in the prep PR \(floe-release step 2\), and the release body already links changelog#v7-9-0$/m
    );
});

test('FR6: tracked files under desktop/build are swept; build output and other build folders are not', () => {
    const r = run(
        fixture({
            'desktop/build/README.md': [
                'The installer is floe-desktop-setup-0.4.5.exe.',
            ],
            'desktop/build/bin/notes.txt': ['floe-desktop-setup-0.4.5.exe'],
            'client/build/notes.txt': ['floe 7.8.9'],
            'desktop/frontend/dist/notes.txt': ['floe 7.8.9'],
        })
    );
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(
        lines(r.out, 'STALE').map((l) => l.split(' ')[1]),
        ['desktop/build/README.md:1'],
        r.out
    );
});

test('usage errors exit 2', () => {
    const root = fixture();
    for (const args of [
        [],
        ['--cli', '7.9.0'],
        ['--desktop', 'v0.4.6'],
        ['--cli', NEW_CLI, '--phase', 'later'],
        ['--cli', NEW_CLI, '--bogus'],
    ]) {
        const r = spawnSync(
            process.execPath,
            [SCRIPT, ...args, '--root', root],
            { encoding: 'utf8' }
        );
        assert.equal(r.status, 2, `${args.join(' ')}\n${r.stdout}${r.stderr}`);
        assert.match(r.stderr, /^check-version-pins: /m);
    }
});
