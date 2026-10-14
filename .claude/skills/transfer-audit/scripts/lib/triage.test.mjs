/**
 * references/triage.md and TRIAGE_KEYS in triage.mjs must name the same keys:
 * the report prints its "no row" disclaimer from TRIAGE_KEYS, so a row added to
 * the table without the key (or the reverse) makes a documented FAIL read as
 * undocumented, or an undocumented one read as documented. The comment on
 * TRIAGE_KEYS has long said this file asserts that; it did not exist until
 * P0-27 added two keys and the audit printed "no row" for a key the table
 * documents.
 *
 * Run: node --test .claude/skills/transfer-audit/scripts/lib/triage.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
    INFRA_KEYS,
    SIGNATURES,
    TRIAGE_KEYS,
    classifySignature,
} from './triage.mjs';

/** Pure. The first backticked key in each row's first cell; `-` rows have none. */
function tableKeys(markdown) {
    const keys = new Set();
    for (const line of String(markdown).split(/\r?\n/)) {
        if (!line.startsWith('|')) continue;
        const first = line.split('|')[1] || '';
        const m = /`([a-z0-9][a-z0-9-]*)`/.exec(first);
        if (m) keys.add(m[1]);
    }
    return keys;
}

test('tableKeys reads the first backticked key and skips rows without one', () => {
    const md = [
        '| Key | Where |',
        '| --- | --- |',
        '| `room-full` | x |',
        '| `-` | a row with no key |',
        '| `rate-limit` (`code-registration-failed`) | y |',
        'not a row `ignored`',
    ].join('\n');
    assert.deepEqual([...tableKeys(md)].sort(), ['rate-limit', 'room-full']);
});

test('TRIAGE_KEYS and the triage table name exactly the same keys', () => {
    const md = readFileSync(
        new URL('../../references/triage.md', import.meta.url),
        'utf8'
    );
    const table = tableKeys(md);
    const missingFromTable = [...TRIAGE_KEYS].filter((k) => !table.has(k));
    const missingFromSet = [...table].filter((k) => !TRIAGE_KEYS.has(k));
    assert.deepEqual(missingFromTable, [], 'keys in TRIAGE_KEYS with no row');
    assert.deepEqual(missingFromSet, [], 'rows whose key TRIAGE_KEYS lacks');
});

// The calm desktop error lines (D-167, shipped in desktop-v0.3.0): friendlyError
// in desktop/frontend/src/errors.ts turns an engine error into one of these and
// the status line shows it behind "Error: ". Each row is [the line, the
// signature key, the triage heading]. Before this table a 0.3.0 desktop failure
// classified as `unknown`, so no triage row was named and an unreachable server
// never counted as an infra symptom.
const CALM_DESKTOP_ERRORS = [
    ['The sender never started sending', 'early-race', 'connect-then-nothing'],
    ['The receiver left or declined', 'early-race', 'connect-then-nothing'],
    ["Can't reach the server", 'signaling-unreachable', 'infra-down'],
    ["That code wasn't recognized", 'code-expired', 'code-expired'],
    ["Couldn't connect the two devices", 'connect-timeout', 'connect-timeout'],
    [
        'Both people need Floe open at the same time',
        'connect-timeout',
        'connect-timeout',
    ],
    ['The sender canceled before it started', 'peer-refused', 'peer-refused'],
    ['The transfer stalled', 'stall', 'stall'],
    [
        "A file arrived incomplete and wasn't kept",
        'incomplete-file',
        'incomplete-file',
    ],
    // The two limiter lines: a lookup the server limits (since #580), and a
    // connection it turns away by its per-network limit (A8b-B1, after
    // desktop-v0.3.0, which showed "The connection dropped before the
    // transfer finished" for it). Both are the limiter, paced and retried.
    [
        'The server is limiting requests from this network. Wait a minute and try again',
        'rate-limited',
        'rate-limit',
    ],
    [
        'The server is limiting connections from this network. Wait a minute and try again',
        'rate-limited',
        'rate-limit',
    ],
];

test('the calm desktop error lines of errors.ts classify to the keys their old sentences had', () => {
    const errorsTs = readFileSync(
        new URL(
            '../../../../../desktop/frontend/src/errors.ts',
            import.meta.url
        ),
        'utf8'
    );
    for (const [line, key, triage] of CALM_DESKTOP_ERRORS) {
        // Quoted from the source, so a copy change breaks this test before it
        // turns the signature back into `unknown`.
        assert.ok(
            errorsTs.includes(`'${line}'`) || errorsTs.includes(`"${line}"`),
            `errors.ts no longer maps anything to: ${line}`
        );
        const sig = classifySignature(`Error: ${line}`);
        assert.equal(sig.key, key, line);
        assert.equal(sig.triage, triage, line);
        assert.ok(TRIAGE_KEYS.has(sig.triage), `${triage} has a triage row`);
    }
    // The point of the infra line: it is counted as an infra symptom.
    assert.ok(
        INFRA_KEYS.has(classifySignature("Error: Can't reach the server").key)
    );
    // The early race is never retried, in either copy.
    assert.equal(
        classifySignature('Error: The sender never started sending').retryable,
        false
    );
    // Near misses that must stay out of these rows: the request lane's own
    // reconnecting line, and a receiver that left before the handshake.
    assert.equal(
        classifySignature("Can't reach the Floe server").key,
        'unknown'
    );
    assert.equal(
        classifySignature('Error: The receiver left before it started').key,
        'unknown'
    );
    assert.equal(
        SIGNATURES.at(-1)[0],
        'phase-timeout',
        'the catch-all stays last'
    );
});

// The page states lib/web.mjs names (G1). Each is raised as a keyed
// PhaseError, and runAttempt takes retryable and the triage heading from the
// key's own row, so a key without a row would be a FAIL nobody can look up
// and a retryable one would let a second attempt hide the finding.
test('receive-short, rejoin-failed and sender-absent each have a signature row that is never retried and a triage row', () => {
    for (const key of ['receive-short', 'rejoin-failed', 'sender-absent']) {
        const row = SIGNATURES.find(([k]) => k === key);
        assert.ok(row, `${key} has a row in SIGNATURES`);
        assert.equal(row[2], false, `${key} is never retried`);
        assert.equal(row[3], key, `${key} is its own triage heading`);
        assert.ok(TRIAGE_KEYS.has(key), `${key} is in TRIAGE_KEYS`);
    }
    // The texts the web leg writes classify to their own key from the text
    // alone, which is what a FLAKY note or a cell without the key would read.
    for (const [text, key] of [
        [
            'receive-short: the web receiver reads "The transfer ended before the rest arrived." (1 of 3 files)',
            'receive-short',
        ],
        [
            'rejoin-failed: the web sender reads "Link stopped working"',
            'rejoin-failed',
        ],
        [
            'sender-absent: the web receiver read "The sender is not connected" for 10000 ms without a break',
            'sender-absent',
        ],
    ])
        assert.equal(classifySignature(text).key, key, text);
});

// "Both people need Floe open at the same time" is the calm copy of two engine
// errors (errors.ts RULES): the wait for the peer, and the wait for an ack.
// The line alone cannot tell them apart, but the phase that failed can: the
// peer wait runs out before the two sides connect, the ack wait only once a
// transfer is under way. Filed under connect-timeout whatever the phase, a
// done-phase ack timeout was retried on a relay cell and counted against the
// infrastructure.
test('the calm line two engine errors share is keyed by the phase that failed: connect-timeout before the transfer, ack-timeout in the done phase', () => {
    const line = 'Error: Both people need Floe open at the same time';
    const errorsTs = readFileSync(
        new URL(
            '../../../../../desktop/frontend/src/errors.ts',
            import.meta.url
        ),
        'utf8'
    );
    for (const engine of [
        'timed out waiting for the peer',
        'timed out waiting for ack',
    ])
        assert.ok(
            errorsTs.includes(
                `['${engine}', 'Both people need Floe open at the same time']`
            ),
            `errors.ts no longer folds "${engine}" into the shared line`
        );
    const heavy = { relay: true, turnHeavy: true };
    for (const phase of [
        undefined,
        'sender.start',
        'receiver.start',
        'connect',
    ]) {
        const sig = classifySignature(line, { ...heavy, phase });
        assert.deepEqual(
            [sig.key, sig.triage, sig.retryable],
            ['connect-timeout', 'connect-timeout', true],
            String(phase)
        );
    }
    const ackRow = SIGNATURES.find(([k]) => k === 'ack-timeout');
    const done = classifySignature(line, { ...heavy, phase: 'done' });
    assert.deepEqual(
        [done.key, done.triage, done.retryable],
        ['ack-timeout', ackRow[3], false]
    );
    assert.equal(ackRow[2], false, 'an ack timeout is never retried');
    assert.equal(done.text, line);
    assert.ok(TRIAGE_KEYS.has(done.triage));
    // The engine's own sentence, which a CLI prints, needs no phase.
    for (const phase of [undefined, 'connect', 'done'])
        assert.equal(
            classifySignature('Error: timed out waiting for ack', { phase })
                .key,
            'ack-timeout'
        );
    // Only the shared line moves: every other connect timeout keeps its key
    // in the done phase, and a row above it still wins.
    for (const other of [
        "Error: Couldn't connect the two devices",
        'Error: timed out establishing a connection',
        'Error: timed out waiting for the peer',
    ])
        assert.equal(
            classifySignature(other, { ...heavy, phase: 'done' }).key,
            'connect-timeout',
            other
        );
    assert.equal(
        classifySignature(`hash-mismatch: a.bin\n${line}`, { phase: 'done' })
            .key,
        'hash-mismatch'
    );
});
