// node --test .claude/skills/<skill>/scripts/lib/report.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    EXIT,
    buildRunJson,
    collectRooms,
    exitCodeFor,
    failureSections,
    headline,
    newSafety,
    redact,
    redactRooms,
    relayBytesOf,
    renderMarkdown,
    totalsOf,
} from './report.mjs';

const cell = (id, verdict, extra = {}) => ({
    id,
    profile: 'shipped',
    path: id.includes('-REL-') ? 'REL' : 'DIR',
    variant: null,
    sender: { surface: id[6], version: '3.4.5' },
    receiver: { surface: id[8], input: 'link' },
    fixture: { kind: 'single', files: [], totalBytes: 12 * 1024 * 1024 },
    verdict,
    reason: null,
    triage: null,
    note: null,
    attempts: [],
    route: {
        expected: 'direct',
        observed: 'direct',
        label: 'direct [W,W]',
        sources: [],
    },
    integrity: { ok: true, files: [] },
    completion: {},
    stats: {},
    metrics: { throughputMBps: 20 },
    durationS: 14.2,
    rcvBuild: 'web 1234567',
    countsForExit: verdict !== 'NA',
    ...extra,
});

test('the limiter header names the relaxed local stack instead of production', () => {
    const cells = [cell('S-DIR-W2W', 'PASS')];
    const prod = renderMarkdown(baseRun(cells));
    assert.match(prod, /\| Production limiter peak per 60 s: TURN \d+\/20/);
    const relaxed = renderMarkdown({
        ...baseRun(cells),
        profile: 'head',
        pacing: {
            relaxed: true,
            peakPer60s: { turn: 6, conn: 2, code: 1 },
            caps: { turn: 1000, conn: 1000, code: 1000 },
        },
    });
    assert.match(
        relaxed,
        /\| Limiter \(relaxed, local stack\) peak per 60 s: TURN 6\/1000, connections 2\/1000, code 1\/1000/
    );
    assert.ok(!relaxed.includes('Production limiter'));
});

const baseRun = (cells, versions = []) => ({
    runId: '20260101-000000-shipped-default',
    profile: 'shipped',
    subset: 'default',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:10:00.000Z',
    durationS: 600,
    root: 'C:\\r',
    outDir: 'C:\\o\\run',
    host: { hostname: 'h', os: 'Windows 10.0', node: 'v22', go: 'go1.25' },
    commits: {
        local: 'aaaaaaaaaa',
        branch: 'main',
        main: 'bbbbbbbbbb',
        web: null,
        server: null,
    },
    binaries: {
        cli: { tag: 'v3.4.5', sha256: 'c'.repeat(64), version: '3.4.5' },
        desktop: { kind: 'portable', version: '3.4.5', isPackaged: false },
        web: { origin: 'https://www.floe.one' },
    },
    flags: { strict: false },
    relayBytes: 4 * 1024 * 1024,
    cells,
    versions,
    infra: [{ check: 'api.floe.one /health', ok: true, detail: 'healthy' }],
    safety: newSafety(),
    pacing: {
        caps: { turn: 20, conn: 30, code: 60 },
        peakPer60s: { turn: 6, conn: 6, code: 2 },
    },
    exitCode: 0,
    headline: null,
    artifacts: {
        reportMd: 'C:\\o\\run\\audit.md',
        runJson: 'C:\\o\\run\\run.json',
    },
});

test('exit precedence 2, 4, 3, 1, 5, 6, 0', () => {
    const fail = [cell('S-DIR-W2W', 'FAIL')];
    const drift = [{ gate: true, status: 'STALE' }];
    assert.equal(
        exitCodeFor({
            usage: true,
            safety: true,
            precondition: true,
            cells: fail,
        }),
        2
    );
    assert.equal(
        exitCodeFor({ safety: true, precondition: true, cells: fail }),
        4
    );
    assert.equal(
        exitCodeFor({ precondition: true, cells: fail, versions: drift }),
        3
    );
    assert.equal(exitCodeFor({ interrupted: true, cells: fail }), 130);
    assert.equal(exitCodeFor({ cells: fail, versions: drift }), 1);
    assert.equal(
        exitCodeFor({ cells: [cell('S-DIR-W2W', 'FLAKY')], strict: true }),
        1
    );
    assert.equal(
        exitCodeFor({ cells: [cell('S-DIR-W2W', 'FLAKY')], versions: drift }),
        5
    );
    assert.equal(exitCodeFor({ cells: [cell('S-DIR-W2W', 'SKIP')] }), 5);
    assert.equal(exitCodeFor({ cells: [cell('S-DIR-W2W', 'ERROR')] }), 5);
    assert.equal(
        exitCodeFor({ cells: [cell('S-DIR-W2W', 'PASS')], versions: drift }),
        6
    );
    assert.equal(
        exitCodeFor({
            cells: [cell('S-DIR-W2W', 'PASS')],
            versions: [{ gate: false, status: 'STALE' }],
        }),
        0
    );
    assert.equal(
        exitCodeFor({
            cells: [cell('S-DIR-W2W', 'PASS'), cell('S-DIR-D2D', 'NA')],
        }),
        0
    );
    assert.equal(
        exitCodeFor({
            cells: [
                cell('S-DIR-W2W', 'PASS'),
                cell('S-DIR-C2C', 'SKIP', { countsForExit: false }),
            ],
        }),
        0
    );
    assert.equal(EXIT.interrupted, 130);
});

test('redaction of room links and codes is by value, with the link regex as the safety net', () => {
    assert.equal(redact(null), null);
    assert.match(redact('https://www.floe.one/#room=abc'), /^#[0-9a-f]{8}$/);
    const link = 'https://www.floe.one/#room=1234-5678';
    const text = `link ${link} code olive-tiger-castle keep no-relay and desktop-v3.4.5`;
    const r = redactRooms(text, ['olive-tiger-castle', link]);
    assert.ok(!r.includes('#room=1234'));
    assert.ok(!r.includes('olive-tiger-castle'));
    assert.match(r, /^link <room #[0-9a-f]{8}> code <code #[0-9a-f]{8}> keep/);
    assert.ok(r.includes('no-relay') && r.includes('desktop-v3.4.5'));
    // A link no attempt recorded still goes through the regex.
    assert.ok(!redactRooms(text).includes('#room='));
    // No generic three-word regex any more: harness tokens, path segments
    // and ordinary hyphenated words survive untouched.
    for (const s of [
        'no-data-after-connect',
        'desktop-receiver-undrivable',
        'D:\\audit\\transfer-audit\\runs',
        'stall-before-metadata',
        'peer-left-early',
        'a state-of-the-art path',
    ])
        assert.equal(redactRooms(s, ['olive-tiger-castle']), s);
    assert.deepEqual(
        collectRooms({
            cells: [
                {
                    attempts: [
                        { room: { link, code: 'a-b-c' } },
                        { room: { link: null, code: 'a-b-c' } },
                    ],
                },
            ],
        }),
        [link, 'a-b-c']
    );
});

test('headline forms', () => {
    const drift = [{ surface: 'Web floe.one', gate: true, status: 'STALE' }];
    assert.equal(
        headline(baseRun([cell('S-DIR-W2W', 'PASS'), cell('S-DIR-D2D', 'NA')])),
        '1/1 PASS, all surfaces on latest'
    );
    // --cells: filtered rows are named, never counted as SKIP or executable.
    const filtered = [
        cell('S-DIR-W2W', 'PASS'),
        cell('S-DIR-C2D', 'SKIP', { reason: 'filtered' }),
        cell('S-REL-W2C', 'SKIP', { reason: 'filtered' }),
    ];
    assert.equal(
        headline(baseRun(filtered)),
        '1/1 PASS, all surfaces on latest; 2 filtered by --cells'
    );
    assert.equal(
        headline(
            baseRun([
                ...filtered,
                cell('S-DIR-C2C', 'SKIP', { reason: 'uia-setvalue' }),
            ])
        ),
        '1/2 PASS, 1 SKIP; all surfaces on latest; 2 filtered by --cells'
    );
    assert.equal(totalsOf(filtered).filtered, 2);
    assert.match(
        renderMarkdown(baseRun(filtered)),
        /Totals: 1 PASS, 0 FAIL, 0 FLAKY, 2 SKIP, 0 NA of 3 \(2 of the SKIP rows filtered by --cells, uncounted\)/
    );
    assert.equal(
        headline(
            baseRun([cell('S-DIR-W2W', 'PASS'), cell('S-DIR-C2D', 'SKIP')])
        ),
        '1/2 PASS, 1 SKIP; all surfaces on latest'
    );
    assert.equal(
        headline(
            baseRun(
                [cell('S-DIR-W2W', 'FAIL'), cell('S-DIR-C2D', 'SKIP')],
                drift
            )
        ),
        '1 FAIL (S-DIR-W2W); 1 SKIP; surfaces stale: Web floe.one'
    );
    assert.equal(
        headline(baseRun([cell('S-DIR-W2W', 'PASS')], drift)),
        '1/1 PASS, surfaces stale: Web floe.one'
    );
    assert.equal(
        headline({
            ...baseRun([]),
            aborted: { reason: 'api.floe.one is not healthy' },
        }),
        'aborted: api.floe.one is not healthy'
    );
});

test('renderMarkdown carries every section and every verdict', () => {
    const cells = [
        cell('S-DIR-W2W', 'PASS'),
        cell('S-DIR-C2D', 'FAIL', {
            reason: 'early-race',
            triage: 'connect-then-nothing',
            note: 'done: Error: connected, but no data arrived from the sender within 30s',
            rcvBuild: 'desktop 3.4.4 store',
            attempts: [
                {
                    n: 1,
                    failedPhase: 'done',
                    signature: {
                        key: 'early-race',
                        text: 'Error: connected, but no data arrived from the sender within 30s',
                    },
                    evidence: {
                        senderTranscript: 'x/sender.transcript.txt',
                        receiverTranscript: null,
                        captures: ['x/desktop-1.png'],
                    },
                },
            ],
        }),
        cell('S-REL-W2C', 'FLAKY', {
            reason: 'ice-fetch-failed',
            note: 'attempt 1: Error: failed to fetch ICE credentials; attempt 2 passed',
            route: { label: 'relay [W local]' },
            attempts: [
                {
                    n: 1,
                    failedPhase: 'connect',
                    signature: {
                        key: 'ice-fetch-failed',
                        text: 'Error: failed to fetch ICE credentials',
                    },
                    evidence: {},
                },
                { n: 2, evidence: {} },
            ],
        }),
        cell('S-REL-C2C', 'NA', {
            reason: 'no-cli-relay-forcer',
            note: 'no CLI relay forcer',
        }),
        cell('S-DIR-D2D', 'NA', {
            reason: 'single-instance',
            note: 'single instance',
        }),
        cell('S-DIR-W2D', 'SKIP', {
            reason: 'uia-setvalue',
            note: 'desktop receiver not drivable',
        }),
        cell('S-DIR-C2C-thr500', 'PASS', {
            variant: 'thr500',
            metrics: { throughputMBps: 45.1 },
            fixture: { totalBytes: 500 * 1024 * 1024, files: [] },
        }),
        cell('S-DIR-C2C', 'ERROR', {
            reason: 'init-script-not-applied',
            note: 'verify: init script did not take',
        }),
    ];
    const versions = [
        {
            surface: 'CLI under test',
            installed: '3.4.5 (path)',
            latest: 'v3.4.5',
            oracle: 'floe --version',
            status: 'CURRENT',
            gate: true,
            suggest: null,
        },
    ];
    const run = baseRun(cells, versions);
    run.exitCode = exitCodeFor({ cells, versions });
    run.headline = headline(run);
    const md = renderMarkdown(run);
    for (const h of [
        '# Floe live-transfer audit: ',
        '## Cells',
        '## Versions',
        '## Infra',
        '## Safety',
        '## Failures and flakes',
        '## Legend',
        'Totals: 2 PASS, 1 FAIL, 1 FLAKY, 1 SKIP, 2 NA, 1 ERROR of 8',
    ])
        assert.ok(md.includes(h), h);
    for (const v of ['PASS', 'FAIL', 'FLAKY', 'SKIP', 'NA', 'ERROR'])
        assert.ok(md.includes(`| ${v}`), v);
    assert.ok(md.includes('### S-DIR-C2D FAIL early-race'));
    assert.ok(md.includes('the receiver build decides'));
    assert.ok(md.includes('### S-REL-W2C FLAKY'));
    assert.ok(md.includes('45.1 MB/s'));
    assert.ok(md.includes('Exit code 1:'));
    assert.ok(md.includes('portable 3.4.5 (isPackaged=false)'));
    assert.ok(md.includes('TURN 6/20'));
    assert.ok(!/[\u2013\u2014]/.test(md), 'no dashes');
    const json = buildRunJson(run);
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.totals.total, 8);
    assert.equal(json.cells.length, 8);
    assert.equal(json.run.exitCode, 1);
    assert.equal(
        json.cells[1].attempts[0].signatureKey ??
            json.cells[1].attempts[0].signature,
        json.cells[1].attempts[0].signature
    );
    assert.deepEqual(
        Object.keys(json.safety).sort(),
        Object.keys(newSafety()).sort()
    );
    assert.deepEqual(totalsOf(cells), {
        pass: 2,
        fail: 1,
        flaky: 1,
        skip: 1,
        na: 2,
        error: 1,
        filtered: 0,
        total: 8,
    });
});

test('run.json redacts room links and codes', () => {
    const c = cell('S-DIR-W2W', 'PASS', {
        receiver: {
            surface: 'C',
            input: 'link',
            argv: [
                'C:\\bin\\floe.exe',
                'receive',
                'https://www.floe.one/#room=secret-room',
                '--no-report',
            ],
        },
        sender: {
            surface: 'C',
            argv: ['C:\\bin\\floe.exe', 'receive', 'olive-tiger-castle'],
        },
        attempts: [
            {
                n: 1,
                room: {
                    link: 'https://www.floe.one/#room=secret-room',
                    code: 'olive-tiger-castle',
                },
                evidence: {},
                phases: {},
            },
        ],
    });
    const json = buildRunJson(baseRun([c]));
    const text = JSON.stringify(json);
    assert.ok(
        !text.includes('secret-room') && !text.includes('olive-tiger-castle')
    );
    assert.match(json.cells[0].attempts[0].room.link, /^#[0-9a-f]{8}$/);
    assert.equal(json.cells[0].receiver.argv[3], '--no-report');
    assert.match(json.cells[0].receiver.argv[2], /^<room #[0-9a-f]{8}>$/);
    assert.match(json.cells[0].sender.argv[2], /^<code #[0-9a-f]{8}>$/);
});

test('headline counts FLAKY and ERROR on their own, never inside SKIP or FAIL', () => {
    assert.equal(
        headline(
            baseRun([cell('S-DIR-W2W', 'PASS'), cell('S-DIR-W2C', 'FLAKY')])
        ),
        '1/2 PASS, 1 FLAKY; all surfaces on latest'
    );
    assert.equal(
        headline(baseRun([cell('S-DIR-W2C', 'ERROR')])),
        '1 ERROR (S-DIR-W2C); 0 SKIP; all surfaces on latest'
    );
    assert.equal(
        headline(
            baseRun([
                cell('S-DIR-W2W', 'FAIL'),
                cell('S-DIR-W2C', 'ERROR'),
                cell('S-DIR-C2W', 'FLAKY'),
                cell('S-DIR-C2C', 'SKIP'),
            ])
        ),
        '1 FAIL, 1 ERROR (S-DIR-W2W, S-DIR-W2C); 1 SKIP, 1 FLAKY; all surfaces on latest'
    );
});

test('run.json and audit.md are redacted by value: notes, signatures, completion texts, console lines and the aborted headline', () => {
    const link =
        'https://www.floe.one/#room=11111111-2222-4333-8444-555555555555';
    const code = 'olive-tiger-castle';
    const c = cell('S-DIR-C2C', 'ERROR', {
        reason: 'harness',
        sender: { surface: 'C', argv: ['floe', 'send', 'x'] },
        receiver: {
            surface: 'C',
            argv: ['floe', 'receive', code, '--output', 'D:\\x'],
            input: 'code',
        },
        note: `receiver.start: receiver: exited (code 1) before a line matching /x/\nstdout:   Code   ${code}\n  Link   ${link}`,
        attempts: [
            {
                n: 1,
                room: { link, code },
                signature: {
                    text: `sender: exited before /x/ stdout Link ${link}`,
                },
                notes: [
                    `stop sender: could not reach ${link}`,
                    'no-data-after-connect',
                ],
                evidence: {
                    browserConsole: [{ text: `Navigated to ${link}` }],
                    dir: 'D:\\audit\\transfer-audit\\runs',
                },
            },
        ],
        completion: { receiver: { text: `Saved to ${link}` } },
    });
    const run = {
        ...baseRun([c]),
        aborted: { reason: `precondition: ${link}` },
    };
    const json = buildRunJson(run);
    const text = JSON.stringify(json);
    assert.ok(!text.includes('#room='), 'no raw link anywhere in run.json');
    assert.ok(!text.includes(code), 'no raw code anywhere in run.json');
    assert.match(json.cells[0].receiver.argv[2], /^<code #[0-9a-f]{8}>$/);
    assert.match(
        json.run.aborted.reason,
        /^precondition: <room #[0-9a-f]{8}>$/
    );
    assert.ok(text.includes('no-data-after-connect'), 'harness tokens stay');
    assert.ok(text.includes('transfer-audit'), 'path segments stay');
    const md = renderMarkdown({ ...run, exitCode: 5, headline: headline(run) });
    assert.ok(!md.includes('#room='), 'no raw link anywhere in audit.md');
    assert.ok(!md.includes(code), 'no raw code anywhere in audit.md');
    assert.match(
        md.split('\n')[0],
        /^# Floe live-transfer audit: aborted: precondition: <room #[0-9a-f]{8}>$/
    );
});

test('table cells escape pipes and collapse newlines so a note never breaks the Cells table', () => {
    const c1 = cell('S-DIR-C2C', 'FAIL', {
        reason: 'unknown',
        note: 'connect: sender: no line matching /^ {2}Connected(?: \\((direct|relay)\\))?$/ in 45000 ms',
    });
    const c2 = cell('S-DIR-W2C', 'ERROR', {
        reason: 'harness',
        note: 'done: boom\nstderr: something',
    });
    const md = renderMarkdown(baseRun([c1, c2]));
    const rows = md.split('\n').filter((l) => l.startsWith('| S-DIR-'));
    assert.equal(rows.length, 2);
    for (const r of rows)
        assert.equal((r.match(/(?<!\\)\|/g) || []).length, 8, r);
    assert.ok(rows[0].includes('direct\\|relay'));
    assert.ok(rows[1].includes('done: boom stderr: something'));
    // The Cells table itself never gains a stray line from a note.
    const cellsTable = md.split('## Cells')[1].split('## Versions')[0];
    assert.ok(
        cellsTable
            .split('\n')
            .filter((l) => l.trim())
            .every((l) => l.startsWith('|') || l.startsWith('Totals:')),
        cellsTable
    );
});

test('relayBytesOf sums every attempt of a REL cell, whatever the verdict', () => {
    const cells = [
        cell('S-REL-W2C', 'FLAKY', {
            attempts: [{ bytesMoved: 2048 }, { bytesMoved: 2048 }],
        }),
        cell('S-REL-C2W', 'FAIL', { attempts: [{ bytesMoved: 4096 }] }),
        cell('S-REL-C2W-cap3g', 'PASS', {
            variant: 'cap3g',
            attempts: [{ bytesMoved: 0 }],
        }),
        cell('S-DIR-W2C', 'PASS', { attempts: [{ bytesMoved: 999 }] }),
        cell('S-REL-D2D', 'NA'),
    ];
    assert.equal(relayBytesOf(cells), 8192);
    assert.equal(relayBytesOf([]), 0);
    const json = buildRunJson(baseRun(cells));
    assert.equal(json.cells[0].attempts[1].bytesMoved, 2048);
});

test('the FAIL block prints the attempt notes and always names a triage key', () => {
    const cell = {
        id: 'S-REL-W2D',
        verdict: 'FAIL',
        reason: 'turn-fetch-rejected',
        triage: 'turn-fetch-rejected',
        sender: { surface: 'web' },
        receiver: { surface: 'desktop' },
        rcvBuild: 'desktop 0.2.8 store',
        attempts: [
            {
                failedPhase: 'connect',
                signature: {
                    key: 'turn-fetch-rejected',
                    text: 'phase timeout: connect exceeded 60000 ms',
                },
                notes: [
                    'turn-fetch-status 429 on the relay-forced web sender',
                    'web sender candidates: local none; remote host,srflx',
                ],
                evidence: { dir: 'C:\\out\\cells\\S-REL-W2D' },
            },
        ],
    };
    const [block] = failureSections([cell]);
    assert.match(
        block,
        /Notes: turn-fetch-status 429 on the relay-forced web sender; web sender candidates: local none; remote host,srflx/
    );
    assert.match(
        block,
        /Triage: references\/triage\.md "turn-fetch-rejected"\./
    );

    // A key with no triage still prints a line, and says so.
    const bare = {
        ...cell,
        id: 'S-DIR-C2C-killsnd',
        reason: 'kill-sender-outcome',
        triage: null,
        attempts: [
            {
                failedPhase: 'verify',
                signature: {
                    key: 'kill-sender-outcome',
                    text: 'kill-sender: receiver ended transfer (0)',
                },
                notes: [],
                evidence: {},
            },
        ],
    };
    // kill-sender-outcome HAS a row in references/triage.md, so it must not
    // carry the disclaimer even though no SIGNATURES entry sets a heading.
    const [b2] = failureSections([bare]);
    assert.match(b2, /Triage: references\/triage\.md "kill-sender-outcome"\./);
    assert.ok(!b2.includes('Notes:'), 'no Notes line when there are none');
    // A key the table does not document says so.
    const undoc = {
        ...bare,
        id: 'S-DIR-W2W',
        reason: 'brand-new-key',
        attempts: [
            {
                failedPhase: 'verify',
                signature: { key: 'brand-new-key', text: 'x' },
                notes: [],
                evidence: {},
            },
        ],
    };
    assert.match(
        failureSections([undoc])[0],
        /"brand-new-key" \(no row: read the phase/
    );
});
