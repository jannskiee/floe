// node --test .claude/skills/<skill>/scripts/lib/matrix.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    DEEP_IDS,
    DEFAULT_IDS,
    HASH_IDS,
    QUICK_IDS,
    REQUEST_ACCEPT_WAIT_MS,
    REQUEST_BLIP_MS,
    REQUEST_IDS,
    REQUEST_OPEN_IDS,
    REQUEST_VARIANTS,
    SKIP_REASONS,
    cellPlan,
    countsForExit,
    isLoopbackUrl,
    matchCells,
    parseCellId,
    phaseTimeouts,
} from './matrix.mjs';
import { ACCEPT_WAIT_MS } from './desktop.mjs';
import { UsageError } from './args.mjs';

const byId = (rows) => Object.fromEntries(rows.map((c) => [c.id, c]));

test('catalogue sizes: quick 6, default 18 (15 executable + 3 NA), deep +17', () => {
    assert.equal(QUICK_IDS.length, 6);
    assert.equal(DEFAULT_IDS.length, 18);
    assert.equal(DEEP_IDS.length, 17);
    const d = cellPlan();
    assert.equal(d.length, 18);
    assert.equal(d.filter((c) => !c.verdict).length, 15);
    assert.deepEqual(
        d.filter((c) => c.verdict === 'NA').map((c) => `${c.id}:${c.reason}`),
        [
            'S-DIR-D2D:single-instance',
            'S-REL-C2C:no-cli-relay-forcer',
            'S-REL-D2D:single-instance',
        ]
    );
    assert.equal(cellPlan({ subset: 'quick' }).length, 6);
    assert.equal(cellPlan({ subset: 'deep' }).length, 35);
    assert.deepEqual(
        cellPlan({ subset: 'quick' }).map((c) => c.id),
        [...QUICK_IDS]
    );
});

test('deep ids match the judge catalogue exactly', () => {
    assert.deepEqual(
        [...DEEP_IDS],
        [
            'S-DIR-C2C-bnd8',
            'S-DIR-W2C-bnd8',
            'S-DIR-C2C-sizes',
            'S-DIR-W2C-sizes',
            'S-DIR-C2D-sizes',
            'S-DIR-C2C-fold',
            'S-DIR-C2W-zip',
            'S-REL-C2W-cap3g',
            'S-DIR-C2C-thr500',
            'S-DIR-C2C-killsnd',
            'S-DIR-C2C-killrcv',
            'S-DIR-C2C-link',
            'S-DIR-C2D-link',
            'S-DIR-D2C-link',
            'S-DIR-L2C',
            'S-DIR-L2W',
            'S-DIR-L2D',
        ]
    );
});

test('every receiver leg carries statsOff: true', () => {
    for (const profile of ['shipped', 'head'])
        for (const c of cellPlan({
            profile,
            subset: 'deep',
            cliHasRelayOnly: true,
        }))
            assert.equal(c.receiver.statsOff, true, c.id);
});

test('input, forcer and no-relay rules', () => {
    const c = byId(cellPlan({ subset: 'deep' }));
    assert.equal(c['S-DIR-C2C'].receiver.input, 'code');
    assert.equal(c['S-DIR-C2D'].receiver.input, 'code');
    assert.equal(c['S-DIR-W2C'].receiver.input, 'link');
    assert.equal(c['S-DIR-C2W'].receiver.input, 'link');
    assert.equal(c['S-DIR-C2C-link'].receiver.input, 'link');
    assert.equal(c['S-DIR-C2D-link'].receiver.input, 'link');
    assert.equal(c['S-REL-W2C'].forcer, 'initScript');
    assert.equal(c['S-REL-W2C'].forcedSide, 'sender');
    assert.ok(
        c['S-REL-W2C'].sender.relayOnly && !c['S-REL-W2C'].receiver.relayOnly
    );
    assert.equal(c['S-REL-C2W'].forcedSide, 'receiver');
    assert.equal(c['S-REL-C2D'].forcer, 'hideIP');
    assert.equal(c['S-REL-C2D'].forcedSide, 'receiver');
    assert.equal(c['S-REL-D2C'].forcedSide, 'sender');
    assert.equal(c['S-REL-D2W'].forcer, 'initScript');
    assert.equal(c['S-REL-D2W'].forcedSide, 'receiver');
    assert.equal(c['S-REL-C2W-cap3g'].forcedSide, 'receiver');
    assert.ok(
        c['S-DIR-C2C'].sender.noRelay &&
            c['S-DIR-C2C'].receiver.noRelay &&
            c['S-DIR-C2C'].byConstruction
    );
    assert.ok(c['S-DIR-L2C'].byConstruction);
    assert.ok(
        !c['S-DIR-C2D'].sender.noRelay && !c['S-DIR-W2C'].receiver.noRelay
    );
    assert.ok(!c['S-REL-C2W'].sender.noRelay);
});

test('fixtures, expectations and cost per cell', () => {
    const c = byId(cellPlan({ subset: 'deep' }));
    assert.equal(c['S-DIR-W2W'].fixture.bytes, 12 * 1024 * 1024);
    assert.equal(c['S-REL-W2W'].fixture.bytes, 4 * 1024 * 1024);
    // Default-matrix DIR cells with a desktop side move 64 MiB so the pill
    // and completion oracles get a busy window; REL cells stay at 4 MiB
    // and the deep cells keep their 12 MiB.
    for (const id of ['S-DIR-W2D', 'S-DIR-C2D', 'S-DIR-D2W', 'S-DIR-D2C']) {
        assert.equal(c[id].fixture.bytes, 64 * 1024 * 1024, id);
        assert.equal(c[id].fixture.totalBytes, 64 * 1024 * 1024, id);
        assert.equal(c[id].timeouts.complete, 60_000, id);
    }
    for (const id of [
        'S-DIR-W2C',
        'S-DIR-C2W',
        'S-DIR-C2C',
        'S-DIR-C2D-link',
        'S-DIR-D2C-link',
    ])
        assert.equal(c[id].fixture.bytes, 12 * 1024 * 1024, id);
    // Every DIR cell with a desktop side moves the bigger fixture, so the
    // route pill stays decisive for longer than one sampler tick. L2D is
    // one of them: it is the only non-loopback desktop cell in the matrix.
    for (const id of [
        'S-DIR-W2D',
        'S-DIR-C2D',
        'S-DIR-D2W',
        'S-DIR-D2C',
        'S-DIR-L2D',
    ])
        assert.equal(c[id].fixture.bytes, 64 * 1024 * 1024, id);
    for (const id of ['S-REL-W2D', 'S-REL-C2D', 'S-REL-D2W', 'S-REL-D2C'])
        assert.equal(c[id].fixture.bytes, 4 * 1024 * 1024, id);
    const h = byId(cellPlan({ profile: 'head', subset: 'quick' }));
    assert.equal(h['H-DIR-D2C'].fixture.bytes, 64 * 1024 * 1024);
    assert.equal(h['H-DIR-C2D'].fixture.bytes, 64 * 1024 * 1024);
    assert.equal(c['S-DIR-C2C-bnd8'].fixture.kind, 'batch');
    assert.equal(c['S-DIR-C2C-bnd8'].fixture.sizes.length, 8);
    assert.equal(c['S-DIR-C2C-fold'].fixture.kind, 'folder');
    assert.equal(c['S-DIR-C2W-zip'].zipDownload, true);
    assert.equal(c['S-REL-C2W-cap3g'].fixture.kind, 'sparse');
    assert.equal(c['S-REL-C2W-cap3g'].expect, 'refusal');
    assert.equal(c['S-REL-C2W-cap3g'].retryable, false);
    assert.equal(c['S-DIR-C2C-killsnd'].expect, 'kill-sender');
    assert.equal(c['S-DIR-C2C-killrcv'].expect, 'kill-receiver');
    assert.equal(c['S-DIR-C2C-killrcv'].designedSecondAttempt, true);
    assert.equal(c['S-DIR-C2C-killsnd'].killAtBytes, 50 * 1024 * 1024);
    assert.equal(c['S-DIR-C2C-thr500'].fixture.bytes, 500 * 1024 * 1024);
    assert.deepEqual(c['S-DIR-C2W'].cost, { turn: 2, conn: 2, code: 1 });
    assert.deepEqual(c['S-DIR-W2W'].cost, { turn: 2, conn: 2, code: 0 });
    assert.deepEqual(c['S-DIR-C2C'].cost, { turn: 2, conn: 2, code: 2 });
});

test('phase timeouts follow the report design', () => {
    const c = byId(cellPlan({ subset: 'deep' }));
    assert.equal(c['S-DIR-W2W'].timeouts.link, 20_000);
    assert.equal(c['S-DIR-C2C'].timeouts.link, 30_000);
    assert.equal(c['S-DIR-W2W'].timeouts.connect, 45_000);
    assert.equal(c['S-DIR-W2D'].timeouts.connect, 60_000);
    assert.equal(c['S-REL-W2C'].timeouts.connect, 60_000);
    assert.equal(c['S-REL-C2D'].timeouts.connect, 75_000);
    assert.equal(c['S-DIR-W2W'].timeouts.firstBytes, 30_000);
    assert.equal(c['S-DIR-W2W'].timeouts.complete, 60_000);
    assert.equal(c['S-REL-W2W'].timeouts.complete, 90_000);
    assert.equal(
        c['S-DIR-C2C-thr500'].timeouts.complete,
        60_000,
        '500 MiB at 10 MB/s is 52 s, under the 60 s floor'
    );
    assert.equal(c['S-REL-C2W-cap3g'].timeouts.complete, 30_000);
    assert.equal(c['S-DIR-W2W'].timeouts.exit, 15_000);
    assert.ok(
        c['S-DIR-W2W'].timeouts.hardCap > c['S-DIR-W2W'].timeouts.complete
    );
    assert.equal(
        phaseTimeouts({
            path: 'REL',
            snd: 'C',
            rcv: 'C',
            expect: 'transfer',
            fixture: { totalBytes: 1e9 },
        }).complete,
        1000 * 1000
    );
    // Teardown covers DesktopLeg.stop's worst case (cancel 10 s, two
    // WM_CLOSE rounds of 15 s, 1 s) so the desktop.json restore inside it
    // is never cut off by the phase timeout.
    assert.equal(c['S-DIR-C2D'].timeouts.teardown, 60_000);
    assert.equal(c['S-DIR-D2C'].timeouts.teardown, 60_000);
    assert.equal(c['S-REL-W2D'].timeouts.teardown, 60_000);
    assert.equal(c['S-DIR-C2C'].timeouts.teardown, 30_000);
    assert.equal(c['S-DIR-W2W'].timeouts.teardown, 30_000);
});

test('gating: desktop probe, TURN, WSL, firewall, disk, desktop none', () => {
    const neg = {
        desktop: { receiverDrivable: false, saveDirSettable: true },
        turn: { prod: { servesTurn: false } },
        wsl: { present: false },
        firewall: { inboundAllow: false },
        disk: { freeBytes: 1024 },
    };
    const c = byId(cellPlan({ subset: 'deep', probe: neg }));
    assert.equal(c['S-DIR-C2D'].verdict, 'SKIP');
    assert.equal(c['S-DIR-C2D'].reason, 'uia-setvalue');
    assert.equal(c['S-DIR-W2D'].reason, 'uia-setvalue');
    assert.equal(
        c['S-DIR-D2C'].verdict,
        null,
        'desktop sender survives a negative P1'
    );
    assert.equal(c['S-REL-W2C'].reason, 'prod-turn-absent');
    assert.equal(
        c['S-REL-C2D'].reason,
        'uia-setvalue',
        'the desktop gate runs first'
    );
    assert.equal(c['S-REL-D2C'].reason, 'prod-turn-absent');
    assert.equal(c['S-DIR-L2C'].reason, 'wsl-stopped');
    assert.equal(c['S-DIR-C2C-thr500'].reason, 'disk-space');
    assert.equal(c['S-REL-C2W-cap3g'].reason, 'prod-turn-absent');
    // The firewall never gates a cell: a Block rule aborts the whole run
    // as a precondition, and a missing inbound Allow is not a reason to
    // skip, since an L2 cell's receiver is a Windows program with its own
    // rule and the connection leaves this machine either way.
    for (const firewall of [
        { inboundAllow: false, block: true },
        { inboundAllow: false, block: false },
        { inboundAllow: null },
    ])
        assert.equal(
            byId(
                cellPlan({
                    subset: 'deep',
                    probe: { wsl: { present: true }, firewall },
                })
            )['S-DIR-L2C'].verdict,
            null,
            JSON.stringify(firewall)
        );
    const sd = byId(
        cellPlan({
            probe: {
                desktop: { receiverDrivable: true, saveDirSettable: false },
            },
        })
    );
    assert.equal(sd['S-DIR-C2D'].reason, 'desktop-savedir');
    const none = byId(cellPlan({ desktopMode: 'none' }));
    assert.equal(none['S-DIR-D2C'].reason, 'desktop-none');
    assert.equal(none['S-DIR-D2D'].verdict, 'NA', 'NA wins over SKIP');
    const br = byId(cellPlan({ probe: { browserRelay: { ok: false } } }));
    assert.equal(br['S-REL-W2C'].reason, 'browser-relay-na');
    assert.equal(br['S-REL-C2D'].verdict, null);
    // Unknown probe values never gate.
    assert.equal(
        cellPlan({
            probe: {
                desktop: { receiverDrivable: null },
                turn: { prod: { servesTurn: null } },
            },
        }).filter((c) => c.verdict === 'SKIP').length,
        0
    );
});

test('quick with a negative P1 gives 5 executable + 1 SKIP uia-setvalue', () => {
    const q = cellPlan({
        subset: 'quick',
        probe: { desktop: { receiverDrivable: false } },
    });
    assert.equal(q.filter((c) => !c.verdict).length, 5);
    assert.equal(q.find((c) => c.id === 'S-DIR-C2D').reason, 'uia-setvalue');
});

test('head profile: H- ids, REL cells SKIP local-stun-only unless local TURN', () => {
    const h = cellPlan({
        profile: 'head',
        probe: { turn: { local: { servesTurn: false } } },
    });
    assert.ok(h.every((c) => c.id.startsWith('H-')));
    assert.equal(h.find((c) => c.id === 'H-REL-W2C').reason, 'local-stun-only');
    assert.equal(h.find((c) => c.id === 'H-REL-D2D').verdict, 'NA');
    const ht = cellPlan({
        profile: 'head',
        probe: { turn: { local: { servesTurn: true } } },
    });
    assert.equal(ht.find((c) => c.id === 'H-REL-W2C').verdict, null);
    assert.equal(
        cellPlan({
            profile: 'head',
            probe: { desktop: { headBuild: false } },
        }).find((c) => c.id === 'H-DIR-D2C').reason,
        'head-desktop-pending'
    );
    assert.throws(() => cellPlan({ profile: 'prod' }), /unknown profile/);
});

test('--relay-only flips S-REL-C2C from NA to executable', () => {
    const on = cellPlan({ cliHasRelayOnly: true }).find(
        (c) => c.id === 'S-REL-C2C'
    );
    assert.equal(on.verdict, null);
    assert.equal(on.forcer, 'relayOnlyFlag');
    assert.equal(on.forcedSide, 'sender');
    assert.ok(on.sender.relayOnly);
});

test('--cells filter marks the rest SKIP filtered, which never counts for exit', () => {
    const rows = cellPlan({ cells: ['S-DIR-W2*', 's-rel-c2w'] });
    const kept = rows.filter((c) => !c.verdict).map((c) => c.id);
    assert.deepEqual(kept, [
        'S-DIR-W2W',
        'S-DIR-W2C',
        'S-DIR-W2D',
        'S-REL-C2W',
    ]);
    const filtered = rows.find((c) => c.id === 'S-DIR-C2C');
    assert.equal(filtered.reason, 'filtered');
    assert.equal(countsForExit(filtered), false);
    // The filter wins over a machine gate: a desktop cell nobody asked for
    // is filtered (uncounted), not desktop-none (counted).
    const gated = cellPlan({
        cells: ['S-DIR-W2W'],
        desktopMode: 'none',
        probe: { turn: { prod: { servesTurn: false } } },
    });
    assert.equal(gated.find((c) => c.id === 'S-DIR-C2D').reason, 'filtered');
    assert.equal(gated.find((c) => c.id === 'S-REL-W2C').reason, 'filtered');
    assert.equal(gated.find((c) => c.id === 'S-DIR-W2W').verdict, null);
    assert.equal(
        gated.filter((c) => c.verdict === 'SKIP' && countsForExit(c)).length,
        0
    );
    assert.equal(countsForExit({ verdict: 'NA' }), false);
    assert.equal(
        countsForExit({ verdict: 'SKIP', reason: 'uia-setvalue' }),
        true
    );
    assert.equal(countsForExit({ verdict: 'PASS' }), true);
    assert.ok(matchCells('S-DIR-W2W', ['S-DIR-W?W']));
    assert.ok(!matchCells('S-DIR-W2W', ['S-DIR-C*']));
    assert.ok(matchCells('anything', null));
});

test('parseCellId', () => {
    assert.deepEqual(parseCellId('H-REL-D2C-link'), {
        id: 'H-REL-D2C-link',
        profile: 'H',
        path: 'REL',
        snd: 'D',
        rcv: 'C',
        variant: 'link',
    });
    assert.throws(() => parseCellId('S-DIR-X2C'), /bad cell id/);
});

test('the size ladder spans one byte to a large file in a single batch', () => {
    const c = byId(cellPlan({ subset: 'deep' }));
    const ids = ['S-DIR-C2C-sizes', 'S-DIR-W2C-sizes', 'S-DIR-C2D-sizes'];
    for (const id of ids) {
        const f = c[id].fixture;
        assert.equal(f.kind, 'batch', id);
        assert.deepEqual(
            f.sizes,
            [1, 1024, 65536, 1048576, 10485760, 104857600],
            id
        );
        assert.equal(
            f.totalBytes,
            f.sizes.reduce((a, b) => a + b, 0),
            id
        );
        assert.equal(c[id].expect, 'transfer', id);
        assert.equal(c[id].path, 'DIR', id + ' stays off the relay');
    }
    // One cell per engine: the Go CLI, the browser sender, and the desktop
    // as a multi-file receiver (every other desktop cell moves one file).
    assert.equal(c['S-DIR-C2C-sizes'].sender.surface, 'cli');
    assert.equal(c['S-DIR-W2C-sizes'].sender.surface, 'web');
    assert.equal(c['S-DIR-C2D-sizes'].receiver.surface, 'desktop');
    // The ladder complements the chunk-boundary cell, it does not repeat it.
    assert.notDeepEqual(
        c['S-DIR-C2C-sizes'].fixture.sizes,
        c['S-DIR-C2C-bnd8'].fixture.sizes
    );
    // Relay budget is untouched: no ladder cell is a REL cell.
    assert.equal(
        cellPlan({ subset: 'deep' }).filter(
            (x) => x.variant === 'sizes' && x.path === 'REL'
        ).length,
        0
    );
});

test('the forced-mismatch cells: refusal, a hashLie, and no other cell lies', () => {
    const plan = cellPlan({ profile: 'head', cells: HASH_IDS });
    const cells = plan.filter((c) => HASH_IDS.includes(c.id));
    assert.equal(cells.length, HASH_IDS.length, 'every hash id plans a cell');
    // Everything else is skipped, most of it as filtered and the rest by a gate
    // that runs before the filter (a same-surface desktop pair, for instance).
    for (const other of plan.filter((c) => !HASH_IDS.includes(c.id))) {
        assert.ok(other.verdict, `${other.id} was not asked for, so it must not run`);
    }
    for (const cell of cells) {
        assert.equal(cell.expect, 'refusal', `${cell.id} expects a refusal`);
        assert.equal(
            cell.hashLie,
            cell.variant === 'hashmal' ? 'malformed' : 'corrupt',
            `${cell.id} says how its sender lies`
        );
        assert.equal(cell.profile, 'H', 'head profile only');
    }
    // Nothing that ships a normal transfer carries a lie.
    for (const cell of cellPlan({ subset: 'deep' })) {
        assert.equal(cell.hashLie, null, `${cell.id} must not lie about a digest`);
    }
    // They stay out of the lists a run walks by default.
    for (const id of HASH_IDS) {
        assert.ok(!DEFAULT_IDS.includes(id), `${id} is not a default cell`);
        assert.ok(!DEEP_IDS.includes(id), `${id} is not a deep cell`);
    }
});

test('a shipped run never executes a head-only hash cell against production', () => {
    // --profile shipped --cells H-DIR-W2C-hashbad would have opened
    // www.floe.one with a sender that lies (P0-27 review F3).
    const plan = cellPlan({ profile: 'shipped', cells: HASH_IDS });
    const hash = plan.filter((c) => HASH_IDS.includes(c.id));
    assert.equal(hash.length, HASH_IDS.length);
    for (const cell of hash) {
        assert.equal(cell.verdict, 'SKIP', `${cell.id} must not run in a shipped run`);
        assert.equal(cell.reason, 'head-only');
    }
    assert.ok(SKIP_REASONS['head-only'], 'the skip reason is documented');
    // The same ids in a head run are executable (their other gates permitting).
    const head = cellPlan({ profile: 'head', cells: ['H-DIR-W2C-hashbad'] });
    const w2c = head.find((c) => c.id === 'H-DIR-W2C-hashbad');
    assert.ok(!w2c.verdict, `${w2c.id} runs in a head run (verdict ${w2c.verdict})`);
});

test('matrix.md documents every hash id and variant the code knows', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const md = readFileSync(join(here, '..', '..', 'references', 'matrix.md'), 'utf8');
    for (const id of HASH_IDS) {
        const variant = parseCellId(id).variant;
        assert.ok(md.includes(variant), `matrix.md names the ${variant} variant`);
    }
    assert.ok(md.includes('hashbad'), 'matrix.md names hashbad');
    assert.ok(md.includes('hashmal'), 'matrix.md names hashmal');
    assert.ok(md.includes('HASH_IDS'), 'matrix.md points at the id list in the code');
});

// ------------------------------------------------ request link cells

const WITH_FEATURE = {
    server: { features: ['request-1'] },
    desktop: { available: true },
};
const LOCAL = 'http://localhost:3001';
const requestPlan = (profile, probe = WITH_FEATURE) =>
    cellPlan({
        profile,
        cells: REQUEST_IDS,
        probe,
        server: profile === 'head' ? LOCAL : 'https://api.floe.one',
    }).filter((c) => REQUEST_IDS.includes(c.id));

function requestTableIds() {
    const here = dirname(fileURLToPath(import.meta.url));
    const md = readFileSync(
        join(here, '..', '..', 'references', 'matrix.md'),
        'utf8'
    );
    const start = md.indexOf('## Request-link cells (need request-1)');
    assert.ok(start >= 0, 'matrix.md has the Request-link cells section');
    const end = md.indexOf('\n## ', start + 5);
    const section = md.slice(start, end < 0 ? undefined : end);
    const row = /^\|\s*([SH]-(?:DIR|REL)-[WCDL]2[WCDL]-[a-z0-9]+)\s*\|/;
    return section
        .split('\n')
        .map((l) => row.exec(l))
        .filter(Boolean)
        .map((m) => m[1]);
}

test('matrix.md and cellPlan agree on every request link cell, both ways', () => {
    const table = requestTableIds();
    assert.deepEqual([...table].sort(), [...REQUEST_IDS].sort());
    const planned = [...requestPlan('shipped'), ...requestPlan('head')].map(
        (c) => c.id
    );
    for (const id of REQUEST_IDS)
        assert.ok(planned.includes(id), `${id} has a cellPlan entry`);
    for (const id of table)
        assert.ok(REQUEST_VARIANTS.includes(parseCellId(id).variant), id);
    assert.equal(
        REQUEST_OPEN_IDS.length,
        QUICK_IDS.length,
        'TA-17 is all six quick cells'
    );
});

test('request cells SKIP server-no-request-1 without the feature, and absent or malformed counts as absent', () => {
    assert.match(SKIP_REASONS['server-no-request-1'], /probe P10/);
    for (const probe of [
        {},
        { server: null },
        { server: { features: null } },
        { server: { features: 'request-1' } },
        { server: { features: ['request-2'] } },
    ]) {
        for (const profile of ['shipped', 'head']) {
            const rows = requestPlan(profile, {
                ...probe,
                desktop: { available: true },
            }).filter((c) => c.reason !== 'head-only');
            assert.ok(rows.length > 0);
            for (const c of rows)
                assert.equal(
                    c.reason,
                    'server-no-request-1',
                    `${c.id} ${JSON.stringify(probe)}`
                );
        }
    }
    const head = requestPlan('head');
    assert.ok(head.length > 0);
    for (const c of head) assert.equal(c.verdict, null, `${c.id} runs with request-1`);
});

test('request cells are never in a walk without --cells, and every receiver leg is opted out', () => {
    for (const subset of ['quick', 'default', 'deep'])
        for (const profile of ['shipped', 'head'])
            assert.ok(
                !cellPlan({ profile, subset }).some((c) => c.request),
                `${profile}/${subset} plans no request cell`
            );
    for (const c of [...requestPlan('shipped'), ...requestPlan('head')])
        assert.equal(c.receiver.statsOff, true, c.id);
});

test('request cells: sizes, inputs, forcers, flows and the Accept wait', () => {
    const all = byId([...requestPlan('shipped'), ...requestPlan('head')]);
    const MiB = 1024 * 1024;
    const want = {
        'S-DIR-W2D-req': [64 * MiB, 'request-link', 'none', null, 'accept'],
        'S-REL-W2D-req': [4 * MiB, 'request-link', 'initScript', 'sender', 'accept'],
        'S-REL-W2D-reqhideip': [4 * MiB, 'request-link', 'hideIP', 'receiver', 'accept'],
        'H-DIR-W2D-reqblip': [64 * MiB, 'request-link', 'none', null, 'blip-then-accept'],
        'H-DIR-W2D-reqdecline': [MiB, 'request-link', 'none', null, 'decline-then-accept'],
        'S-DIR-W2W-reqopen': [12 * MiB, 'link', 'none', null, 'open-link-precondition'],
        'S-REL-W2C-reqopen': [4 * MiB, 'link', 'initScript', 'sender', 'open-link-precondition'],
        'S-DIR-C2D-reqopen': [64 * MiB, 'code', 'none', null, 'open-link-precondition'],
        'H-REL-W2D-req': [4 * MiB, 'request-link', 'initScript', 'sender', 'accept'],
    };
    for (const [id, [bytes, input, forcer, side, flow]] of Object.entries(want)) {
        const c = all[id];
        assert.ok(c, id);
        assert.equal(c.fixture.totalBytes, bytes, `${id} size`);
        assert.equal(c.receiver.input, input, `${id} input`);
        assert.equal(c.forcer, forcer, `${id} forcer`);
        assert.equal(c.forcedSide, side, `${id} forced side`);
        assert.equal(c.request.flow, flow, `${id} flow`);
        assert.equal(c.request.feature, 'request-1');
    }
    assert.equal(all['S-REL-W2D-reqhideip'].receiver.relayOnly, true);
    assert.equal(all['S-REL-W2D-reqhideip'].sender.relayOnly, false);
    assert.equal(all['H-DIR-W2D-reqblip'].request.blipMs, REQUEST_BLIP_MS);
    assert.equal(REQUEST_BLIP_MS, 5_000);
    assert.equal(all['H-DIR-W2D-reqdecline'].request.visitors, 2);
    assert.equal(REQUEST_ACCEPT_WAIT_MS, ACCEPT_WAIT_MS, 'one Accept wait');
    assert.ok(REQUEST_ACCEPT_WAIT_MS >= 1200);
    for (const c of Object.values(all)) {
        if (c.request.flow === 'open-link-precondition') continue;
        assert.equal(c.request.acceptWaitMs, REQUEST_ACCEPT_WAIT_MS);
        assert.ok(c.timeouts.accept >= REQUEST_ACCEPT_WAIT_MS);
        assert.ok(c.request.oracles.includes('visitor-stats-attempts-0'), c.id);
    }
    // TA-17's W2W has no desktop leg, but its host is the desktop.
    const none = cellPlan({
        profile: 'shipped',
        cells: ['S-DIR-W2W-reqopen'],
        probe: WITH_FEATURE,
        desktopMode: 'none',
    }).find((c) => c.id === 'S-DIR-W2W-reqopen');
    assert.equal(none.reason, 'desktop-none');
});

test('reqblip refuses any server that is not loopback, as a usage error before anything is created', () => {
    for (const server of [
        'https://api.floe.one',
        'http://192.168.1.10:3001',
        'http://localhost.evil.example:3001',
        'ws://localhost:3001',
        'not a url',
        null,
    ]) {
        assert.throws(
            () =>
                cellPlan({
                    profile: 'head',
                    cells: ['H-DIR-W2D-reqblip'],
                    probe: WITH_FEATURE,
                    server,
                }),
            (e) => e instanceof UsageError && /loopback/.test(e.message),
            String(server)
        );
    }
    for (const server of [
        'http://localhost:3001',
        'http://127.0.0.1:3001',
        'http://[::1]:3001',
    ])
        assert.ok(isLoopbackUrl(server), server);
    const ok = cellPlan({
        profile: 'head',
        cells: ['H-DIR-W2D-reqblip'],
        probe: WITH_FEATURE,
        server: LOCAL,
    }).find((c) => c.id === 'H-DIR-W2D-reqblip');
    assert.equal(ok.verdict, null);
    assert.equal(ok.request.loopbackOnly, true);
    // A shipped run that names it SKIPs head-only and never reaches a server.
    const shipped = cellPlan({
        profile: 'shipped',
        cells: ['H-DIR-W2D-reqblip'],
        probe: WITH_FEATURE,
        server: 'https://api.floe.one',
    }).find((c) => c.id === 'H-DIR-W2D-reqblip');
    assert.equal(shipped.reason, 'head-only');
    // Only the blip cell carries the loopback rule.
    for (const c of requestPlan('head'))
        assert.equal(c.request.loopbackOnly, c.id === 'H-DIR-W2D-reqblip', c.id);
});
