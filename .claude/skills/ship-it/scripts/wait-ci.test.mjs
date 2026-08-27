/**
 * Synthetic cases for the decision function in wait-ci.mjs.
 *
 * The live fixtures (a merged PR, a red commit, a missing PR number) prove the
 * gh plumbing; they cannot exercise the dropped-event and timeout exits without
 * pushing an orphan branch and waiting. decide() is pure over one snapshot of
 * check-runs, so every exit is covered here with three-line arrays instead.
 *
 * Run: node --test .claude/skills/ship-it/scripts/wait-ci.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, parseArgs, recoveryRef } from './wait-ci.mjs';

const opts = { graceMin: 3, timeoutMin: 9 };
const url = (job) =>
    `https://github.com/jannskiee/floe/actions/runs/32288544822/job/${job}`;
const run = (id, name, conclusion, over = {}) => ({
    id,
    name,
    status: 'completed',
    conclusion,
    html_url: url(id),
    check_suite: { id: 7 },
    ...over,
});

test('success: exit 0 with the gate URL', () => {
    const d = decide(
        [
            run(1, 'Detect changed paths', 'success'),
            run(2, 'CI green', 'success'),
        ],
        0.2,
        opts
    );
    assert.equal(d.code, 0);
    assert.match(d.lines[0], /^CI green: success \(https:/);
});

test('failure: exit 1 names the failed sibling and prints the --log-failed command', () => {
    const runs = [
        run(1, 'Detect changed paths', 'success'),
        run(3, 'Build & Lint', 'failure'),
        run(4, 'CLI (Go, ubuntu-latest)', 'success'),
        run(5, 'E2E (browser + CLI interop, ubuntu-latest)', 'skipped'),
        run(6, 'CI green', 'failure'),
        // A failed job in another suite (a different workflow) must not be blamed.
        run(7, 'Analyze (go)', 'failure', { check_suite: { id: 99 } }),
    ];
    const d = decide(runs, 5, opts);
    assert.equal(d.code, 1);
    assert.match(d.lines[0], /^CI green: failure/);
    assert.ok(d.lines.some((l) => l.includes('Build & Lint')));
    assert.ok(!d.lines.some((l) => l.includes('Analyze (go)')));
    assert.ok(!d.lines.some((l) => l.includes('E2E')));
    assert.equal(d.lines.at(-1), 'gh run view 32288544822 --log-failed');
});

test('a completed gate with conclusion skipped or neutral is exit 1, never polled', () => {
    for (const conclusion of ['skipped', 'neutral']) {
        const d = decide(
            [
                run(1, 'Detect changed paths', 'success'),
                run(2, 'CI green', conclusion),
            ],
            0.5,
            opts
        );
        assert.equal(d.code, 1, conclusion);
        assert.match(d.lines[0], new RegExp(`^CI green: ${conclusion}`));
        assert.ok(
            d.lines.some((l) => l.includes('without its needs running')),
            conclusion
        );
        assert.equal(d.lines.at(-1), 'gh run view 32288544822 --log-failed');
    }
});

test('newest gate wins when the commit has several CI green runs', () => {
    const runs = [
        run(10, 'CI green', 'failure'),
        run(20, 'CI green', 'success'),
    ];
    assert.equal(decide(runs, 1, opts).code, 0);
    const flipped = [
        run(20, 'CI green', 'failure'),
        run(10, 'CI green', 'success'),
    ];
    assert.equal(decide(flipped, 1, opts).code, 1);
});

test('empty after grace: dropped-event exit 2 asks for corroboration', () => {
    const d = decide([], 3.5, opts);
    assert.equal(d.code, 2);
    assert.equal(d.corroborate, true);
});

test('empty before grace: keep polling', () => {
    const d = decide([], 1, opts);
    assert.equal(d.code, null);
    assert.match(d.lines[0], /queued, 0\/0 jobs/);
});

test('changes job seen but no gate yet: not a dropped event, keep polling', () => {
    const d = decide([run(1, 'Detect changed paths', 'success')], 5, opts);
    assert.equal(d.code, null);
});

test('in progress past the timeout: exit 3 lists what is still running', () => {
    const runs = [
        run(1, 'Detect changed paths', 'success'),
        run(2, 'Build & Lint', null, { status: 'in_progress' }),
        run(3, 'CI green', null, { status: 'queued' }),
    ];
    const d = decide(runs, 9.1, opts);
    assert.equal(d.code, 3);
    assert.ok(d.lines.some((l) => l.includes('Build & Lint')));
});

test('recoveryRef: head branch while open, base branch once merged', () => {
    assert.equal(
        recoveryRef({
            state: 'OPEN',
            headRefName: 'feat/x',
            baseRefName: 'main',
        }),
        'feat/x'
    );
    assert.equal(
        recoveryRef({
            state: 'MERGED',
            headRefName: 'feat/x',
            baseRefName: 'main',
        }),
        'main'
    );
    assert.equal(recoveryRef(undefined), null);
});

test('parseArgs: defaults, overrides, and rejects', () => {
    const a = parseArgs(['339']);
    assert.deepEqual(a, {
        target: '339',
        timeoutMin: 9,
        graceMin: 3,
        intervalSec: 25,
        repo: null,
    });
    const b = parseArgs([
        'abc1234',
        '--timeout-min',
        '1',
        '--grace-min',
        '0',
        '--repo',
        'o/r',
    ]);
    assert.equal(b.timeoutMin, 1);
    assert.equal(b.graceMin, 0);
    assert.equal(b.repo, 'o/r');
    assert.throws(() => parseArgs([]), /usage/);
    assert.throws(() => parseArgs(['1', '--bogus']), /unknown flag/);
    assert.throws(() => parseArgs(['1', '--timeout-min', 'x']), /non-negative/);
    assert.throws(() => parseArgs(['1', '--interval-sec', '0']), /at least 1/);
    assert.throws(() => parseArgs(['1', '--repo']), /--repo needs a value/);
    assert.throws(
        () => parseArgs(['1', '--repo', '--grace-min', '1']),
        /--repo needs a value/
    );
});
