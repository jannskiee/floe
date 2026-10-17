// lib/request.mjs, the request link runner (WP-R2), through runCell on the
// fake world of tests/fake-request-world.mjs: the real DesktopLeg and
// PlaywrightDriver on a scripted wailsdev host view, the real Visitor on a
// fake Playwright page, a fake blip proxy, all on one fake clock. Each cell
// of spec 09 2.7.2 that runs today (TA-10, 11, 12, 13, 15 and 17) is driven
// to PASS, and every oracle is driven to its own failure words.
//
// Run: node --test .claude/skills/transfer-audit/scripts/lib/request.test.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { recordDesktopConfig, runCell } from './cell.mjs';
import {
    ACCEPT_UNDRIVABLE,
    ACCEPT_WAIT_MS,
    PlaywrightDriver,
} from './desktop.mjs';
import { SKIP_REASONS, cellPlan } from './matrix.mjs';
import { Ledger } from './pacing.mjs';
import { buildRunJson, newSafety, renderMarkdown, safetyRows } from './report.mjs';
import {
    AWAY_ONLY,
    DAILY_LIMIT,
    START_SETTLE_MS,
    hostStartSettled,
    scrubDeep,
} from './request.mjs';
import { SafetyError } from './surfaces.mjs';
import { FAKE_ROOM } from './tests/fake-request-dom.mjs';
import { fakeWorld, makeFakeAdapters } from './tests/fake-legs.mjs';
import { BLIP_URL, CADDY_URL, fakeRequestWorld } from './tests/fake-request-world.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'lta-request-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

const LOCAL = 'http://localhost:3001';
const WEB = 'http://localhost:3000';
const FEATURE = {
    server: { features: ['request-1'] },
    desktop: { available: true },
};

const plan = Object.fromEntries(
    [
        ...cellPlan({
            profile: 'head',
            cells: ['H-*'],
            probe: FEATURE,
            server: LOCAL,
            desktopMode: 'wailsdev',
            // TA-14 plans only when the run names --caddy.
            caddy: true,
        }),
        // TA-12 and the Auto-accept twins exist as shipped ids only. A real
        // shipped run cannot ask for the dev page, so its host is an exe;
        // this plan is made only to get the cells, and the runner does not
        // care which profile an id carries.
        ...cellPlan({
            profile: 'shipped',
            cells: [
                'S-REL-W2D-reqhideip',
                'S-DIR-W2D-reqauto',
                'S-DIR-C2D-reqauto',
            ],
            probe: FEATURE,
            desktopMode: 'wailsdev',
        }),
    ]
        .filter((c) => c.request && !c.verdict)
        .map((c) => [c.id, c])
);

function small(id) {
    const cell = structuredClone(plan[id]);
    assert.ok(cell, `${id} is planned and executable`);
    cell.fixture = { kind: 'single', bytes: 4096, totalBytes: 4096 };
    if (cell.request.flow === 'open-link-precondition') {
        cell.timeouts.complete = 5000;
        cell.timeouts.firstBytes = 1000;
        cell.timeouts.exit = 1000;
        cell.timeouts.route = 300;
    }
    return cell;
}

let n = 0;
function ctxFor(world, extra = {}) {
    const logs = [];
    const plain = makeFakeAdapters(fakeWorld());
    const ctx = {
        // The host and the visitor browser come from the request world; a
        // quick cell's own legs (TA-17) from the plain fakes. The quick
        // cell's desktop leg is a plain fake too: only the host is labeled.
        getAdapter: async (name) => {
            if (name === 'web')
                return { ...plain.web, getBrowser: world.adapters.web.getBrowser };
            if (name === 'desktop')
                return {
                    ...plain.desktop,
                    createLeg: (o) =>
                        o.label === 'host'
                            ? world.adapters.desktop.createLeg(o)
                            : plain.desktop.createLeg(o),
                };
            // TA-16's CLI visitor comes from the request world; a quick
            // cell's own CLI legs stay the plain fakes.
            if (name === 'cli')
                return {
                    ...plain.cli,
                    createLeg: (o) =>
                        o.requestLink
                            ? world.adapters.cli.createLeg(o)
                            : plain.cli.createLeg(o),
                };
            return plain[name];
        },
        ledger: Ledger.relaxed({ now: () => Date.now() }),
        infra: {
            name: 'local',
            server: LOCAL,
            web: WEB,
            servesTurn: true,
            relaxed: true,
            statsOracle: 'none',
        },
        buildFor: (surface) => ({
            kind: 'head',
            version: 'head',
            path: null,
            launch: surface === 'desktop' ? 'wailsdev' : undefined,
        }),
        evidenceRoot: path.join(dir, `run-${++n}`),
        fixturesDir: path.join(dir, 'fixtures', String(n)),
        log: (l) => logs.push(l),
        logs,
        safety: newSafety(),
        retry: { used: 0, cap: 3 },
        sleep: async () => {},
        clock: world.clock,
        startBlip: world.startBlip,
        statsOracle: null,
        retryWaitMs: 0,
        drainWaitMs: 0,
        ...extra,
    };
    return ctx;
}

/** Every file the attempt wrote, as one string, for the redaction checks. */
function attemptText(ctx, id) {
    const root = path.join(ctx.evidenceRoot, 'cells', id);
    const out = [];
    const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.json$/.test(e.name)) out.push(readFileSync(p, 'utf8'));
        }
    };
    if (existsSync(root)) walk(root);
    return out.join('\n');
}

function assertNoRoom(ctx, r, id) {
    for (const [what, text] of [
        ['result', JSON.stringify(r)],
        ['attempt files', attemptText(ctx, id)],
        ['log lines', ctx.logs.join('\n')],
    ])
        assert.ok(!text.includes(FAKE_ROOM), `no room in the ${what}`);
}

const clicksOf = (w, name) => w.dom.clicks.filter((c) => c.name === name);
const attemptJson = (a) =>
    JSON.parse(readFileSync(path.join(a.evidence.dir, 'attempt.json'), 'utf8'));

// ----------------------------------------------------------- happy paths

test('TA-10 H-DIR-W2D-req: Make link into the run folder, Accept after 1.2 s, the drop is the manifest in its subfolder, and the host is left as found', async () => {
    const w = fakeRequestWorld();
    const ctx = ctxFor(w);
    const r = await runCell(small('H-DIR-W2D-req'), ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    const a = r.attempts[0];
    // Make link went to the run's own folder, never Downloads\Floe.
    // H7 has no Beta switch: the runner waited for the REQUEST LINK tab and
    // never opened Settings.
    assert.equal(w.dom.madeWith.requestLinks, undefined, 'no Beta switch exists to be on');
    assert.equal(clicksOf(w, 'Settings').length, 0, 'Settings was never opened');
    assert.equal(a.request.tab.via, 'playwright');
    assert.equal(path.dirname(path.dirname(r.integrity.files[0].where)), a.outDir);
    // Accept no earlier than the guard allows.
    const acceptClick = clicksOf(w, 'Accept');
    assert.equal(acceptClick.length, 1);
    assert.ok(acceptClick[0].t - w.dom.promptMountedAt >= ACCEPT_WAIT_MS);
    assert.deepEqual(w.dom.ignored, []);
    // The oracles, in the record.
    assert.deepEqual(a.request.prompts, [{ files: 1, totalBytes: 4096, warnings: [] }]);
    assert.deepEqual(a.request.result, { files: 1, saved: 1, verified: 1, renamed: 0 });
    assert.equal(a.request.hostView.heading, 'RECEIVED 1 FILE, 0.0 MB');
    assert.equal(a.request.hostView.verifiedLine, true);
    assert.equal(a.request.usedUp, 'This link has already been used');
    assert.equal(r.integrity.ok, true);
    assert.equal(r.integrity.subfolder, 'Floe request 1');
    assert.equal(r.route.observed, 'direct');
    assert.equal(r.completion.sender.text, '1 FILE ARRIVED');
    assert.equal(r.completion.receiver.text, 'RECEIVED 1 FILE, 0.0 MB');
    // Safety: the host counted as an opted-out receiver, no visitor tried
    // to report, and the link is shown only without its room.
    assert.deepEqual(
        { ok: ctx.safety.desktopReceiversOptedOut.ok, total: ctx.safety.desktopReceiversOptedOut.total },
        { ok: 1, total: 1 }
    );
    assert.equal(ctx.safety.statsReportAttempts, 0);
    assert.equal(a.request.link, 'http://localhost:3000/r/Xk3p9Q0aB1c#<room>');
    assertNoRoom(ctx, r, 'H-DIR-W2D-req');
    // Left as found: the result put away, both visitor contexts closed, the
    // host page closed.
    assert.equal(a.request.released, 'ready');
    assert.ok(w.visitors.every((v) => v.closed));
    assert.equal(w.visitors.length, 2, 'the sender and the used-link checker');
    assert.equal(w.dom.closed, true);
    // The host's captures live under private/ on disk, and the summary the
    // report reads carries their count, never their paths.
    const onDisk = attemptJson(a).evidence.receiver.captures.map((c) => c.path);
    assert.ok(onDisk.length > 0, 'the host was captured');
    for (const c of onDisk) assert.match(c, /[\\/]private[\\/]host[\\/]/);
    assert.deepEqual(a.evidence.captures, []);
    assert.equal(a.evidence.privateCaptures, onDisk.length);
});

// The request.mjs header promises the host captures (which can show the
// link on screen) are never quoted by audit.md or run.json; the first live
// run's audit.md quoted them in every FAIL block's Evidence line
// (2026-09-24).
test('audit.md and run.json never quote a private/host capture path: the attempt folder stands in', async () => {
    const w = fakeRequestWorld({ faults: ['not-used-up'] });
    const ctx = ctxFor(w);
    const r = await runCell(small('H-DIR-W2D-req'), ctx);
    assert.equal(r.verdict, 'FAIL', r.note);
    const a = r.attempts[0];
    const onDisk = attemptJson(a).evidence.receiver.captures.map((c) => c.path);
    assert.ok(onDisk.length > 0 && onDisk.every((p) => /[\\/]private[\\/]host[\\/]/.test(p)));
    const run = {
        runId: 'r1',
        profile: 'head',
        subset: 'default',
        cells: [r],
        safety: ctx.safety,
        exitCode: 1,
    };
    const md = renderMarkdown(run);
    const json = JSON.stringify(buildRunJson(run));
    for (const [what, text] of [
        ['audit.md', md],
        ['run.json', json],
    ])
        assert.ok(!/[\\/]private[\\/]/.test(text), `${what} quotes a private path`);
    const evidence = md.split('\n').find((l) => l.startsWith('Evidence: '));
    assert.equal(evidence, `Evidence: ${a.evidence.dir}`);
    assert.equal(a.evidence.privateCaptures, onDisk.length);
});

test('a request link cell never runs as a plain cell: no plain web, CLI or desktop leg starts', async () => {
    const w = fakeRequestWorld();
    let plainLegs = 0;
    const ctx = ctxFor(w);
    const inner = ctx.getAdapter;
    ctx.getAdapter = async (name) => {
        const mod = await inner(name);
        if (!mod || typeof mod.createLeg !== 'function') return mod;
        return {
            ...mod,
            createLeg: (o) => {
                if (o.label !== 'host') plainLegs += 1;
                return mod.createLeg(o);
            },
        };
    };
    const r = await runCell(small('H-DIR-W2D-req'), ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    assert.equal(plainLegs, 0);
});

test('TA-16 H-DIR-C2D-req: the CLI visitor joins by itself, the host accepts, and the drop is the manifest in its subfolder; the link never reaches the record', async () => {
    const w = fakeRequestWorld();
    const ctx = ctxFor(w);
    const r = await runCell(small('H-DIR-C2D-req'), ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    const a = r.attempts[0];
    assert.equal(w.cliVisitors.length, 1, 'one CLI visitor');
    assert.equal(w.visitors.length, 0, 'no web visitor, not even a used-link checker');
    // Accept no earlier than the guard allows, on a prompt with the
    // visitor's own count and bytes.
    const acceptClick = clicksOf(w, 'Accept');
    assert.equal(acceptClick.length, 1);
    assert.ok(acceptClick[0].t - w.dom.promptMountedAt >= ACCEPT_WAIT_MS);
    assert.deepEqual(a.request.prompts, [{ files: 1, totalBytes: 4096, warnings: [] }]);
    // The oracles: exit 0, TL-03's arrived line, the SHA line with every
    // file verified, the host's Done copy, the files in their subfolder.
    assert.equal(a.request.visitorExit, 0);
    assert.equal(r.completion.sender.text, '1 file arrived (4 KB in 0s, direct).');
    assert.deepEqual(a.request.result, { files: 1, saved: 1, verified: 1, renamed: 0 });
    assert.equal(a.request.hostView.heading, 'RECEIVED 1 FILE, 0.0 MB');
    assert.equal(a.request.hostView.verifiedLine, true);
    assert.equal(a.request.usedUp, null, 'the used-up check stays with the web cells');
    assert.equal(r.integrity.ok, true);
    assert.equal(r.integrity.subfolder, 'Floe request 1');
    assert.equal(r.route.observed, 'direct');
    // Safety: the host is an opted-out receiver and the CLI ran with
    // FLOE_NO_STATS=1; nothing tried to report.
    assert.deepEqual(
        { ok: ctx.safety.desktopReceiversOptedOut.ok, total: ctx.safety.desktopReceiversOptedOut.total },
        { ok: 1, total: 1 }
    );
    assert.equal(ctx.safety.statsReportAttempts, 0);
    assert.equal(w.cliVisitors[0].opts.requestLink.includes(FAKE_ROOM), true, 'the CLI got the whole link');
    // The link went to the CLI's argv, and every record keeps it redacted.
    assertNoRoom(ctx, r, 'H-DIR-C2D-req');
    const sender = attemptJson(a).evidence.sender;
    assert.ok(sender.argv.includes('--to'));
    assert.ok(sender.argv.some((x) => /\/r\/Xk3p9Q0aB1c#<room>$/.test(x)), 'the link in argv is redacted');
    assert.deepEqual(sender.statsProof, { kind: 'sender-env', floeNoStats: '1' });
    // Left as found: the result put away, the CLI stopped.
    assert.equal(a.request.released, 'ready');
    assert.equal(w.cliVisitors[0].stopped, 'done');
    assert.equal(w.dom.closed, true);
});

test('TA-16 failures name what broke: the CLI exits 1 on its line, exits 0 without TL-03, prints the SHA line over a short verify, the host verified short, runs without FLOE_NO_STATS, or the host stops the drop', async () => {
    for (const [faults, re] of [
        [['cli-exit'], /the CLI visitor exited 1 on "Connection lost\. 0 of 1 file arrived/],
        [['cli-no-arrived'], /the CLI visitor exited 0 with no arrived line/],
        [['verified-short', 'sha-line-lie'], /the visitor's SHA line shows with 0 of 1 verified/],
        [['verified-short'], /the host verified 0 of 1 file/],
        [['cli-stats-env'], /stats-attempt: the CLI visitor ran without FLOE_NO_STATS=1/],
        [['stopped'], /hash-mismatch: the host stopped the drop \(hash-mismatch\)/],
    ]) {
        const w = fakeRequestWorld({ faults });
        const ctx = ctxFor(w);
        const r = await runCell(small('H-DIR-C2D-req'), ctx);
        assert.equal(r.verdict, 'FAIL', `${faults}: ${r.note}`);
        assert.match(r.note, re, `${faults}`);
        assertNoRoom(ctx, r, 'H-DIR-C2D-req');
        assert.equal(w.cliVisitors.at(-1).stopped, 'failed', `${faults}: the CLI visitor was stopped`);
        assert.equal(r.attempts.length, 1, `${faults}: a request-flow finding is never retried`);
    }
});

test('TA-11 H-REL-W2D-req: the relay-forced visitor reads local=relay and the host agrees', async () => {
    const w = fakeRequestWorld({ route: 'relay' });
    const ctx = ctxFor(w);
    const r = await runCell(small('H-REL-W2D-req'), ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    assert.equal(r.route.observed, 'relay');
    assert.equal(w.visitors[0].relayOnly, true, 'the sender page carries the relay forcer');
    assert.equal(w.visitors[1].relayOnly, false, 'the used-link checker does not need it');
    const src = r.route.sources.find((s) => s.side === 'sender');
    assert.equal(src.local, 'relay');
    assert.equal(w.dom.settings.hideIP, false, 'the host was never forced');
});

test('TA-12 S-REL-W2D-reqhideip: Hide my IP is on before Make link, the host reads relay, and the switch is put back', async () => {
    const w = fakeRequestWorld({ route: 'relay' });
    const ctx = ctxFor(w);
    const r = await runCell(small('S-REL-W2D-reqhideip'), ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    assert.equal(w.dom.madeWith.hideIP, true, 'the link was made with Hide my IP on');
    assert.equal(w.dom.settings.hideIP, false, 'and it is off again');
    assert.ok(!w.visitors[0].relayOnly, 'the visitor is not forced');
    const hostSrc = r.route.sources.find((s) => s.side === 'receiver');
    assert.equal(hostSrc.value, 'relay');
});

test('TA-13 H-DIR-W2D-reqblip: the host goes through the blip, a visitor in the cut reads not connected, the reclaim lets Try again deliver, and the addresses go back', async () => {
    const w = fakeRequestWorld();
    const ctx = ctxFor(w);
    const r = await runCell(small('H-DIR-W2D-reqblip'), ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    const a = r.attempts[0];
    assert.equal(w.blips.length, 1);
    assert.equal(w.blips[0].upstream, LOCAL, 'the proxy fronts the server under test');
    assert.deepEqual(w.blips[0].cuts.map((c) => c.ms), [5000]);
    assert.equal(w.blips[0].stopped, true);
    assert.equal(w.dom.madeWith.server, BLIP_URL, 'the link was made through the proxy');
    assert.equal(w.dom.madeWith.web, WEB, 'and still points at the web under test');
    assert.deepEqual(a.request.blip, {
        cutMs: 5000,
        liveBefore: 1,
        reconnecting: true,
        hostAbsent: true,
        reclaimed: true,
        destroyed: 1,
    });
    const titles = attemptJson(a).evidence.visitors[0].titles.map((t) => t.titles);
    assert.ok(titles.includes('Their computer is not connected right now'));
    assert.equal(titles.at(-1), '1 FILE ARRIVED', 'the same visitor delivered after Try again');
    assert.deepEqual(a.request.addresses, { swapped: true, restored: true });
    assert.equal(w.dom.settings.server, LOCAL);
    assert.equal(w.dom.settings.web, '');
});

// The first live TA-13 run (2026-09-24) cut a proxy the host was never
// behind and FAILed request-flow "the host read waiting 5000 ms on": a
// harness fault that read as a product defect. Each way the host can miss
// the proxy is now an ERROR blip-url before any cut.
test('TA-13 with a blip proxy that hands back no URL: ERROR blip-url in the blip phase, and no host is driven', async () => {
    const w = fakeRequestWorld();
    const ctx = ctxFor(w, {
        startBlip: async (o) => {
            const b = await w.startBlip(o);
            Object.defineProperty(b, 'url', { value: undefined });
            return b;
        },
    });
    const r = await runCell(small('H-DIR-W2D-reqblip'), ctx);
    assert.equal(r.verdict, 'ERROR', r.note);
    assert.equal(r.reason, 'blip-url', r.note);
    assert.equal(r.attempts[0].failedPhase, 'blip');
    assert.equal(r.attempts[0].signatureKey, 'blip-url');
    assert.match(r.note, /blip-url: the blip proxy handed back no loopback URL/);
    assert.equal(clicksOf(w, 'Make link').length, 0, 'no link was made');
    assert.equal(w.dom.settings.server, LOCAL, 'the host address was never touched');
    assert.equal(w.blips[0].cuts.length, 0, 'nothing was cut');
    assert.equal(w.blips[0].stopped, true, 'the proxy was still stopped');
});

test('TA-13 with a host whose Settings keep the old server: ERROR blip-url in host.start, before any link', async () => {
    const w = fakeRequestWorld({ host: { addressesStuck: true } });
    const r = await runCell(small('H-DIR-W2D-reqblip'), ctxFor(w));
    assert.equal(r.verdict, 'ERROR', r.note);
    assert.equal(r.reason, 'blip-url', r.note);
    assert.equal(r.attempts[0].failedPhase, 'host.start');
    assert.match(r.note, /blip-url: the host did not take the blip proxy as its server address/);
    assert.equal(clicksOf(w, 'Make link').length, 0, 'no link was made');
    assert.equal(w.blips[0].cuts.length, 0, 'nothing was cut');
});

test('TA-13 with a host that is not behind the proxy (0 live sockets): ERROR blip-url before the cut, never a request-flow FAIL', async () => {
    const w = fakeRequestWorld({ host: { ignoreServer: true } });
    const r = await runCell(small('H-DIR-W2D-reqblip'), ctxFor(w));
    assert.equal(r.verdict, 'ERROR', r.note);
    assert.equal(r.reason, 'blip-url', r.note);
    assert.equal(r.attempts[0].failedPhase, 'request');
    assert.match(r.note, /blip-url: no socket runs through the blip proxy before the cut/);
    assert.equal(r.attempts[0].request.blip.liveBefore, 0);
    assert.equal(w.blips[0].cuts.length, 0, 'nothing was cut');
    assert.equal(w.visitors.length, 0, 'no visitor opened the link');
    assert.equal(w.dom.state, 'closed', 'the link was still closed at teardown');
});

test('TA-15 H-DIR-W2D-reqdecline: Decline after the guard, the declined copy, Keep waiting reopens, a second visitor delivers', async () => {
    const w = fakeRequestWorld();
    const ctx = ctxFor(w);
    const r = await runCell(small('H-DIR-W2D-reqdecline'), ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    const a = r.attempts[0];
    const decline = clicksOf(w, 'Decline');
    assert.equal(decline.length, 1);
    assert.equal(a.request.declined, 'They declined. Nothing was sent.');
    assert.equal(a.request.reopened, true);
    assert.equal(w.dom.reopens, 1, 'Keep waiting sent one request-reopen');
    assert.deepEqual(a.request.answers.map((x) => x.answer), ['decline', 'accept']);
    for (const x of a.request.answers) assert.ok(x.waitedMs >= ACCEPT_WAIT_MS, x.answer);
    assert.equal(w.visitors.length, 3, 'the declined visitor, the second visitor and the checker');
    assert.equal(attemptJson(a).evidence.sender.tag, 'visitor-2', 'the second visitor delivered');
    assert.equal(a.request.prompts.length, 2);
});

test('TA-17 H-DIR-W2C-reqopen: the quick cell passes with a link open, the same link still waits afterwards, and it is closed at teardown', async () => {
    const w = fakeRequestWorld();
    const ctx = ctxFor(w);
    const r = await runCell(small('H-DIR-W2C-reqopen'), ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    const a = r.attempts[0];
    assert.equal(a.request.after, 'waiting');
    assert.equal(a.request.link, 'http://localhost:3000/r/Xk3p9Q0aB1c#<room>');
    assert.equal(w.dom.state, 'closed', 'Close link at teardown');
    assert.equal(w.visitors.length, 0, 'no visitor ever opened the link');
    assertNoRoom(ctx, r, 'H-DIR-W2C-reqopen');

    // The link closing under the quick cell is the finding.
    const w2 = fakeRequestWorld();
    const ctx2 = ctxFor(w2);
    const inner = ctx2.getAdapter;
    ctx2.getAdapter = async (name) => {
        const mod = await inner(name);
        if (name !== 'cli') return mod;
        return {
            ...mod,
            createLeg: (o) => {
                const leg = mod.createLeg(o);
                const done = leg.awaitDone.bind(leg);
                leg.awaitDone = async (ms) => {
                    w2.dom.state = 'closed';
                    return done(ms);
                };
                return leg;
            },
        };
    };
    const f = await runCell(small('H-DIR-W2C-reqopen'), ctx2);
    assert.equal(f.verdict, 'FAIL');
    assert.equal(f.reason, 'request-flow');
    assert.match(f.note, /the open link did not survive the quick cell \(the host reads ended\)/);
});

/**
 * ctx whose desktop sender (a plain fake leg) first stages its files the
 * way DesktopLeg.startSender does on the wailsdev lane: PlaywrightDriver
 * .stage on the sender's own page, which sits on the same dev server as
 * the host's (fake-request-dom devPeerPage).
 */
function withDesktopSenderStaging(w, ctx) {
    const peer = w.host.devPeerPage();
    const inner = ctx.getAdapter;
    ctx.getAdapter = async (name) => {
        const mod = await inner(name);
        if (name !== 'desktop') return mod;
        return {
            ...mod,
            createLeg: (o) => {
                const leg = mod.createLeg(o);
                if (o.label === 'host' || o.role !== 'sender') return leg;
                const start = leg.start.bind(leg);
                leg.start = async (...args) => {
                    await new PlaywrightDriver(peer, null, {}).stage(o.files);
                    return start(...args);
                };
                return leg;
            },
        };
    };
    return peer;
}

test('TA-17 H-DIR-D2C-reqopen: the desktop sender stages on its own page only, so the host keeps REQUEST LINK and its link is closed at teardown', async () => {
    const w = fakeRequestWorld();
    const ctx = ctxFor(w);
    const peer = withDesktopSenderStaging(w, ctx);
    const r = await runCell(small('H-DIR-D2C-reqopen'), ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    const a = r.attempts[0];
    assert.ok(!a.notes.some((l) => /host release/.test(l)), a.notes.join(' | '));
    assert.equal(a.request.after, 'waiting');
    assert.equal(a.request.released, 'ended');
    assert.equal(w.dom.state, 'closed', 'Close link at teardown');
    assert.deepEqual(w.dom.broadcasts, [], 'nothing was rebroadcast to the host page');
    assert.equal(w.dom.mode, 'receive', 'the host page never left Receive');
    assert.equal(peer.peer.notified.length, 1, 'the sender page was handed its files');
});

test('TA-17 whose host page is moved to Send by another page mid-cell: the release goes back to REQUEST LINK and closes the link', async () => {
    const w = fakeRequestWorld();
    const ctx = ctxFor(w);
    const peer = w.host.devPeerPage();
    const inner = ctx.getAdapter;
    ctx.getAdapter = async (name) => {
        const mod = await inner(name);
        if (name !== 'cli') return mod;
        return {
            ...mod,
            createLeg: (o) => {
                const leg = mod.createLeg(o);
                const start = leg.start.bind(leg);
                // Any page on the dev server that broadcasts files:open
                // (an older driver, the owner's second tab).
                leg.start = async (...args) => {
                    await peer.evaluate(() =>
                        window.runtime.EventsEmit('files:open', ['C:\\fx\\other.bin'])
                    );
                    return start(...args);
                };
                return leg;
            },
        };
    };
    const r = await runCell(small('H-DIR-C2W-reqopen'), ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    const a = r.attempts[0];
    assert.ok(!a.notes.some((l) => /host release/.test(l)), a.notes.join(' | '));
    assert.equal(w.dom.broadcasts.length, 1, 'the host page did receive the broadcast');
    assert.equal(a.request.released, 'ended');
    assert.equal(w.dom.state, 'closed', 'Close link at teardown');
});

// ------------------------------------------------------- failure words

const failures = [
    ['H-DIR-W2D-req', ['hash-bad'], 'FAIL', 'hash-mismatch', /hash-mismatch: /],
    ['H-DIR-W2D-req', ['extra-file'], 'FAIL', 'request-manifest', /request-manifest: missing none; extra .*extra\.bin/],
    ['H-DIR-W2D-req', ['stray-file'], 'FAIL', 'request-manifest', /stray\.bin landed beside the drop subfolder, not inside it/],
    ['H-DIR-W2D-req', ['part-left'], 'FAIL', 'stale-part', /stale-part: .*left\.bin\.part left in the drop subfolder/],
    ['H-DIR-W2D-req', ['verified-short'], 'FAIL', 'request-flow', /the host verified 0 of 1 file\(s\)/],
    ['H-DIR-W2D-req', ['verified-short', 'sha-line-lie'], 'FAIL', 'request-flow', /the visitor's SHA line shows with 0 of 1 verified/],
    ['H-DIR-W2D-req', ['heading-lie'], 'FAIL', 'request-flow', /the host's SHA sentence is missing with 1 of 1 verified/],
    ['H-DIR-W2D-req', ['stopped'], 'FAIL', 'hash-mismatch', /the host stopped the drop \(hash-mismatch\)/],
    ['H-DIR-W2D-req', ['no-prompt'], 'FAIL', 'request-flow', /the host read waiting \d+ ms on, not the Accept prompt/],
    ['H-DIR-W2D-req', ['prompt-lie'], 'FAIL', 'request-flow', /the prompt reads 2 file\(s\) and 4096 bytes; the visitor offered 1 and 4096/],
    ['H-DIR-W2D-req', ['not-used-up'], 'FAIL', 'request-flow', /the link is not used up after the drop/],
    ['H-DIR-W2D-req', ['visitor-stats'], 'FAIL', 'stats-attempt', /stats-attempt: the visitor-1 tried to report 1 time\(s\) \(all aborted\)/],
    ['H-DIR-W2D-req', ['visitor-seed'], 'FAIL', 'stats-attempt', /floe:report-stats reads "true", not "false"/],
    ['H-DIR-W2D-req', ['make-error'], 'FAIL', 'request-flow', /Make link ended in error \(disabled\)/],
    ['H-REL-W2D-req', ['init-script'], 'ERROR', 'init-script-not-applied', /init-script-not-applied/],
    ['H-DIR-W2D-reqdecline', ['decline-copy'], 'FAIL', 'request-flow', /the visitor-1 read "They did not answer in time\. Nothing was sent\." instead of "They declined\. Nothing was sent\."/],
    ['H-DIR-W2D-reqblip', ['blip-no-absent'], 'FAIL', 'request-flow', /did not read "Their computer is not connected right now" within \d+ ms/],
    ['H-DIR-W2D-reqblip', ['no-reclaim'], 'FAIL', 'request-flow', /not Waiting again after the cut \(the reclaim\)/],
    ['H-DIR-W2D-reqauto', ['auto-asks'], 'FAIL', 'request-flow', /the host went deciding while waiting for the drop to start by itself/],
    ['H-DIR-W2D-reqauto', ['auto-unmarked'], 'FAIL', 'request-flow', /the host's result is not marked as accepted automatically/],
    ['H-DIR-W2D-reqauto', ['auto-chip-ready'], 'FAIL', 'request-flow', /the header chip reads "Ready" while the automatic link waits, not AUTO-ACCEPT/],
];

for (const [id, faults, verdict, reason, words] of failures) {
    test(`${id} with ${faults.join('+')}: ${verdict} ${reason}`, async () => {
        const w = fakeRequestWorld({ faults });
        const ctx = ctxFor(w);
        const r = await runCell(small(id), ctx);
        assert.equal(r.verdict, verdict, r.note);
        assert.equal(r.reason, reason, r.note);
        assert.match(r.note, words);
        assert.equal(r.attempts.length, 1, 'a request failure is never retried');
        // Whatever failed, the host is left with no open link.
        assert.ok(!['waiting', 'deciding', 'declined', 'reconnecting'].includes(w.dom.state), w.dom.state);
        assert.equal(w.dom.closed, true);
        if (faults.includes('visitor-stats'))
            assert.ok(ctx.safety.statsReportAttempts >= 1, 'the attempt reaches the Safety table');
        assertNoRoom(ctx, r, id);
    });
}

test('a DIR request cell that reads relay is route-mismatch', async () => {
    const w = fakeRequestWorld({ route: 'relay' });
    const r = await runCell(small('H-DIR-W2D-req'), ctxFor(w));
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, 'route-mismatch');
});

test('a floe:bytes-reported event on a visitor is a safety breach, never a cell verdict', async () => {
    const w = fakeRequestWorld({ faults: ['bytes-reported'] });
    await assert.rejects(runCell(small('H-DIR-W2D-req'), ctxFor(w)), SafetyError);
    assert.equal(w.dom.closed, true, 'the host was still released');
});

test('TA-10a H-DIR-W2D-reqauto: Make link with Auto-accept on, AUTO-ACCEPT while it waits, the drop starts with no prompt and no click, and the result is marked (D-173)', async () => {
    const w = fakeRequestWorld();
    const ctx = ctxFor(w);
    const r = await runCell(small('H-DIR-W2D-reqauto'), ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    const a = r.attempts[0];
    assert.deepEqual(a.request.made, { lifetime: '24h', autoAccept: true, onScreen: true });
    assert.deepEqual(w.dom.switched, ['Auto-accept']);
    assert.equal(a.request.auto.pill, 'Auto-accept');
    assert.ok(['receiving', 'done'].includes(a.request.auto.started), a.request.auto.started);
    // No prompt at any point, and nothing clicked on the host to start it.
    assert.equal(w.dom.promptGen, 0);
    assert.deepEqual(a.request.prompts, []);
    assert.deepEqual(a.request.answers, []);
    assert.equal(clicksOf(w, 'Accept').length, 0);
    assert.deepEqual(a.request.result, { files: 1, saved: 1, verified: 1, renamed: 0, autoAccepted: true });
    // Every TA-10 oracle still holds, and the host is left as found.
    assert.equal(r.integrity.ok, true);
    assert.equal(r.route.observed, 'direct');
    assert.equal(a.request.usedUp, 'This link has already been used');
    assert.equal(a.request.released, 'ready');
    assert.equal(w.dom.closed, true);
    assertNoRoom(ctx, r, 'H-DIR-W2D-reqauto');
});

test('TA-10a on a build without the Auto-accept switch SKIPs request-no-auto-switch and makes no link', async () => {
    const w = fakeRequestWorld({ faults: ['no-auto-switch'] });
    const r = await runCell(small('H-DIR-W2D-reqauto'), ctxFor(w));
    assert.equal(r.verdict, 'SKIP', r.note);
    assert.equal(r.reason, 'request-no-auto-switch');
    assert.equal(clicksOf(w, 'Make link').length, 0);
    assert.equal(w.visitors.length, 0);
});

test('TA-10 on a host that marks a prompted drop as automatic FAILs by name', async () => {
    const w = fakeRequestWorld();
    const base = w.dom.onTick;
    w.dom.onTick = (t) => {
        base(t);
        if (w.dom.result) w.dom.result.autoAccepted = true;
    };
    const r = await runCell(small('H-DIR-W2D-req'), ctxFor(w));
    assert.equal(r.verdict, 'FAIL', r.note);
    assert.match(r.note, /the host marked a drop it prompted for as accepted automatically/);
    assert.deepEqual(r.attempts[0].request.made, { lifetime: '24h', autoAccept: false, onScreen: true });
});

test('a Save to field that does not take SKIPs desktop-savedir and makes no link', async () => {
    const w = fakeRequestWorld({ host: { saveDirStuck: true } });
    const r = await runCell(small('H-DIR-W2D-req'), ctxFor(w));
    assert.equal(r.verdict, 'SKIP');
    assert.equal(r.reason, 'desktop-savedir');
    assert.equal(clicksOf(w, 'Make link').length, 0);
});

// An exe host (FU-26): the UIA request verbs over the same scripted view.
const EXE_BUILD = (surface) => ({
    kind: 'head',
    version: 'head',
    path: 'x.exe',
    launch: surface === 'desktop' ? 'portable' : undefined,
});

// The server makes 20 links per network address per day
// (REQUEST_CREATES_PER_DAY in server/server.js) and answers the next Make link
// with `limited`. That is this machine's budget running out, not a product
// defect: it used to read FAIL request-flow, once per request cell left in the
// run, each of them launching the host to learn the same thing.
test("the server's daily create refusal (limited) is SKIP request-daily-limit, on both host lanes, and later request cells SKIP before their host launches", async () => {
    const shared = {};
    const w = fakeRequestWorld({ host: { makeError: 'limited' } });
    const ctx = ctxFor(w, { shared });
    const r = await runCell(small('H-DIR-W2D-req'), ctx);
    assert.equal(r.verdict, 'SKIP', r.note);
    assert.equal(r.reason, DAILY_LIMIT);
    assert.equal(r.triage, null, 'a SKIP names no triage row');
    assert.match(r.note, /20 request links a day/);
    assert.equal(r.attempts.length, 1, 'never retried');
    assert.equal(r.attempts[0].failedPhase, 'host.start');
    assert.equal(clicksOf(w, 'Make link').length, 1);
    assert.equal(w.visitors.length, 0, 'no visitor was opened');
    assert.equal(w.dom.closed, true, 'the host was stopped');
    assert.equal(shared.requestLimited, true);
    assert.ok(
        SKIP_REASONS[DAILY_LIMIT],
        'the reason has its line in the legend'
    );

    // The next request cell of the run: nothing launches, on an exe host too.
    const w2 = fakeRequestWorld({ lane: 'uia' });
    const ctx2 = ctxFor(w2, { shared, buildFor: EXE_BUILD, userAway: true });
    const r2 = await runCell(small('H-DIR-W2D-reqdecline'), ctx2);
    assert.equal(r2.verdict, 'SKIP', r2.note);
    assert.equal(r2.reason, DAILY_LIMIT);
    assert.equal(w2.launchEdits.length, 0, 'nothing launched');
    assert.equal(w2.dom.clicks.length, 0);
    assert.equal(w2.visitors.length, 0);

    // TA-17 makes a link too: its quick cell never starts a leg.
    const w3 = fakeRequestWorld();
    const r3 = await runCell(
        small('H-DIR-W2W-reqopen'),
        ctxFor(w3, { shared })
    );
    assert.equal(r3.verdict, 'SKIP', r3.note);
    assert.equal(r3.reason, DAILY_LIMIT);
    assert.equal(r3.attempts[0].phases['sender.start'], undefined);
    assert.equal(w3.dom.clicks.length, 0);

    // The UIA lane reads the same refusal from the error view's fixed copy.
    const w4 = fakeRequestWorld({
        lane: 'uia',
        host: { makeError: 'limited' },
    });
    const ctx4 = ctxFor(w4, { buildFor: EXE_BUILD, userAway: true });
    const r4 = await runCell(small('H-DIR-W2D-req'), ctx4);
    assert.equal(r4.verdict, 'SKIP', r4.note);
    assert.equal(r4.reason, DAILY_LIMIT);
    assert.equal(
        ctx4.shared.requestLimited,
        true,
        'a run without a shared record gets one'
    );

    // Any other Make link error stays the finding it was.
    const w5 = fakeRequestWorld({ faults: ['make-error'] });
    const r5 = await runCell(small('H-DIR-W2D-req'), ctxFor(w5));
    assert.equal(r5.verdict, 'FAIL', r5.note);
    assert.equal(r5.reason, 'request-flow');
    assert.match(r5.note, /Make link ended in error \(disabled\)/);
});

test('an exe host without --user-away never opens: the runner SKIPs request-host-away-only before anything launches, and the plan SKIPs it first, as present or (with only --allow-foreground) away-only (G2-F1)', async () => {
    const w = fakeRequestWorld({ lane: 'uia' });
    const ctx = ctxFor(w, { buildFor: EXE_BUILD });
    const r = await runCell(small('H-DIR-W2D-req'), ctx);
    assert.equal(r.verdict, 'SKIP');
    assert.equal(r.reason, AWAY_ONLY);
    assert.equal(w.launchEdits.length, 0, 'nothing launched');
    assert.equal(w.dom.clicks.length, 0);
    assert.equal(w.visitors.length, 0);
    // And the plan says so before any run: a request cell off wailsdev.
    const planned = (flags) =>
        cellPlan({
            profile: 'head',
            cells: ['H-DIR-W2D-req'],
            probe: FEATURE,
            server: LOCAL,
            desktopMode: 'auto',
            ...flags,
        }).find((c) => c.id === 'H-DIR-W2D-req');
    assert.equal(
        planned({}).reason,
        'present',
        'nothing on an exe lane is driven by default'
    );
    const off = planned({ allowForeground: true });
    assert.equal(off.reason, AWAY_ONLY);
    const away = cellPlan({
        profile: 'head',
        cells: ['H-DIR-W2D-req'],
        probe: FEATURE,
        server: LOCAL,
        desktopMode: 'auto',
        userAway: true,
    }).find((c) => c.id === 'H-DIR-W2D-req');
    assert.equal(away.verdict, null, 'with --user-away the exe host runs');
});

// F2: on a built exe a UIA Invoke cannot press Accept (the prompt's guard
// re-arms on every focus change, and an Invoke is one). A prompted cell on
// that lane therefore proves everything up to the prompt and stops as SKIP
// request-accept-undrivable, with the prompt on record and nothing invoked.
// It used to try three Invokes and end FAIL unknown or ERROR exception.
test('TA-10 on an exe host (UIA, away-only): the link is made, the prompt is read as the view renders it, and the cell stops as SKIP request-accept-undrivable with no Accept invoked and the host left as found', async () => {
    for (const lostForeground of [false, true]) {
        const w = fakeRequestWorld({ lane: 'uia' });
        if (lostForeground) {
            // Once a visitor sends, the window is no longer the foreground one.
            const origSend = w.visitorSend;
            w.visitorSend = (v) => {
                if (w.uiaClient) w.uiaClient.state.focused = false;
                return origSend(v);
            };
        }
        const ctx = ctxFor(w, { buildFor: EXE_BUILD, userAway: true });
        const r = await runCell(small('H-DIR-W2D-req'), ctx);
        assert.equal(r.verdict, 'SKIP', r.note);
        assert.equal(r.reason, ACCEPT_UNDRIVABLE);
        assert.equal(r.triage, null);
        assert.equal(r.attempts.length, 1, 'never retried');
        const a = r.attempts[0];
        assert.equal(a.failedPhase, 'request');
        assert.equal(
            'requestLinks' in w.launchEdits[0],
            false,
            'desktop.json carries no Beta key'
        );
        assert.equal(a.request.tab.via, 'uia');
        assert.equal(
            w.uiaClient.calls.filter(([c]) => c === 'toggle').length,
            0,
            'no switch was toggled'
        );
        // What the lane did prove: the link, and the prompt with the
        // visitor's own count and its size as P2 renders it.
        assert.match(a.request.link, /#<room>$/);
        assert.deepEqual(a.request.prompts, [
            { files: 1, totalBytes: null, sizeText: '4.0 KB', warnings: [] },
        ]);
        assert.deepEqual(a.request.answers, [], 'nothing was answered');
        assert.equal(
            w.uiaClient.calls.filter(
                ([c, p]) => c === 'click' && p.name === 'Accept'
            ).length,
            0,
            'no Accept was invoked'
        );
        assert.equal(w.uiaClient.state.swallowed.length, 0);
        assert.deepEqual(w.dom.ignored, []);
        // Nothing was delivered, and the host is left as found: the link
        // this cell made is closed.
        assert.equal(r.integrity.ok, null);
        assert.equal(a.request.released, 'ended');
        assert.equal(clicksOf(w, 'Close link').length, 1);
        const calls = w.uiaClient.calls.map(([c]) => c);
        const patterns = calls.filter((c) =>
            ['click', 'set-value', 'toggle'].includes(c)
        ).length;
        assert.ok(
            calls.filter((c) => c === 'foreground-check').length >= patterns
        );
        assertNoRoom(ctx, r, 'H-DIR-W2D-req');
    }
});

// H7 (D-160): the REQUEST LINK tab is always there. The runner waits for it
// and never opens Settings; the server's request-1 answer is the only gate,
// and Make link is where a server without it says so (E1).
test('a legacy requestLinks:false in the host config is ignored: Settings is never opened, the key is never written, and the cell passes on the tab alone', async () => {
    const w = fakeRequestWorld({ host: { settings: { requestLinks: false } } });
    const r = await runCell(small('H-DIR-W2D-req'), ctxFor(w));
    assert.equal(r.verdict, 'PASS', r.note);
    assert.equal(clicksOf(w, 'Settings').length, 0, 'Settings was never opened');
    assert.equal(w.dom.settingsOpen, false);
    assert.equal(w.dom.settings.requestLinks, false, 'the legacy key was not written');
});

test('a server without request-1 (the kill switch): the REQUEST LINK tab is still there to click and Make link ends in E1, named as such', async () => {
    const w = fakeRequestWorld({ host: { featureOn: false } });
    const r = await runCell(small('H-DIR-W2D-req'), ctxFor(w));
    assert.equal(r.verdict, 'FAIL', r.note);
    assert.equal(r.reason, 'request-flow');
    assert.match(r.note, /Make link ended in error \(disabled\)/);
    assert.ok(clicksOf(w, 'Request link').length >= 1, 'the tab was there');
    assert.equal(clicksOf(w, 'Settings').length, 0, 'no Settings visit to turn anything on');
    assert.equal(r.attempts.length, 1, 'a request-flow finding is never retried');
});

test('a build that does not show the REQUEST LINK tab is a keyed request-flow FAIL at host.start after 10 s, never a wait on a missing button', async () => {
    const w = fakeRequestWorld({ host: { hideTab: true } });
    const t0 = w.host.now();
    const r = await runCell(small('H-DIR-W2D-req'), ctxFor(w));
    assert.equal(r.verdict, 'FAIL', r.note);
    assert.equal(r.reason, 'request-flow');
    assert.equal(r.attempts[0].failedPhase, 'host.start');
    assert.match(r.note, /the REQUEST LINK tab did not show within 10000 ms/);
    assert.ok(w.host.now() - t0 < 30_000, `${w.host.now() - t0} ms of fake time`);
    assert.equal(clicksOf(w, 'Make link').length, 0, 'no link was made');
    assert.equal(clicksOf(w, 'Settings').length, 0);
});

// The Auto-accept twins: the delivery an exe host can prove, because nothing
// has to press Accept (F2). The lane sets the form's check through
// TogglePattern, takes the link block's "Accepts automatically" as the record
// of the choice (an exe has no GetRequestLink), and then only reads: the drop
// must start and finish with no prompt at any point and no click on the host.
test('S-DIR-W2D-reqauto on an exe host (UIA, away-only): the check is set through Toggle, the link says Accepts automatically, the drop arrives with no prompt and no Accept, and every oracle the done view carries holds', async () => {
    const w = fakeRequestWorld({ lane: 'uia' });
    const ctx = ctxFor(w, { buildFor: EXE_BUILD, userAway: true });
    const r = await runCell(small('S-DIR-W2D-reqauto'), ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    assert.equal(r.attempts.length, 1);
    const a = r.attempts[0];
    assert.deepEqual(a.request.made, {
        lifetime: '24h',
        autoAccept: true,
        onScreen: true,
    });
    assert.deepEqual(w.dom.switched, ['Auto-accept']);
    assert.equal(
        w.uiaClient.calls.filter(([c]) => c === 'toggle').length,
        1,
        "one Toggle, the form's check"
    );
    assert.equal(a.request.auto.pill, 'Auto-accept');
    assert.ok(
        ['receiving', 'done'].includes(a.request.auto.started),
        a.request.auto.started
    );
    assert.equal(a.request.auto.proof, 'link-block');
    // No prompt at any point, and nothing invoked on the host to start it.
    assert.equal(w.dom.promptGen, 0);
    assert.deepEqual(a.request.prompts, []);
    assert.deepEqual(a.request.answers, []);
    assert.equal(
        w.uiaClient.calls.filter(
            ([c, p]) => c === 'click' && /^(accept|decline)$/i.test(p.name)
        ).length,
        0
    );
    // The done view is the host's whole account here, and the automatic mark
    // is not on it: the record says the lane could not read it.
    assert.deepEqual(a.request.result, {
        files: 1,
        saved: 1,
        verified: 1,
        renamed: 0,
        autoAccepted: null,
    });
    assert.equal(a.request.hostView.heading, 'RECEIVED 1 FILE, 0.0 MB');
    assert.equal(a.request.hostView.verifiedLine, true);
    assert.equal(r.integrity.ok, true);
    assert.equal(r.integrity.subfolder, 'Floe request 1');
    assert.equal(r.route.observed, 'direct');
    assert.equal(a.request.usedUp, 'This link has already been used');
    assert.deepEqual(
        {
            ok: ctx.safety.desktopReceiversOptedOut.ok,
            total: ctx.safety.desktopReceiversOptedOut.total,
        },
        { ok: 1, total: 1 }
    );
    assert.equal(ctx.safety.statsReportAttempts, 0);
    // Left as found, and every pattern call had its idle check first.
    assert.equal(a.request.released, 'ready');
    const calls = w.uiaClient.calls.map(([c]) => c);
    const patterns = calls.filter((c) =>
        ['click', 'set-value', 'toggle'].includes(c)
    ).length;
    assert.ok(calls.filter((c) => c === 'foreground-check').length >= patterns);
    assertNoRoom(ctx, r, 'S-DIR-W2D-reqauto');
});

test('S-DIR-C2D-reqauto on an exe host: the CLI is the visitor (floe send --to), nothing is clicked on the host, and the drop is delivered and verified', async () => {
    const w = fakeRequestWorld({ lane: 'uia' });
    const ctx = ctxFor(w, { buildFor: EXE_BUILD, userAway: true });
    const r = await runCell(small('S-DIR-C2D-reqauto'), ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    const a = r.attempts[0];
    assert.equal(w.cliVisitors.length, 1, 'one CLI visitor');
    assert.equal(
        w.visitors.length,
        0,
        'no web visitor, not even a used-link checker'
    );
    assert.deepEqual(a.request.made, {
        lifetime: '24h',
        autoAccept: true,
        onScreen: true,
    });
    assert.equal(a.request.auto.proof, 'link-block');
    assert.equal(w.dom.promptGen, 0);
    assert.deepEqual(a.request.prompts, []);
    assert.deepEqual(a.request.answers, []);
    assert.equal(
        w.uiaClient.calls.filter(
            ([c, p]) => c === 'click' && /^(accept|decline)$/i.test(p.name)
        ).length,
        0
    );
    assert.equal(a.request.visitorExit, 0);
    assert.equal(
        r.completion.sender.text,
        '1 file arrived (4 KB in 0s, direct).'
    );
    assert.deepEqual(a.request.result, {
        files: 1,
        saved: 1,
        verified: 1,
        renamed: 0,
        autoAccepted: null,
    });
    assert.equal(a.request.hostView.verifiedLine, true);
    assert.equal(
        a.request.usedUp,
        null,
        'the used-up check stays with the web cells'
    );
    assert.equal(r.integrity.ok, true);
    assert.equal(r.route.observed, 'direct');
    assert.equal(ctx.safety.statsReportAttempts, 0);
    const sender = attemptJson(a).evidence.sender;
    assert.ok(sender.argv.includes('--to'));
    assert.deepEqual(sender.statsProof, {
        kind: 'sender-env',
        floeNoStats: '1',
    });
    assert.equal(a.request.released, 'ready');
    assert.equal(w.cliVisitors[0].stopped, 'done');
    assertNoRoom(ctx, r, 'S-DIR-C2D-reqauto');
});

// The same cell on the dev page, where the host's own record is readable: the
// link's autoAccept and the result's automatic mark (GetRequestLink).
test('S-DIR-C2D-reqauto on the dev page: the CLI visitor on an automatic link, proven by the host record', async () => {
    const w = fakeRequestWorld();
    const ctx = ctxFor(w);
    const r = await runCell(small('S-DIR-C2D-reqauto'), ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    const a = r.attempts[0];
    assert.equal(w.cliVisitors.length, 1);
    assert.equal(a.request.auto.proof, 'host-record');
    assert.deepEqual(a.request.result, {
        files: 1,
        saved: 1,
        verified: 1,
        renamed: 0,
        autoAccepted: true,
    });
    assert.equal(clicksOf(w, 'Accept').length, 0);
    assert.equal(a.request.visitorExit, 0);
    assert.equal(a.request.released, 'ready');
});

const exeAuto = [
    [
        { faults: ['auto-asks'] },
        'FAIL',
        'request-flow',
        /the host went deciding while waiting for the drop to start by itself/,
    ],
    [
        { faults: ['auto-chip-ready'] },
        'FAIL',
        'request-flow',
        /the header chip reads "Ready" while the automatic link waits, not AUTO-ACCEPT/,
    ],
    [
        { faults: ['no-auto-switch'] },
        'SKIP',
        'request-no-auto-switch',
        /Auto-accept/,
    ],
    [
        { host: { autoScope: 'none' } },
        'FAIL',
        'request-flow',
        /its link block does not say "Accepts automatically"/,
    ],
    [
        { host: { autoScope: 'low-space' } },
        'FAIL',
        'request-flow',
        /the link reads "Asks first, low space on C:"/,
    ],
];
for (const [world, verdict, reason, words] of exeAuto) {
    test(`S-DIR-W2D-reqauto on an exe host with ${JSON.stringify(world)}: ${verdict} ${reason}, no prompt is ever answered, and no link is left open`, async () => {
        const w = fakeRequestWorld({ lane: 'uia', ...world });
        const ctx = ctxFor(w, { buildFor: EXE_BUILD, userAway: true });
        const r = await runCell(small('S-DIR-W2D-reqauto'), ctx);
        assert.equal(r.verdict, verdict, r.note);
        assert.equal(r.reason, reason, r.note);
        assert.match(r.note, words);
        assert.equal(r.attempts.length, 1, 'never retried');
        if (!(world.faults || []).includes('auto-asks'))
            assert.equal(w.sends.length, 0, 'nothing was sent');
        assert.equal(
            w.uiaClient.calls.filter(
                ([c, p]) => c === 'click' && /^(accept|decline)$/i.test(p.name)
            ).length,
            0,
            'the lane never answers a prompt'
        );
        assert.ok(
            !['waiting', 'deciding', 'declined', 'reconnecting'].includes(
                w.dom.state
            ),
            w.dom.state
        );
        assert.equal(w.dom.closed, true);
        assertNoRoom(ctx, r, 'S-DIR-W2D-reqauto');
    });
}

// The app learns that the drive is under the floor a moment after Make link
// (desktop/requestauto.go watchAutoSpace runs on its own goroutine), so the
// link block can say W5a first and W5b next. The runner looks once more just
// before the visitor sends, on both lanes, and names the drive instead of
// leaving a prompt nobody can answer.
test('an automatic link that turns to Asks first once it waits is named before the visitor sends, on both lanes and for both visitors', async () => {
    for (const [lane, id] of [
        ['uia', 'S-DIR-W2D-reqauto'],
        ['uia', 'S-DIR-C2D-reqauto'],
        ['wailsdev', 'H-DIR-W2D-reqauto'],
    ]) {
        const w = fakeRequestWorld({ lane });
        const ctx = ctxFor(
            w,
            lane === 'uia' ? { buildFor: EXE_BUILD, userAway: true } : {}
        );
        // The runner logs the link once Make link is behind it: the drive's
        // answer lands right after, as it does in the app.
        const log = ctx.log;
        ctx.log = (l) => {
            if (/: host made /.test(l)) w.dom.autoScope = 'low-space';
            log(l);
        };
        const r = await runCell(small(id), ctx);
        assert.equal(r.verdict, 'FAIL', `${lane} ${id}: ${r.note}`);
        assert.equal(r.reason, 'request-flow', `${lane} ${id}`);
        assert.match(
            r.note,
            /the link now reads Asks first \(low-space\)/,
            `${lane} ${id}`
        );
        assert.match(r.note, /--out/, `${lane} ${id}`);
        assert.equal(r.attempts[0].failedPhase, 'request');
        assert.equal(w.sends.length, 0, `${lane} ${id}: nothing was sent`);
        assert.equal(
            w.cliVisitors.length,
            0,
            `${lane} ${id}: the CLI was never started`
        );
        assert.equal(w.dom.promptGen, 0);
        assert.ok(
            !['waiting', 'deciding'].includes(w.dom.state),
            `${lane} ${id}: the link was closed`
        );
    }
});

// Critic M8 (H7 round): on the UIA lane the done view is the host's whole
// account, so the check mark's screen-reader text ("SHA-256 matched") is the
// only proof of verification the cell can read. The old compare was a flag
// against itself, so its own words could never name the host's view; a done
// view without the text must fail as the HOST's, whatever the visitor shows.
// These ran on TA-10's prompted cell until F2; a delivery on an exe is now
// the Auto-accept twin's.
test('S-DIR-W2D-reqauto on an exe host whose done view carries no SHA-256 matched text: FAIL request-flow naming the host view, not the visitor', async () => {
    const w = fakeRequestWorld({ lane: 'uia', faults: ['heading-lie'] });
    const ctx = ctxFor(w, { buildFor: EXE_BUILD, userAway: true });
    const r = await runCell(small('S-DIR-W2D-reqauto'), ctx);
    assert.equal(r.verdict, 'FAIL', r.note);
    assert.equal(r.reason, 'request-flow');
    assert.match(r.note, /the host's done view carries no SHA-256 matched text/);
    assert.equal(r.attempts[0].request.hostView.verifiedLine, false);
    assert.equal(r.attempts.length, 1, 'a request-flow finding is never retried');
});

test('S-DIR-W2D-reqauto on an exe host with a short verify: the same host-view finding, whether or not the visitor claims a SHA line', async () => {
    for (const faults of [['verified-short'], ['verified-short', 'sha-line-lie']]) {
        const w = fakeRequestWorld({ lane: 'uia', faults });
        const ctx = ctxFor(w, { buildFor: EXE_BUILD, userAway: true });
        const r = await runCell(small('S-DIR-W2D-reqauto'), ctx);
        assert.equal(r.verdict, 'FAIL', `${faults}: ${r.note}`);
        assert.match(r.note, /the host's done view carries no SHA-256 matched text/, `${faults}`);
    }
});

// What the exe lane cannot see, said as a test: the result's automatic mark
// is the host's own record (GetRequestLink), so a build that forgot the mark
// passes here and fails on the dev page (the failures table above).
test("the automatic mark is the dev page lane's oracle: a build that forgot it passes on an exe host, with autoAccepted null on record", async () => {
    const w = fakeRequestWorld({ lane: 'uia', faults: ['auto-unmarked'] });
    const ctx = ctxFor(w, { buildFor: EXE_BUILD, userAway: true });
    const r = await runCell(small('S-DIR-W2D-reqauto'), ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    assert.equal(r.attempts[0].request.result.autoAccepted, null);
    assert.equal(r.attempts[0].request.auto.proof, 'link-block');
});

// B2: the Store app is the one exe that runs on the owner's own profile, so
// the Save to folder the cell types into the Make link form would still be
// there the next time the owner opens it (and the run folder it names is
// deleted by then). The release puts back what the field read before.
const STORE_BUILD = (surface) => ({
    kind: 'shipped',
    version: '1.3.0.0',
    path: null,
    launch: surface === 'desktop' ? 'store' : undefined,
});
const setsOf = (w) =>
    w.uiaClient.calls
        .filter(([c]) => c === 'set-value')
        .map(([, p]) => p.value);

test("B2 on the Store lane: after the drop the Make link form's Save to field holds the owner's folder again, and the record carries before and restored", async () => {
    for (const before of ['D:\\owner\\Floe drops', '']) {
        const w = fakeRequestWorld({ lane: 'uia' });
        w.dom.saveDir = before;
        const ctx = ctxFor(w, { buildFor: STORE_BUILD, userAway: true });
        const r = await runCell(small('S-DIR-W2D-reqauto'), ctx);
        assert.equal(r.verdict, 'PASS', r.note);
        const a = r.attempts[0];
        assert.deepEqual(a.request.saveTo, { before, restored: true });
        assert.equal(
            w.dom.saveDir,
            before,
            'the form reads what the owner had'
        );
        assert.deepEqual(
            setsOf(w),
            [a.outDir, before],
            'the run folder for the link, then the old value'
        );
        assert.equal(a.request.released, 'ready');
        assert.equal(
            r.integrity.ok,
            true,
            'the drop itself went to the run folder'
        );
        assert.equal(w.dom.gen, 1, 'no second link was made');
        // The old value goes to the log as soon as it is known, so a run
        // that dies before the release still leaves the owner what to put
        // back.
        assert.ok(
            ctx.logs.some((l) =>
                l.includes(
                    `Save to field read ${JSON.stringify(before)} before this cell`
                )
            ),
            ctx.logs.join('\n')
        );
    }
});

test('B2 on the Store lane when the cell stops at the prompt: the link is closed, the form is brought back and the field restored, and the verdict stays SKIP request-accept-undrivable', async () => {
    const w = fakeRequestWorld({ lane: 'uia' });
    w.dom.saveDir = 'D:\\owner\\Floe drops';
    const ctx = ctxFor(w, { buildFor: STORE_BUILD, userAway: true });
    const r = await runCell(small('H-DIR-W2D-req'), ctx);
    assert.equal(r.verdict, 'SKIP', r.note);
    assert.equal(r.reason, ACCEPT_UNDRIVABLE);
    const a = r.attempts[0];
    assert.deepEqual(a.request.saveTo, {
        before: 'D:\\owner\\Floe drops',
        restored: true,
    });
    assert.equal(w.dom.saveDir, 'D:\\owner\\Floe drops');
    assert.equal(clicksOf(w, 'Close link').length, 1);
    assert.equal(
        clicksOf(w, 'Make another link').length,
        1,
        'the ended view gives way to the form'
    );
    assert.equal(w.dom.state, 'ready');
});

test('B2: a Save to field that does not take the old value back turns a passing Store cell into ERROR host-release, by name', async () => {
    const w = fakeRequestWorld({ lane: 'uia' });
    w.dom.saveDir = 'D:\\owner\\Floe drops';
    const ctx = ctxFor(w, { buildFor: STORE_BUILD, userAway: true });
    const log = ctx.log;
    ctx.log = (l) => {
        // Once the link is made the field stops taking values.
        if (/: host made /.test(l)) w.dom.saveDirStuck = true;
        log(l);
    };
    const r = await runCell(small('S-DIR-W2D-reqauto'), ctx);
    assert.equal(r.verdict, 'ERROR', r.note);
    assert.equal(r.reason, 'host-release');
    assert.match(
        r.note,
        /the Save to field of the Make link form was not put back/
    );
    assert.equal(r.attempts[0].request.saveTo.restored, false);
    assert.equal(r.attempts[0].request.saveTo.before, 'D:\\owner\\Floe drops');
});

test('B2 is the Store lane only: a portable exe runs on a redirected profile and the dev page in a throwaway context, so neither sets the field a second time', async () => {
    const exe = fakeRequestWorld({ lane: 'uia' });
    exe.dom.saveDir = 'D:\\owner\\Floe drops';
    const r = await runCell(
        small('S-DIR-W2D-reqauto'),
        ctxFor(exe, { buildFor: EXE_BUILD, userAway: true })
    );
    assert.equal(r.verdict, 'PASS', r.note);
    assert.equal(setsOf(exe).length, 1);
    assert.equal(r.attempts[0].request.saveTo, null);

    const dev = fakeRequestWorld();
    const d = await runCell(small('H-DIR-W2D-req'), ctxFor(dev));
    assert.equal(d.verdict, 'PASS', d.note);
    assert.equal(d.attempts[0].request.saveTo, null);
});

test('an exe host whose owner is back before Make link stops as SKIP present, having clicked nothing', async () => {
    const w = fakeRequestWorld({ lane: 'uia', uia: { idle: 12 } });
    const ctx = ctxFor(w, { buildFor: EXE_BUILD, userAway: true });
    const r = await runCell(small('H-DIR-W2D-req'), ctx);
    assert.equal(r.verdict, 'SKIP', r.note);
    assert.equal(r.reason, 'present');
    assert.equal(
        w.uiaClient.calls.filter(([c]) =>
            ['click', 'set-value', 'toggle'].includes(c)
        ).length,
        0,
        'no pattern call once the owner was back'
    );
    assert.equal(w.visitors.length, 0);
});

// The owner coming back AFTER the prompt costs neither the verdict nor the
// release. The cell is still the prompt it proved, and putting the app back
// is never refused for want of 120 s of idle input: the release waits only
// for a short pause (desktop.mjs RELEASE_QUIET_S), which an owner who is back
// and not typing this very second gives it. Before this the link stayed open
// and, on the Store lane, Save to stayed on the run folder.
test('an exe host whose owner comes back once the prompt is up keeps SKIP request-accept-undrivable, and the release still closes the link', async () => {
    const w = fakeRequestWorld({ lane: 'uia' });
    const origSend = w.visitorSend;
    w.visitorSend = (v) => {
        if (w.uiaClient) w.uiaClient.state.idle = 12;
        return origSend(v);
    };
    const ctx = ctxFor(w, { buildFor: EXE_BUILD, userAway: true });
    const r = await runCell(small('H-DIR-W2D-req'), ctx);
    assert.equal(r.verdict, 'SKIP', r.note);
    assert.equal(r.reason, ACCEPT_UNDRIVABLE);
    assert.equal(clicksOf(w, 'Close link').length, 1, 'the link was closed');
    // The ended view: only the Store lane goes on to bring the form back.
    assert.equal(w.dom.state, 'closed');
    assert.ok(
        !r.attempts[0].notes.some((n) => /host-release/.test(n)),
        r.attempts[0].notes.join('\n')
    );
    assert.equal(ctx.shared?.desktopNotReleased, undefined);
});

// An owner who never pauses for the whole release: the step is not sent
// (keys typed then would land in the Floe window), the link is left and said
// so by name, and the run launches nothing more on the desktop.
test('an exe host whose owner types through the whole release: the link is left, named as host-release, and no later host is launched', async () => {
    const w = fakeRequestWorld({ lane: 'uia' });
    let host = null;
    const make = w.adapters.desktop.createLeg;
    w.adapters.desktop.createLeg = (opts) => (host = make(opts));
    const origSend = w.visitorSend;
    w.visitorSend = (v) => {
        if (w.uiaClient) w.uiaClient.state.idle = 0;
        // The release deadline, shortened: the rule is the same at 40 s.
        host.driver.releaseWaitMs = 40;
        host.driver.releasePollMs = 5;
        return origSend(v);
    };
    const ctx = ctxFor(w, { buildFor: EXE_BUILD, userAway: true });
    const r = await runCell(small('H-DIR-W2D-req'), ctx);
    assert.equal(r.verdict, 'SKIP', r.note);
    assert.equal(r.reason, ACCEPT_UNDRIVABLE);
    assert.equal(clicksOf(w, 'Close link').length, 0, 'nothing was sent into the typing');
    const notes = r.attempts[0].notes.join('\n');
    assert.match(notes, /host-release: the host was not left as found/);
    assert.match(notes, /did not pause for 3 s/);
    assert.match(ctx.shared.desktopNotReleased, /did not pause for 3 s/);

    // The next request cell of the same run launches no host.
    const launches = w.launchEdits.length;
    const next = await runCell(small('S-DIR-W2D-reqauto'), ctx);
    assert.equal(next.verdict, 'SKIP', next.note);
    assert.equal(next.reason, 'desktop-not-released');
    assert.match(next.note, /could not put the desktop app back/);
    assert.equal(w.launchEdits.length, launches, 'no second launch');
});

test('--no-idle-check: an exe host is driven with the owner present, and nothing reads the idle time', async () => {
    const w = fakeRequestWorld({ lane: 'uia', uia: { idle: 0 } });
    const ctx = ctxFor(w, { buildFor: EXE_BUILD, userAway: true, noIdleCheck: true });
    const r = await runCell(small('S-DIR-W2D-reqauto'), ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    assert.equal(w.dom.state, 'ready', 'the link was closed at release');
    // Without the flag the same world stops before Make link.
    const w2 = fakeRequestWorld({ lane: 'uia', uia: { idle: 0 } });
    const r2 = await runCell(
        small('S-DIR-W2D-reqauto'),
        ctxFor(w2, { buildFor: EXE_BUILD, userAway: true })
    );
    assert.equal(r2.verdict, 'SKIP', r2.note);
    assert.equal(r2.reason, 'present');
});

test('TA-13 on an exe host: the blip proxy address rides desktop.json at launch, the cut still reaches the host, and the cell then stops at the prompt', async () => {
    const w = fakeRequestWorld({ lane: 'uia' });
    const ctx = ctxFor(w, { buildFor: EXE_BUILD, userAway: true });
    const r = await runCell(small('H-DIR-W2D-reqblip'), ctx);
    assert.equal(r.verdict, 'SKIP', r.note);
    assert.equal(r.reason, ACCEPT_UNDRIVABLE);
    assert.equal(w.launchEdits[0].server, BLIP_URL);
    const a = r.attempts[0];
    assert.equal(a.request.addresses.via, 'desktop.json at launch');
    assert.equal(a.request.blip.reconnecting, true);
    assert.equal(a.request.blip.reclaimed, true);
    assert.equal(
        a.request.prompts.length,
        1,
        'the prompt after the reclaim is on record'
    );
});

test('a wailsdev host that may report stats is an ERROR wailsdev-config, never driven', async () => {
    const w = fakeRequestWorld({ host: { settings: { reportStats: true } } });
    const r = await runCell(small('H-DIR-W2D-req'), ctxFor(w));
    assert.equal(r.verdict, 'ERROR');
    assert.equal(r.reason, 'wailsdev-config');
    assert.equal(clicksOf(w, 'Make link').length, 0);
});

test('the blip never fronts a server that is not loopback: a safety stop before any proxy or page', async () => {
    const w = fakeRequestWorld();
    const ctx = ctxFor(w);
    ctx.infra = { ...ctx.infra, server: 'https://api.floe.one', web: 'https://floe.one' };
    await assert.rejects(runCell(small('H-DIR-W2D-reqblip'), ctx), (e) =>
        e instanceof SafetyError && /not loopback; nothing was started/.test(e.message)
    );
    assert.equal(w.blips.length, 0, 'no proxy started');
    assert.equal(w.dom.clicks.length, 0, 'no host driven');
});

test('an error that quotes the link loses its room in the note, the attempt files and the log', async () => {
    for (const fault of ['goto-error', 'click-error']) {
        const w = fakeRequestWorld({ faults: [fault] });
        const ctx = ctxFor(w);
        const r = await runCell(small('H-DIR-W2D-req'), ctx);
        assert.notEqual(r.verdict, 'PASS', fault);
        assert.match(r.note, /\/r\/Xk3p9Q0aB1c#<room>/, `${fault}: the link id stays readable`);
        assertNoRoom(ctx, r, 'H-DIR-W2D-req');
    }
    assert.deepEqual(scrubDeep({ a: [`x ${WEB}/r/Xk3p9Q0aB1c#${FAKE_ROOM}`] }), {
        a: [`x ${WEB}/r/Xk3p9Q0aB1c#<room>`],
    });
});

test('a link the cell did not make is never closed: the owner\'s open link is left exactly as it was', async () => {
    const w = fakeRequestWorld();
    // The dev app already holds a waiting link of its own.
    Object.assign(w.dom, {
        state: 'waiting',
        gen: 1,
        link: `${WEB}/r/Xk3p9Q0aB1c#${FAKE_ROOM}`,
        linkSaveDir: 'C:\owner',
    });
    const t0 = w.host.now();
    const r = await runCell(small('H-DIR-W2D-req'), ctxFor(w));
    assert.equal(r.verdict, 'ERROR', r.note);
    // Refused by name before any click, not a 30 s Save to fill timeout
    // on the waiting view (the first live run's C2D-reqopen, 2026-09-24).
    assert.equal(r.reason, 'host-busy', r.note);
    assert.equal(r.attempts[0].failedPhase, 'host.start');
    assert.match(r.note, /host-busy: the host lane already holds waiting \(gen 1\) from before this cell/);
    assert.ok(w.host.now() - t0 < 30_000, `refused in ${w.host.now() - t0} ms of fake time`);
    assert.equal(w.dom.state, 'waiting', 'the owner link still waits');
    assert.equal(clicksOf(w, 'Close link').length, 0);
    assert.equal(clicksOf(w, 'Make link').length, 0);
});

// The test above never reaches releaseHost: clearLeftover refuses the owner's
// live link before Make link is tried. The release's own rule (close or put
// away only a link generation this cell made) matters when the owner's link
// goes live after clearLeftover has looked, and the cell's Make link then
// fails on it: Make link was tried, and the lane's gen is the owner's.
test('a Make link that fails on an owner link gone live after the leftover check leaves that link open: the release closes only a generation this cell made', async () => {
    const w = fakeRequestWorld();
    // The owner makes a link in the dev app the moment the cell has read the
    // REQUEST LINK tab: after clearLeftover, before the cell's Make link.
    let tabRead = false;
    const create = w.adapters.desktop.createLeg;
    w.adapters.desktop.createLeg = (o) => {
        const leg = create(o);
        const open = leg.openDriver;
        leg.openDriver = async (...args) => {
            const d = await open(...args);
            const wait = d.awaitRequestTab.bind(d);
            d.awaitRequestTab = async (...a) => {
                const r = await wait(...a);
                tabRead = true;
                return r;
            };
            return d;
        };
        return leg;
    };
    const worldTick = w.dom.onTick;
    let ownerMade = false;
    w.dom.onTick = (t) => {
        if (!ownerMade && tabRead && w.dom.state === 'ready') {
            ownerMade = true;
            Object.assign(w.dom, {
                state: 'waiting',
                gen: w.dom.gen + 1,
                link: `${WEB}/r/Xk3p9Q0aB1c#${FAKE_ROOM}`,
                linkSaveDir: 'C:\\owner',
            });
        }
        if (worldTick) worldTick(t);
    };
    const r = await runCell(small('H-DIR-W2D-req'), ctxFor(w));
    assert.ok(ownerMade, 'the owner link went live while the host started');
    assert.notEqual(r.verdict, 'PASS', r.note);
    const a = r.attempts[0];
    assert.equal(a.failedPhase, 'host.start', r.note);
    assert.equal(clicksOf(w, 'Close link').length, 0, 'the release never clicked Close link on the owner link');
    assert.equal(w.dom.state, 'waiting', 'the owner link still waits');
    assert.equal(w.dom.gen, 1, 'the only link generation is the owner\'s');
    assert.equal(clicksOf(w, 'Make link').length, 0);
    // Non-vacuity: this note is written only when Make link was tried and the
    // gen check found the lane's link was not this cell's.
    assert.ok(
        a.notes.some((l) => /host release: the lane holds waiting, which this cell did not make; left alone/.test(l)),
        a.notes.join(' | ')
    );
});

test('a live link this run left behind (its folder inside the run) is closed first, noted, and the cell runs', async () => {
    const w = fakeRequestWorld();
    const ctx = ctxFor(w);
    // The previous cell's link, still waiting: made into its own host-drops
    // folder under this run's evidence root, as TA-17 makes them.
    Object.assign(w.dom, {
        state: 'waiting',
        gen: 1,
        link: `${WEB}/r/Xk3p9Q0aB1c#${FAKE_ROOM}`,
        linkSaveDir: path.join(ctx.evidenceRoot, 'cells', 'H-DIR-D2C-reqopen', 'attempt-1', 'host-drops'),
    });
    const r = await runCell(small('H-DIR-W2D-req'), ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    const a = r.attempts[0];
    assert.deepEqual(a.request.swept, { state: 'waiting', gen: 1 });
    assert.ok(
        a.notes.some((l) => /swept this run's leftover waiting link \(gen 1\) before Make link/.test(l)),
        a.notes.join(' | ')
    );
    const names = w.dom.clicks.map((c) => c.name);
    assert.ok(
        names.indexOf('Close link') > -1 && names.indexOf('Close link') < names.indexOf('Make link'),
        names.join(', ')
    );
    assertNoRoom(ctx, r, 'H-DIR-W2D-req');
});

// ------------------------------------------------------- the release

// The first live run's D2C-reqopen (2026-09-24) PASSed while its release
// failed: Close link timed out, the link stayed open, and the next cell
// inherited it. A release that does not leave the host as
// found is now a keyed harness ERROR on a cell that otherwise passed.
test('TA-17 whose Close link does not take: ERROR host-release in teardown, never a PASS with a note', async () => {
    const w = fakeRequestWorld({ host: { closeStuck: true } });
    const r = await runCell(small('H-DIR-W2C-reqopen'), ctxFor(w));
    assert.equal(r.verdict, 'ERROR', r.note);
    assert.equal(r.reason, 'host-release', r.note);
    const a = r.attempts[0];
    assert.equal(a.failedPhase, 'teardown');
    assert.equal(a.signatureKey, 'host-release');
    assert.equal(a.request.after, 'waiting', 'the quick cell itself held');
    assert.match(r.note, /host-release: the host was not left as found/);
    assert.match(r.note, /"Make another link" did not appear/);
    assert.equal(attemptJson(a).signatureKey, 'host-release', 'attempt.json says so too');
});

test('TA-10 whose result cannot be put away: ERROR host-release (the result stays on screen)', async () => {
    const w = fakeRequestWorld({ host: { dismissStuck: true } });
    const r = await runCell(small('H-DIR-W2D-req'), ctxFor(w));
    assert.equal(r.verdict, 'ERROR', r.note);
    assert.equal(r.reason, 'host-release', r.note);
    assert.match(r.note, /"Make another link" was still showing/);
    assert.equal(w.dom.state, 'done', 'the result really is still showing');
    assert.equal(attemptJson(r.attempts[0]).signatureKey, 'host-release');
});

test('a FAIL whose release also failed keeps its own finding and carries the host-release note', async () => {
    const w = fakeRequestWorld({ faults: ['not-used-up'], host: { dismissStuck: true } });
    const r = await runCell(small('H-DIR-W2D-req'), ctxFor(w));
    assert.equal(r.verdict, 'FAIL', r.note);
    assert.equal(r.reason, 'request-flow');
    assert.ok(
        r.attempts[0].notes.some((l) => /^host-release: the host was not left as found/.test(l)),
        r.attempts[0].notes.join(' | ')
    );
});

test('TA-17 whose release outlives the teardown budget: ERROR host-release, the release did not finish', async () => {
    const w = fakeRequestWorld({ host: { closeHangs: true } });
    const cell = small('H-DIR-W2C-reqopen');
    cell.timeouts.teardown = 200;
    const r = await runCell(cell, ctxFor(w));
    assert.equal(r.verdict, 'ERROR', r.note);
    assert.equal(r.reason, 'host-release', r.note);
    assert.match(r.note, /did not finish within the teardown budget/);
});

test('TA-17 whose lane still reads waiting after Close link: ERROR host-release, the link this cell made is still live', async () => {
    const w = fakeRequestWorld({ host: { laneStaysOpen: true } });
    const r = await runCell(small('H-DIR-W2C-reqopen'), ctxFor(w));
    assert.equal(r.verdict, 'ERROR', r.note);
    assert.equal(r.reason, 'host-release', r.note);
    assert.match(r.note, /host release: the link this cell made still reads waiting/);
    assert.equal(r.attempts[0].request.released, 'waiting');
});

// ------------------------------------------------------------- TA-14 (FU-26)

test('TA-14 H-DIR-W2D-reqcaddy: the host behind the local Caddy goes Reconnecting and back to Waiting on a reload, a reload while the drop receives does not stop it, and the container is stopped', async () => {
    const w = fakeRequestWorld();
    const ctx = ctxFor(w, { startCaddy: w.startCaddy });
    const r = await runCell(small('H-DIR-W2D-reqcaddy'), ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    const a = r.attempts[0];
    const c = w.caddies[0];
    assert.equal(c.upstream, LOCAL, 'the Caddy fronts the local server');
    assert.equal(w.dom.madeWith.server, CADDY_URL, 'the link was made through the Caddy');
    assert.deepEqual(
        c.reloads.map((x) => [x.state, x.hostBehind]),
        [['waiting', true], ['receiving', true]]
    );
    assert.deepEqual(
        { reconnecting: a.request.caddy.reconnecting, reclaimed: a.request.caddy.reclaimed, receivingReload: a.request.caddy.receivingReload },
        { reconnecting: true, reclaimed: true, receivingReload: true }
    );
    assert.equal(r.integrity.ok, true);
    assert.equal(c.stopped, true, 'teardown stopped the container');
    assert.ok(a.phases.caddy !== undefined, 'a caddy phase ran before host.start');
    assert.deepEqual(a.request.addresses, { swapped: true, restored: true });
    assertNoRoom(ctx, r, 'H-DIR-W2D-reqcaddy');
});

test('TA-14 without Docker SKIPs docker-absent before the host launches', async () => {
    const w = fakeRequestWorld({ faults: ['docker-absent'] });
    const r = await runCell(small('H-DIR-W2D-reqcaddy'), ctxFor(w, { startCaddy: w.startCaddy }));
    assert.equal(r.verdict, 'SKIP', r.note);
    assert.equal(r.reason, 'docker-absent');
    assert.equal(w.dom.clicks.length, 0);
    assert.equal(w.visitors.length, 0);
});

test('TA-14 whose host is not behind the Caddy is ERROR caddy-url, and a drop that ends before the second reload is ERROR caddy-reload-missed', async () => {
    const w = fakeRequestWorld({ host: { ignoreServer: true } });
    const r = await runCell(small('H-DIR-W2D-reqcaddy'), ctxFor(w, { startCaddy: w.startCaddy }));
    assert.equal(r.verdict, 'ERROR', r.note);
    assert.equal(r.reason, 'caddy-url');
    assert.equal(w.caddies[0].stopped, true);
    const fast = fakeRequestWorld({ transferMs: 0 });
    const r2 = await runCell(small('H-DIR-W2D-reqcaddy'), ctxFor(fast, { startCaddy: fast.startCaddy }));
    assert.equal(r2.verdict, 'ERROR', r2.note);
    assert.equal(r2.reason, 'caddy-reload-missed');
});

test('TA-14 never fronts a server that is not loopback, whatever reached the runner: a safety stop before any container or page (OD-33)', async () => {
    const w = fakeRequestWorld();
    const ctx = ctxFor(w, { startCaddy: w.startCaddy });
    ctx.infra = { ...ctx.infra, server: 'https://api.floe.one', web: 'https://floe.one' };
    await assert.rejects(runCell(small('H-DIR-W2D-reqcaddy'), ctx), (e) =>
        e instanceof SafetyError &&
        e.message.includes('the Caddy proxy would front https://api.floe.one, which is not loopback; nothing was started')
    );
    assert.equal(w.caddies.length, 0, 'no Caddy started');
    assert.equal(w.dom.clicks.length, 0, 'no host driven');
});

// The same order in a real request cell: attempt 1 FAILs on a retryable
// signature (the visitor's page never loaded), the day's 20 links run out
// before the retry makes its own, and the retry is refused before its host
// launches. The cell is the FAIL it was, never SKIP request-daily-limit.
test("a request cell whose retry is refused its link for the day keeps attempt 1's FAIL as its verdict, with the refusal in the note", async () => {
    const w = fakeRequestWorld({ faults: ['goto-error'] });
    const ctx = ctxFor(w, { shared: {} });
    const log = ctx.log;
    ctx.log = (l) => {
        // runCell logs this between the two attempts.
        if (/retrying once after|for the window to drain/.test(l))
            ctx.shared.requestLimited = true;
        log(l);
    };
    const r = await runCell(small('H-DIR-W2D-req'), ctx);
    assert.equal(r.attempts.length, 2, r.note);
    assert.equal(r.verdict, 'FAIL', r.note);
    assert.equal(r.reason, 'goto-timeout');
    assert.match(r.note, /page\.goto: net::ERR_CONNECTION_REFUSED/);
    assert.match(
        r.note,
        /; the retry could not run \(SKIP request-daily-limit: /
    );
    assert.equal(r.attempts[1].failedPhase, 'host.start');
    assert.equal(clicksOf(w, 'Make link').length, 1, 'the retry made no link');
    assertNoRoom(ctx, r, 'H-DIR-W2D-req');
});

// Review of #542, finding 1, end to end on the Store lane: the leftover of an
// earlier audit is not laundered into "the owner's folder, restored".
test("B2 on the Store lane: a Save to field left on an earlier audit's folder is cleared, not put back, and the record says what was found", async () => {
    const left =
        'C:\\Users\\x\\AppData\\Local\\Temp\\lta\\20261012-200000-shipped-default\\cells\\S-DIR-W2D-reqauto\\attempt-1\\out';
    const w = fakeRequestWorld({ lane: 'uia' });
    w.dom.saveDir = left;
    const ctx = ctxFor(w, { buildFor: STORE_BUILD, userAway: true });
    const r = await runCell(small('S-DIR-W2D-reqauto'), ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    const a = r.attempts[0];
    assert.deepEqual(a.request.saveTo, { before: '', restored: true, leftover: left });
    assert.equal(w.dom.saveDir, '', "the app's default, not the audit folder again");
    assert.ok(
        a.notes.some((n) => /an earlier audit's own folder and not the owner's choice/.test(n)),
        a.notes.join('\n')
    );
    assert.deepEqual(ctx.safety.desktopNotReleased, [], 'a repair is not a failed release');
});

// A release that failed is in the Safety table whatever the cell's verdict.
test('a host that could not be released is named in the Safety record, on a cell that ends SKIP', async () => {
    const w = fakeRequestWorld({ lane: 'uia' });
    let host = null;
    const make = w.adapters.desktop.createLeg;
    w.adapters.desktop.createLeg = (opts) => (host = make(opts));
    const origSend = w.visitorSend;
    w.visitorSend = (v) => {
        if (w.uiaClient) w.uiaClient.state.idle = 0;
        host.driver.releaseWaitMs = 40;
        host.driver.releasePollMs = 5;
        return origSend(v);
    };
    const ctx = ctxFor(w, { buildFor: EXE_BUILD, userAway: true });
    const r = await runCell(small('H-DIR-W2D-req'), ctx);
    assert.equal(r.verdict, 'SKIP', r.note);
    assert.equal(ctx.safety.desktopNotReleased.length, 1);
    assert.match(ctx.safety.desktopNotReleased[0], /^H-DIR-W2D-req: host release: /);
    assert.match(ctx.safety.desktopNotReleased[0], /did not pause for 3 s/);
    // And a clean run records none.
    const clean = fakeRequestWorld({ lane: 'uia' });
    const ctx2 = ctxFor(clean, { buildFor: EXE_BUILD, userAway: true });
    await runCell(small('S-DIR-W2D-reqauto'), ctx2);
    assert.deepEqual(ctx2.safety.desktopNotReleased, []);
});

// Second review of #542, finding F: two lines of the request runner were
// right by reading and pinned by nothing.
test("the request host's pid goes to the manifest hook the moment the host is launched, and a host with no pid reports none", async () => {
    const hostWithPid = (pid) => {
        const w = fakeRequestWorld();
        const base = ctxFor(w);
        const pids = [];
        const order = [];
        const ctx = {
            ...base,
            onPid: (p, label) => {
                pids.push([p, label]);
                order.push(`pid ${label}`);
            },
            getAdapter: async (name) => {
                const a = await base.getAdapter(name);
                if (name !== 'desktop') return a;
                return {
                    ...a,
                    createLeg: (o) => {
                        const leg = a.createLeg(o);
                        if (o.label !== 'host') return leg;
                        const launch = leg.launch.bind(leg);
                        leg.launch = async (...args) => {
                            const r = await launch(...args);
                            leg.pid = pid;
                            order.push('launched');
                            return r;
                        };
                        return leg;
                    },
                };
            },
        };
        return { w, ctx, pids, order };
    };
    const one = hostWithPid(4242);
    const r = await runCell(small('H-DIR-W2D-req'), one.ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    assert.deepEqual(
        one.pids.filter(([, label]) => String(label).endsWith(':host')),
        [[4242, 'H-DIR-W2D-req:host']]
    );
    // Straight after the launch, before the host is driven any further.
    assert.equal(one.order.indexOf('pid H-DIR-W2D-req:host'), one.order.indexOf('launched') + 1);

    const none = hostWithPid(null);
    const r2 = await runCell(small('H-DIR-W2D-req'), none.ctx);
    assert.equal(r2.verdict, 'PASS', r2.note);
    assert.deepEqual(none.pids.filter(([, label]) => String(label).endsWith(':host')), []);
});

test('teardown lets a host start that is still running finish, inside a bound, in both kinds of request cell', async () => {
    assert.equal(START_SETTLE_MS, 15_000);
    // Nothing in flight: no wait at all.
    let slept = 0;
    const ctx = { sleep: async () => void (slept += 1) };
    await hostStartSettled({ starting: null }, ctx);
    await hostStartSettled(null, ctx);
    assert.equal(slept, 0);

    // A start that finishes is waited for, and its failure is not thrown.
    const order = [];
    let finish;
    const starting = new Promise((_, reject) => (finish = () => reject(new Error('host.start failed late'))));
    const waiting = hostStartSettled(
        { starting },
        { sleep: () => new Promise(() => {}) }
    ).then(() => order.push('settled'));
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(order, [], 'still waiting for the start');
    finish();
    await waiting;
    assert.deepEqual(order, ['settled']);

    // A start that never ends does not hold the teardown: the bound does.
    const asked = [];
    await hostStartSettled(
        { starting: new Promise(() => {}) },
        { sleep: async (ms) => void asked.push(ms) }
    );
    assert.deepEqual(asked, [START_SETTLE_MS]);

    // Both teardowns go through it, each before its host is stopped: the
    // plain attempt, and the quick cell with a link held open (TA-17), which
    // used to release at once and could read "nothing of ours here".
    const src = readFileSync(fileURLToPath(new URL('./request.mjs', import.meta.url)), 'utf8');
    const calls = [...src.matchAll(/await hostStartSettled\(st, ctx\);/g)].map((m) => m.index);
    assert.equal(calls.length, 2);
    for (const at of calls) {
        const next = src.indexOf('.host.stop(', at);
        assert.ok(next > at && next - at < 400, 'the stop follows the settle');
    }
    const open = src.slice(src.indexOf('export function openLinkHooks('));
    assert.ok(open.includes('await (st.starting = startHost(cell, ctx, rec, st, {'), 'TA-17 keeps its start');
    assert.ok(open.indexOf('await hostStartSettled(st, ctx);') > 0);
});

// The first request cell run on the Store app (2026-10-13) edited and
// restored the owner's desktop.json, its manifest said so, and the Safety
// row read "desktop.json: not edited (no Store-mode leg)": only a plain
// cell's legs fed that row.
test("a request host's desktop.json restore reaches the Safety row, in both kinds of request cell", async () => {
    const withConfig = (config) => {
        const w = fakeRequestWorld();
        const base = ctxFor(w);
        const ctx = {
            ...base,
            getAdapter: async (name) => {
                const a = await base.getAdapter(name);
                if (name !== 'desktop') return a;
                return {
                    ...a,
                    createLeg: (o) => {
                        const leg = a.createLeg(o);
                        if (o.label !== 'host') return leg;
                        const evidence = leg.evidence.bind(leg);
                        leg.evidence = () => ({ ...evidence(), config });
                        return leg;
                    },
                };
            },
        };
        return ctx;
    };
    const row = (ctx) => safetyRows(ctx.safety).find(([k]) => k.startsWith('desktop receivers'))[1];

    // Restored, mtime and all: the row says so.
    let ctx = withConfig({ applied: true, match: true, mtimeRestored: true });
    let r = await runCell(small('H-DIR-W2D-req'), ctx);
    assert.equal(r.verdict, 'PASS', r.note);
    assert.equal(ctx.safety.desktopReceiversOptedOut.configMtimeRestored, true);
    assert.match(row(ctx), /desktop\.json: contents and mtime restored$/);

    // A restore that did not match is the row's NO.
    ctx = withConfig({ applied: true, match: false, mtimeRestored: false });
    await runCell(small('H-DIR-W2D-req'), ctx);
    assert.equal(ctx.safety.desktopReceiversOptedOut.configRestoredIdentical, false);
    assert.match(row(ctx), /desktop\.json restored byte-identical: NO$/);

    // A host that edited nothing (the dev page, a portable exe) leaves the row alone.
    ctx = withConfig({ applied: false, match: null, mtimeRestored: null });
    await runCell(small('H-DIR-W2D-req'), ctx);
    assert.match(row(ctx), /desktop\.json: not edited \(no Store-mode leg\)$/);

    // The helper itself, on the shapes it is handed.
    const s = newSafety();
    recordDesktopConfig(null, s);
    recordDesktopConfig({}, s);
    recordDesktopConfig({ config: { applied: false, match: false, mtimeRestored: false } }, s);
    assert.equal(s.desktopReceiversOptedOut.configMtimeRestored, null, 'nothing applied, nothing recorded');
    recordDesktopConfig({ config: { applied: true, match: true, mtimeRestored: true } }, s);
    assert.equal(s.desktopReceiversOptedOut.configMtimeRestored, true);
    // One leg that could not put the mtime back keeps the run at "changed".
    recordDesktopConfig({ config: { applied: true, match: true, mtimeRestored: false } }, s);
    recordDesktopConfig({ config: { applied: true, match: true, mtimeRestored: true } }, s);
    assert.equal(s.desktopReceiversOptedOut.configMtimeRestored, false);
    recordDesktopConfig({ config: { applied: true, match: true, mtimeRestored: true } }, null);

    // And the open-link cell's teardown records its host the same way.
    const src = readFileSync(fileURLToPath(new URL('./request.mjs', import.meta.url)), 'utf8');
    assert.equal(src.split('recordDesktopConfig(').length - 1, 2);
    assert.ok(src.includes('recordDesktopConfig(hostEv, ctx.safety);'));
    assert.ok(src.includes('recordDesktopConfig(rec.evidence.host, ctx.safety);'));
});
