/**
 * Tests for the message index: the matcher (message-match.mjs), the seed that
 * builds references/messages.json from an audit (messages-seed.mjs), the
 * snapshot of the released apps (released-strings.mjs), the page generator
 * (messages-index.mjs) and the `messages` check in docs-check.mjs.
 *
 * Every tree here is built by the test in a temp directory. Nothing reads the
 * repository's own messages.json, docs or source, so a product change cannot
 * move a result; the repository's own data is covered by the baseline test in
 * docs-check.test.mjs, which runs `all` over a copy of the real tree.
 *
 * Run: node --test .claude/skills/docs-verify/scripts/messages-index.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { headingSlugs } from './docs-check.mjs';
import {
    findText,
    haystack,
    staticFragments,
    textOccurs,
} from './message-match.mjs';
import { renderIndex } from './messages-index.mjs';
import {
    carryOver,
    matchText,
    resolveAnchor,
    seedRows,
    sourcePaths,
} from './messages-seed.mjs';
import { buildSnapshot } from './released-strings.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, 'docs-check.mjs');
const INDEX = join(HERE, 'messages-index.mjs');
const made = [];

after(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
});

// A tree with one docs page and whatever else the test names, as
// { 'relative/path': 'content' }. The real path, because the suite's temp
// directory is an 8.3 short name on the Windows runner and the script
// resolves its root.
function tree(files) {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'messages-')));
    made.push(root);
    const all = {
        'docs/docs.json': '{"navigation":{"pages":["troubleshooting"]}}\n',
        'docs/troubleshooting.mdx': [
            '---',
            'title: "Troubleshooting"',
            'sidebarTitle: "Troubleshooting"',
            'description: "What each message means."',
            'keywords: ["errors"]',
            '---',
            '',
            'Find the message you saw.',
            '',
            '### Link invalid {#link-invalid}',
            '',
            'The link is incomplete.',
            '',
            '### Could not read a file',
            '',
            'The file moved.',
            '',
        ].join('\n'),
        ...files,
    };
    for (const [path, content] of Object.entries(all)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    }
    return root;
}

function check(root, which = 'messages') {
    const r = spawnSync(process.execPath, [CHECK, which, '--root', root], {
        encoding: 'utf8',
    });
    return {
        status: r.status,
        out: r.stdout + r.stderr,
        lines: (r.stdout + r.stderr).split(/\r?\n/),
    };
}

const REFS = '.claude/skills/docs-verify/references';
const json = (value) => `${JSON.stringify(value, null, 4)}\n`;
const row = (over) => ({
    surface: 'web',
    text: 'Link Invalid',
    source: 'client/components/Card.tsx',
    anchor: '/troubleshooting#link-invalid',
    why_no_home: null,
    ...over,
});

// The docs pages a seed resolves anchors against, in the shape docs-check
// keeps them.
function pagesOf(map) {
    const pages = new Map();
    for (const [page, mdx] of Object.entries(map))
        pages.set(page, { headings: headingSlugs(mdx), fm: {} });
    return pages;
}

// ---------------------------------------------------------------------------
// The matcher
// ---------------------------------------------------------------------------

test('a message is found the way its source types it: joined literals, wrapped JSX, escapes and entities', () => {
    const hay = haystack(
        [
            "const A = 'This link is incomplete, ' +",
            "    'already in use, or locked.';",
            'const B = "The file \\"report.pdf\\" could not be read";',
            '<p>',
            '    Floe sets no size limit,',
            "    but a receiving browser can&apos;t hold everything.{' '}",
            '    <a>Learn more</a>',
            '</p>',
        ].join('\r\n')
    );
    assert.ok(
        findText(hay, 'This link is incomplete, already in use, or locked.') >=
            0
    );
    assert.ok(findText(hay, 'The file "report.pdf" could not be read') >= 0);
    assert.ok(
        findText(
            hay,
            "Floe sets no size limit, but a receiving browser can't hold everything."
        ) >= 0
    );
    // A typed apostrophe in the text finds the straight one in the source.
    assert.ok(
        findText(hay, 'a receiving browser can\u2019t hold everything.') >= 0
    );
});

test('a short message must be a whole word in its source', () => {
    const hay = haystack("onSend(); label = 'Sending'; title = 'Send';");
    assert.ok(findText(hay, 'Send') >= 0);
    assert.equal(
        findText(haystack("onSend(); label = 'Sending';"), 'Send'),
        -1
    );
});

test('static fragments: placeholders, an error that wraps another, and a sentence end are the joints', () => {
    assert.deepEqual(
        staticFragments('Could not read "{name}". It may have been moved.'),
        ['Could not read', 'It may have been moved.']
    );
    assert.deepEqual(
        staticFragments('error sending {name}: failed to send chunk: {cause}'),
        ['error sending', 'failed to send chunk']
    );
    // A JSON body is not a placeholder: a letter has to follow the brace.
    assert.deepEqual(staticFragments('{ "error": "Too many requests" }'), [
        '{ "error',
        'Too many requests" }',
    ]);
});

test('a text that is not typed whole passes on two parts of 8 characters or one of 20, and on nothing less', () => {
    const hay = haystack(
        'fmt.Errorf("connection closed after %d of %d files", a, b); fmt.Errorf("cannot walk %s: %w", dir, err)'
    );
    // Two parts of eight or more, and one such part alone.
    const two = haystack('`Sent ${n} files to ${peer} just now`');
    assert.ok(textOccurs('Sent {n} files to {peer} just now', two));
    assert.equal(textOccurs('Sent {n} files to {peer}', two), false);
    // One part of twenty or more.
    assert.ok(
        textOccurs('Error: connection closed after {n} of {m} files', hay)
    );
    // "cannot walk" is 11 characters and the only part: not enough.
    assert.equal(textOccurs('cannot walk {folder}: {cause}', hay), false);
    // Whole text, any length.
    assert.ok(textOccurs('cannot walk', hay));
});

// ---------------------------------------------------------------------------
// The seed
// ---------------------------------------------------------------------------

test('source paths are read out of an audit note, in order, and a secrets file is never one', () => {
    const files = new Set([
        'client/lib/a.ts',
        'cli/cmd/floe/send.go',
        'server/.env',
        'server/Dockerfile',
    ]);
    const isFile = (p) => files.has(p);
    assert.deepEqual(
        sourcePaths(
            'client/lib/a.ts:12-14 and :30 (typed twice); cli/cmd/floe/send.go:142; client/lib/gone.ts:1',
            isFile
        ),
        ['client/lib/a.ts', 'cli/cmd/floe/send.go']
    );
    assert.deepEqual(
        sourcePaths('server/.env:3; server/Dockerfile:31-32', isFile),
        ['server/Dockerfile']
    );
});

test('documented_at resolves to an anchor that exists, in every form the audit wrote', () => {
    const pages = pagesOf({
        troubleshooting:
            '### Link invalid {#link-invalid}\n\n### Could not read a file\n\n### Says "hello"\n',
        'web-app/sending': '## Watch the connection\n',
        changelog: '<Update label="v1.11.0" description="2026-10-09">\n',
    });
    const anchor = (d) => resolveAnchor(d, pages);
    assert.deepEqual(anchor('/troubleshooting#link-invalid'), {
        anchor: '/troubleshooting#link-invalid',
        kind: 'anchor',
    });
    assert.equal(
        anchor('docs/troubleshooting.mdx#could-not-read-a-file (described)')
            .anchor,
        '/troubleshooting#could-not-read-a-file'
    );
    // The first fragment that exists wins, and a bare one belongs to the last page named.
    assert.equal(
        anchor('troubleshooting.mdx#gone, #link-invalid').anchor,
        '/troubleshooting#link-invalid'
    );
    assert.equal(
        anchor(
            '/web-app/sending (Watch the connection); nowhere in troubleshooting'
        ).anchor,
        '/web-app/sending#watch-the-connection'
    );
    // "nowhere" is an answer, not a failure to resolve, whatever follows it.
    assert.deepEqual(anchor('nowhere'), { anchor: null, kind: 'nowhere' });
    assert.deepEqual(
        anchor(
            'nowhere for the CLI (the browser form is at /troubleshooting#link-invalid)'
        ),
        { anchor: null, kind: 'nowhere' }
    );
    // A fragment that is not on the page, and a heading Mintlify gives an id no link can rely on.
    assert.deepEqual(anchor('/troubleshooting#no-such-heading'), {
        anchor: null,
        kind: 'unresolved',
    });
    assert.deepEqual(anchor('/troubleshooting#says-hello'), {
        anchor: null,
        kind: 'unresolved',
    });
    assert.deepEqual(anchor('/no-such-page#x'), {
        anchor: null,
        kind: 'unresolved',
    });
    // A page with no heading named is kept as the page.
    assert.deepEqual(anchor('/web-app/sending'), {
        anchor: '/web-app/sending',
        kind: 'page',
    });
    // The changelog records a release; it explains no message.
    assert.deepEqual(anchor('changelog.mdx only'), {
        anchor: null,
        kind: 'unresolved',
    });
});

test('matchText: verbatim, a note the auditor added, a list, placeholders, and no match', () => {
    const sources = [
        {
            path: 'cli/engine/code/client.go',
            hay: haystack(
                [
                    'return fmt.Errorf("code %q not found or expired (codes expire after 10 minutes)", code)',
                    'return fmt.Errorf("server returned %d when resolving code", status)',
                    'const lineUsed = "This link has already been used."',
                    'title = "Keep open"',
                    'other = "Close"',
                ].join('\n')
            ),
        },
    ];
    const one = (text) => matchText(text, sources, 'cli');

    // Verbatim, and the two spaces a CLI line starts with are not part of it.
    assert.deepEqual(one('  This link has already been used.').matched, [
        {
            text: 'This link has already been used.',
            source: 'cli/engine/code/client.go',
            how: 'verbatim',
        },
    ]);
    // What the auditor added in parentheses goes; what the source types in parentheses stays.
    assert.equal(one('Keep open (dialog button)').matched[0].text, 'Keep open');
    assert.equal(
        one(
            'Error: could not resolve "<input>": code "<input>" not found or expired (codes expire after 10 minutes)'
        ).matched[0].text,
        'Error: could not resolve "{input}": code "{input}" not found or expired (codes expire after 10 minutes)'
    );
    // An example number in a part the source does not type as written becomes {n}.
    const built = one('server returned 429 when resolving code').matched[0];
    assert.equal(built.text, 'server returned {n} when resolving code');
    assert.equal(built.how, 'fragments');
    // A list is one row per item, and an item that is not in the source is reported, not kept.
    const list = one(
        'Keep open / Close / Never typed anywhere (dialog buttons)'
    );
    assert.deepEqual(
        list.matched.map((m) => m.text),
        ['Keep open', 'Close']
    );
    assert.deepEqual(list.missed, ['Never typed anywhere (dialog buttons)']);
    // Nothing of it is in the source.
    assert.deepEqual(one('A sentence the source does not have.'), {
        matched: [],
        missed: ['A sentence the source does not have.'],
    });
    // One short part is not a match (the 8 and 20 rule).
    assert.deepEqual(one('expired {when}').matched, []);
});

test('seedRows: a duplicate is one row, an unmatched row is left out and reported, a stale anchor is listed', () => {
    const files = {
        'client/lib/copy.ts':
            'export const A = \'Link Invalid\';\nexport const B = `Could not read "${file.name}". It may have been moved, renamed, or deleted.`;\n',
        'cli/cmd/floe/send.go': 'fmt.Println("  Waiting for peer...")\n',
    };
    const pages = pagesOf({
        troubleshooting:
            '### Link invalid {#link-invalid}\n\n### Could not read a file\n',
    });
    const audit = [
        // The same message from two auditors: the row that names a real anchor wins.
        {
            file: 'A1.json',
            surface: 'web',
            text: 'Link Invalid',
            source: 'client/lib/copy.ts:1 (card title)',
            documented_at: 'nowhere',
        },
        {
            file: 'A8a.json',
            surface: 'web',
            text: 'Link Invalid',
            source: 'client/lib/copy.ts:1',
            documented_at: '/troubleshooting#link-invalid',
        },
        // Built from parts: the audit's <name> becomes a placeholder.
        {
            file: 'A1.json',
            surface: 'web',
            text: 'Could not read "<name>". It may have been moved, renamed, or deleted.',
            source: 'client/lib/copy.ts:2',
            documented_at: 'docs/troubleshooting.mdx#could-not-read-a-file',
        },
        // Verbatim, with an anchor that is gone.
        {
            file: 'A4.json',
            surface: 'cli',
            text: '  Waiting for peer...',
            source: 'cli/cmd/floe/send.go:145',
            documented_at: 'docs/cli/send.mdx#output',
        },
        // Not in its source.
        {
            file: 'A4.json',
            surface: 'cli',
            text: 'A line nobody prints',
            source: 'cli/cmd/floe/send.go:9',
            documented_at: 'nowhere',
        },
        // No source file at all.
        {
            file: 'A7.json',
            surface: 'server',
            text: 'healthy',
            source: 'the container runtime',
            documented_at: 'nowhere',
        },
    ];
    const seeded = seedRows(audit, {
        isFile: (p) => p in files,
        readSource: (p) => files[p],
        pages,
    });
    assert.deepEqual(seeded.rows, [
        {
            surface: 'web',
            text: 'Could not read "{name}". It may have been moved, renamed, or deleted.',
            source: 'client/lib/copy.ts',
            anchor: '/troubleshooting#could-not-read-a-file',
            why_no_home: null,
        },
        {
            surface: 'web',
            text: 'Link Invalid',
            source: 'client/lib/copy.ts',
            anchor: '/troubleshooting#link-invalid',
            why_no_home: null,
        },
        {
            surface: 'cli',
            text: 'Waiting for peer...',
            source: 'cli/cmd/floe/send.go',
            anchor: null,
            why_no_home: null,
        },
    ]);
    assert.deepEqual(
        seeded.unmatched.map((u) => [u.file, u.text, u.why]),
        [
            [
                'A4.json',
                'A line nobody prints',
                'not found in cli/cmd/floe/send.go',
            ],
            ['A7.json', 'healthy', 'the source names no file in this tree'],
        ]
    );
    assert.deepEqual(
        seeded.unresolved.map((u) => [u.file, u.text, u.documented_at]),
        [['A4.json', 'Waiting for peer...', 'docs/cli/send.mdx#output']]
    );
});

test('matchText: what the auditors wrote around a message is not kept as the message', () => {
    const sources = [
        {
            path: 'client/public/install.sh',
            hay: haystack(
                [
                    '# install.sh: the one-line installer',
                    'echo "Fetching latest version..."',
                    'echo "Warning: checksum not found for $ARCHIVE, skipping verification."',
                    'return fmt.Errorf("transfer blocked: relay connections are capped at 2 GB (selected %s)", size)',
                    'return fmt.Errorf("failed to set remote description: %w", err)',
                    'label = "--"',
                ].join('\n')
            ),
        },
    ];
    const text = (said, surface = 'cli') =>
        matchText(said, sources, surface).matched.map((m) => m.text);

    // A file name in front is the auditor saying where the line comes from.
    assert.deepEqual(
        text(
            'install.sh: Warning: checksum not found for <archive>, skipping verification.'
        ),
        ['Warning: checksum not found for {archive}, skipping verification.']
    );
    // A note the source types after its bracket is the message's; one it does not is the auditor's.
    assert.deepEqual(
        text(
            'transfer blocked: relay connections are capped at 2 GB (selected <size>) (or: the same with no size)'
        ),
        [
            'transfer blocked: relay connections are capped at 2 GB (selected {size})',
        ]
    );
    // An ellipsis that ends a word is the app's; one that stands alone is words left out.
    assert.deepEqual(text('Fetching latest version...'), [
        'Fetching latest version...',
    ]);
    assert.deepEqual(text('failed to set remote description: ...'), [
        'failed to set remote description: {rest}',
    ]);
    // A long marker is named by its words before the comma.
    assert.deepEqual(
        text(
            'failed to set remote description: <text from the library, may quote the other side>'
        ),
        ['failed to set remote description: {text from the library}']
    );
    // A description that quotes a message is for a person to take apart.
    assert.deepEqual(
        text(
            "<the sender's own reason>, for example `transfer blocked: relay connections are capped at 2 GB`"
        ),
        []
    );
    // In the source, and nothing a person would look up.
    assert.deepEqual(text('--'), []);
});

test('seedRows: two rows that differ only in what a placeholder is called are one message', () => {
    const files = {
        'cli/engine/transfer/receiver.go':
            'return fmt.Errorf("connection closed after %d of %d files", got, want)\n',
    };
    const seeded = seedRows(
        [
            {
                file: 'A4.json',
                surface: 'cli',
                text: 'connection closed after 2 of 5 files',
                source: 'cli/engine/transfer/receiver.go:1008',
                documented_at: 'nowhere',
            },
            {
                file: 'A8b.json',
                surface: 'cli',
                text: 'connection closed after <n> of <m> files',
                source: 'cli/engine/transfer/receiver.go:1009',
                documented_at: 'nowhere',
            },
        ],
        {
            isFile: (p) => p in files,
            readSource: (p) => files[p],
            pages: pagesOf({}),
        }
    );
    assert.deepEqual(
        seeded.rows.map((r) => r.text),
        ['connection closed after {n} of {n} files']
    );
});

test('carryOver: a second seed keeps a hand-added row, a reason, and an anchor set by hand', () => {
    const seeded = [
        row({ text: 'Link Invalid', anchor: null }),
        row({ text: 'Offline', anchor: '/troubleshooting#link-invalid' }),
        row({ text: 'Send', anchor: null }),
    ];
    const earlier = [
        // Placed by hand since the first seed.
        row({
            text: 'Link Invalid',
            anchor: '/troubleshooting#could-not-read-a-file',
        }),
        // The audit now resolves this one itself, and wins.
        row({ text: 'Offline', anchor: '/troubleshooting#old' }),
        row({ text: 'Send', anchor: null, why_no_home: 'a button label' }),
        // Added by hand from the unmatched list.
        row({
            surface: 'cli',
            text: 'cannot walk {folder}: {cause}',
            anchor: null,
        }),
    ];
    assert.deepEqual(
        carryOver(seeded, earlier).map((r) => [
            r.surface,
            r.text,
            r.anchor,
            r.why_no_home,
        ]),
        [
            [
                'web',
                'Link Invalid',
                '/troubleshooting#could-not-read-a-file',
                null,
            ],
            ['web', 'Offline', '/troubleshooting#link-invalid', null],
            ['web', 'Send', null, 'a button label'],
            ['cli', 'cannot walk {folder}: {cause}', null, null],
        ]
    );
});

// ---------------------------------------------------------------------------
// The snapshot of the released apps
// ---------------------------------------------------------------------------

test('buildSnapshot keeps a cli or desktop row only when its ref has the text, each surface at its own ref', () => {
    const at = {
        'v1.11.0:cli/cmd/floe/send.go': 'fmt.Println("  Waiting for peer...")',
        'desktop-v0.3.0:desktop/frontend/src/errors.ts':
            "'That code wasn\\'t recognized'",
        // The engine file as each release has it: the two differ.
        'v1.11.0:cli/engine/transfer/refusal.go':
            '"the drive ran out of space"',
        'desktop-v0.3.0:cli/engine/transfer/refusal.go': '"the disk is full"',
    };
    const asked = [];
    const { snapshot, missing } = buildSnapshot({
        refs: { cli: 'v1.11.0', desktop: 'desktop-v0.3.0' },
        rows: [
            row({
                surface: 'cli',
                text: 'Waiting for peer...',
                source: 'cli/cmd/floe/send.go',
            }),
            row({
                surface: 'cli',
                text: 'A line added after the release',
                source: 'cli/cmd/floe/send.go',
            }),
            row({
                surface: 'cli',
                text: 'the drive ran out of space',
                source: 'cli/engine/transfer/refusal.go',
            }),
            row({
                surface: 'desktop',
                text: 'the drive ran out of space',
                source: 'cli/engine/transfer/refusal.go',
            }),
            row({
                surface: 'desktop',
                text: "That code wasn't recognized",
                source: 'desktop/frontend/src/errors.ts',
            }),
            // A web row is never part of the snapshot, and neither is a cli
            // row typed in a file floe.one serves from main.
            row({
                surface: 'web',
                text: 'Link Invalid',
                source: 'client/components/Card.tsx',
            }),
            row({
                surface: 'cli',
                text: 'Checksum verified.',
                source: 'client/public/install.sh',
            }),
        ],
        captures: [
            {
                surface: 'desktop',
                string: 'the disk is full',
                sources: [
                    'desktop/missing.go',
                    'cli/engine/transfer/refusal.go',
                ],
            },
        ],
        show: (ref, path) => {
            asked.push(`${ref}:${path}`);
            return at[`${ref}:${path}`] ?? null;
        },
    });
    assert.deepEqual(snapshot, {
        refs: { cli: 'v1.11.0', desktop: 'desktop-v0.3.0' },
        cli: {
            'cli/cmd/floe/send.go': ['Waiting for peer...'],
            'cli/engine/transfer/refusal.go': ['the drive ran out of space'],
        },
        desktop: {
            'cli/engine/transfer/refusal.go': ['the disk is full'],
            'desktop/frontend/src/errors.ts': ["That code wasn't recognized"],
        },
    });
    assert.deepEqual(
        missing.map((m) => [m.surface, m.text]),
        [
            ['cli', 'A line added after the release'],
            ['desktop', 'the drive ran out of space'],
        ]
    );
    assert.ok(!asked.some((a) => a.includes('client/')), asked.join(' '));
});

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

const cellsOf = (mdx, heading) => {
    const lines = mdx.split('\n');
    const from = lines.indexOf(`## ${heading}`);
    assert.ok(from >= 0, `no "## ${heading}" in\n${mdx}`);
    const rows = [];
    for (let i = from + 1; i < lines.length && !lines[i].startsWith('## '); i++)
        if (lines[i].startsWith('| ') && !/^\| -+ \|/.test(lines[i]))
            rows.push(lines[i]);
    return rows.slice(1);
};

test('renderIndex: frontmatter, one section per surface in the fixed order, web and site together', () => {
    const mdx = renderIndex(
        [
            row({ surface: 'server', text: 'request links: on' }),
            row({ surface: 'cli', text: 'Waiting for peer...' }),
            row({ surface: 'desktop', text: 'Files received' }),
            row({ surface: 'web-request', text: 'This link has ended.' }),
            row({ surface: 'site', text: 'Not connected' }),
            row({ surface: 'web', text: 'Link Invalid' }),
        ],
        () => 'Link invalid'
    );
    const lines = mdx.split('\n');
    assert.equal(lines[0], '---');
    assert.ok(lines.includes('title: "Every message Floe can show"'));
    assert.ok(lines.includes('sidebarTitle: "Message index"'));
    const description = lines.find((l) => l.startsWith('description: "'));
    assert.ok(
        description && description.length - 'description: ""'.length < 160,
        description
    );
    assert.ok(lines.some((l) => /^keywords: \[".+"\]$/.test(l)));
    assert.deepEqual(
        lines.filter((l) => l.startsWith('## ')),
        [
            '## In the browser',
            // An explicit id: Mintlify keeps the apostrophe in a generated one.
            "## On a request link's page {#on-a-request-link-page}",
            '## In Floe Desktop',
            '## On the command line',
            '## From a self-hosted server',
        ]
    );
    // The page opens on a paragraph, never on a heading or a table.
    const body = lines
        .slice(lines.indexOf('---', 1) + 1)
        .find((l) => l.trim() !== '');
    assert.ok(body && !/^[#|]/.test(body), body);
    assert.equal(
        lines.filter((l) => l === '| Message | Explained at |').length,
        5
    );
    assert.deepEqual(cellsOf(mdx, 'In the browser'), [
        '| \u201cLink Invalid\u201d | [Link invalid](/troubleshooting#link-invalid) |',
        '| \u201cNot connected\u201d | [Link invalid](/troubleshooting#link-invalid) |',
    ]);
    assert.ok(mdx.endsWith('\n') && !mdx.endsWith('\n\n'));
    assert.ok(!mdx.includes('\r'));
});

test('renderIndex: sorted without regard to case, quotes or leading punctuation', () => {
    const mdx = renderIndex(
        [
            'zebra',
            '"Apple" first',
            '...banana',
            'Cherry',
            '(date) later',
            'apple second',
        ].map((text) => row({ text })),
        () => 'Link invalid'
    );
    assert.deepEqual(
        cellsOf(mdx, 'In the browser').map((l) => l.split(' | ')[0].slice(2)),
        [
            '\u201c"Apple" first\u201d',
            '\u201capple second\u201d',
            '\u201c...banana\u201d',
            '\u201cCherry\u201d',
            '\u201c(date) later\u201d',
            '\u201czebra\u201d',
        ]
    );
});

test('renderIndex: a cell survives MDX and the table, and never opens on a straight quote', () => {
    const mdx = renderIndex(
        [
            row({ text: '"{name}" is <b>bold</b> | piped' }),
            row({
                surface: 'cli',
                text: 'floe send <files> --to "<link>" | tee',
            }),
            row({ surface: 'cli', text: 'Run `floe update` to upgrade.' }),
            row({
                surface: 'server',
                text: '{ "error": "Too many requests" }',
            }),
        ],
        () => 'Link invalid'
    );
    // Typed quotation marks for an app's words; braces and angle brackets
    // escaped, because MDX reads the first as an expression and the second
    // as a tag; the pipe escaped for the table.
    assert.deepEqual(
        cellsOf(mdx, 'In the browser').map((l) => l.split(' | [')[0]),
        ['| \u201c"\\{name\\}" is &lt;b&gt;bold&lt;/b&gt; \\| piped\u201d']
    );
    // Terminal and log lines in code, where only the pipe needs anything; a
    // backtick inside takes a longer fence.
    assert.deepEqual(
        cellsOf(mdx, 'On the command line').map((l) => l.split(' | [')[0]),
        [
            '| `floe send <files> --to "<link>" \\| tee`',
            '| `` Run `floe update` to upgrade. ``',
        ]
    );
    assert.deepEqual(
        cellsOf(mdx, 'From a self-hosted server').map(
            (l) => l.split(' | [')[0]
        ),
        ['| `{ "error": "Too many requests" }`']
    );
    for (const line of mdx.split('\n').filter((l) => l.startsWith('| ')))
        for (const cell of line.split(/(?<!\\)\|/).slice(1, -1))
            assert.ok(!/^\s*"/.test(cell), line);
});

test('renderIndex: no anchor reads "Not explained yet", a reason leaves the row out, a page link is labeled by the caller', () => {
    const mdx = renderIndex(
        [
            row({ text: 'Explained', anchor: '/troubleshooting#link-invalid' }),
            row({ text: 'Unexplained', anchor: null }),
            row({ text: 'Send', anchor: null, why_no_home: 'a button label' }),
            row({ text: 'Unknown heading', anchor: '/troubleshooting#gone' }),
        ],
        (anchor) =>
            anchor === '/troubleshooting#link-invalid' ? 'Link invalid' : null
    );
    assert.deepEqual(cellsOf(mdx, 'In the browser'), [
        '| \u201cExplained\u201d | [Link invalid](/troubleshooting#link-invalid) |',
        '| \u201cUnexplained\u201d | Not explained yet |',
        // No label to be had: the path is its own label.
        '| \u201cUnknown heading\u201d | [/troubleshooting#gone](/troubleshooting#gone) |',
    ]);
    assert.ok(!mdx.includes('\u201cSend\u201d'));
    // A surface with nothing to list has no section.
    assert.deepEqual(
        mdx.split('\n').filter((l) => l.startsWith('## ')),
        ['## In the browser']
    );
});

test('messages-index.mjs prints the page and writes nothing without --write', () => {
    const root = tree({
        [`${REFS}/messages.json`]: json([row({})]),
        'client/components/Card.tsx': '<h1>Link Invalid</h1>\n',
    });
    const r = spawnSync(process.execPath, [INDEX, '--root', root], {
        encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    // The label is the heading's own text, so the `labels` check has nothing to say about it.
    assert.ok(
        r.stdout.includes(
            '| \u201cLink Invalid\u201d | [Link invalid](/troubleshooting#link-invalid) |'
        ),
        r.stdout
    );
    assert.throws(() => readFileSync(join(root, 'docs', 'messages.mdx')));

    const w = spawnSync(process.execPath, [INDEX, '--root', root, '--write'], {
        encoding: 'utf8',
    });
    assert.equal(w.status, 0, w.stderr);
    assert.equal(
        readFileSync(join(root, 'docs', 'messages.mdx'), 'utf8'),
        r.stdout
    );
});

// ---------------------------------------------------------------------------
// The `messages` check
// ---------------------------------------------------------------------------

test('messages: silent on rows that hold, and one info line when there is no messages.json', () => {
    const none = check(tree({}));
    assert.equal(none.status, 0, none.out);
    assert.ok(
        none.lines.some(
            (l) =>
                l.startsWith('info  messages  ') &&
                l.includes('no messages.json')
        ),
        none.out
    );
    assert.ok(!none.out.includes('NOTE'), none.out);

    const ok = check(
        tree({
            [`${REFS}/messages.json`]: json([row({})]),
            'client/components/Card.tsx': '<h1>Link Invalid</h1>\n',
        })
    );
    assert.equal(ok.status, 0, ok.out);
    assert.ok(!ok.out.includes('NOTE'), ok.out);
    assert.match(ok.out, /docs-check: 0 hard, 0 notes/);
});

test('messages: a web row whose text left its source, a missing source, and an anchor that is gone are notes', () => {
    const r = check(
        tree({
            [`${REFS}/messages.json`]: json([
                row({ text: 'Link Invalid' }),
                row({ text: 'Offline', source: 'client/components/Gone.tsx' }),
                row({
                    text: 'Link Expired',
                    anchor: '/troubleshooting#no-such-heading',
                }),
                row({
                    surface: 'server',
                    text: 'request links: on',
                    source: 'server/policy.js',
                    anchor: '/no-such-page#x',
                }),
            ]),
            'client/components/Card.tsx': '<h1>Link Expired</h1>\n',
            'server/policy.js': "const LOG_ON = 'request links: on';\n",
        })
    );
    assert.equal(r.status, 0, r.out);
    const notes = r.lines.filter((l) => l.startsWith('NOTE  messages  '));
    assert.equal(notes.length, 4, r.out);
    assert.ok(
        notes.some(
            (l) =>
                l.includes('client/components/Card.tsx') &&
                l.includes('\u201cLink Invalid\u201d') &&
                l.includes('no longer')
        ),
        r.out
    );
    assert.ok(
        notes.some(
            (l) =>
                l.includes('client/components/Gone.tsx') &&
                l.includes('no such file')
        ),
        r.out
    );
    assert.ok(
        notes.some((l) => l.includes('/troubleshooting#no-such-heading')),
        r.out
    );
    assert.ok(
        notes.some((l) => l.includes('/no-such-page#x')),
        r.out
    );
});

test('messages: a cli or desktop row is held to the snapshot of the release, never to the working tree', () => {
    const files = {
        [`${REFS}/messages.json`]: json([
            // In the snapshot; main has since reworded it. No note.
            row({
                surface: 'cli',
                text: 'Waiting for peer...',
                source: 'cli/cmd/floe/send.go',
                anchor: null,
                why_no_home: 'a status line',
            }),
            // In the working tree, not in the release. A note.
            row({
                surface: 'cli',
                text: 'Waiting for the other side...',
                source: 'cli/cmd/floe/send.go',
                anchor: null,
                why_no_home: 'a status line',
            }),
            row({
                surface: 'desktop',
                text: 'Files received',
                source: 'desktop/transfer.go',
                anchor: null,
                why_no_home: 'a toast title',
            }),
            // The install script is served by floe.one from main, so it is
            // read from the working tree though the CLI is its surface.
            row({
                surface: 'cli',
                text: 'Checksum verified.',
                source: 'client/public/install.sh',
                anchor: null,
                why_no_home: 'a progress line',
            }),
        ]),
        [`${REFS}/released-strings.json`]: json({
            refs: { cli: 'v1.11.0', desktop: 'desktop-v0.3.0' },
            cli: { 'cli/cmd/floe/send.go': ['Waiting for peer...'] },
            desktop: {},
        }),
        'cli/cmd/floe/send.go':
            'fmt.Println("  Waiting for the other side...")\n',
        'desktop/transfer.go': 'title := "Files received"\n',
        'client/public/install.sh': 'echo "Checksum verified."\n',
    };
    const r = check(tree(files));
    assert.equal(r.status, 0, r.out);
    const notes = r.lines.filter((l) => l.startsWith('NOTE  messages  '));
    assert.equal(notes.length, 2, r.out);
    assert.ok(
        notes.some(
            (l) =>
                l.includes('\u201cWaiting for the other side...\u201d') &&
                l.includes('v1.11.0')
        ),
        r.out
    );
    assert.ok(
        notes.some(
            (l) =>
                l.includes('\u201cFiles received\u201d') &&
                l.includes('desktop-v0.3.0')
        ),
        r.out
    );

    // With no snapshot at all the rows cannot be judged: one note says so.
    delete files[`${REFS}/released-strings.json`];
    const bare = check(tree(files));
    const bareNotes = bare.lines.filter((l) =>
        l.startsWith('NOTE  messages  ')
    );
    assert.equal(bareNotes.length, 1, bare.out);
    assert.match(bareNotes[0], /released-strings\.json/);
});

test('messages: rows with no docs home and no reason are one summary line, not a note each', () => {
    const r = check(
        tree({
            [`${REFS}/messages.json`]: json([
                row({ text: 'Send', anchor: null }),
                row({ text: 'Receive', anchor: null }),
                row({
                    text: 'Transfer',
                    anchor: null,
                    why_no_home: 'a card header',
                }),
            ]),
            'client/components/Card.tsx':
                '<b>Send</b><b>Receive</b><b>Transfer</b>\n',
        })
    );
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(
        r.lines.filter((l) => l.startsWith('NOTE')),
        [
            `NOTE  messages  ${REFS}/messages.json  2 of 3 rows have no docs anchor and no why_no_home`,
        ]
    );
});

test('messages: docs/messages.mdx is compared with what the generator prints, whatever its line ends', () => {
    const files = {
        [`${REFS}/messages.json`]: json([row({})]),
        'client/components/Card.tsx': '<h1>Link Invalid</h1>\n',
        'docs/docs.json':
            '{"navigation":{"pages":["troubleshooting","messages"]}}\n',
    };
    const fresh = spawnSync(process.execPath, [INDEX, '--root', tree(files)], {
        encoding: 'utf8',
    }).stdout;
    assert.ok(fresh.includes('Every message Floe can show'));

    // The page as generated, checked out with CRLF: no note.
    const same = check(
        tree({ ...files, 'docs/messages.mdx': fresh.replace(/\n/g, '\r\n') })
    );
    assert.ok(!same.out.includes('NOTE'), same.out);

    // Edited by hand, or left behind by a messages.json change.
    const stale = check(
        tree({
            ...files,
            'docs/messages.mdx': fresh.replace('Link Invalid', 'Link Expired'),
        })
    );
    const notes = stale.lines.filter((l) => l.startsWith('NOTE  messages  '));
    assert.equal(notes.length, 1, stale.out);
    assert.match(
        notes[0],
        /docs\/messages\.mdx:\d+  differs from what messages-index\.mjs prints/
    );
});
