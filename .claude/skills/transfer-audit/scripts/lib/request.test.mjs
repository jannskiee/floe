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

import { runCell } from './cell.mjs';
import { ACCEPT_WAIT_MS } from './desktop.mjs';
import { cellPlan } from './matrix.mjs';
import { Ledger } from './pacing.mjs';
import { newSafety } from './report.mjs';
import { UIA_PENDING, scrubDeep } from './request.mjs';
import { SafetyError } from './surfaces.mjs';
import { FAKE_ROOM } from './tests/fake-request-dom.mjs';
import { fakeWorld, makeFakeAdapters } from './tests/fake-legs.mjs';
import { BLIP_URL, fakeRequestWorld } from './tests/fake-request-world.mjs';

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
        }),
        // TA-12 exists as a shipped id only; the runner does not care.
        ...cellPlan({
            profile: 'shipped',
            cells: ['S-REL-W2D-reqhideip'],
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
    // Make link went to the run's own folder, never Downloads\Floe requests.
    assert.equal(w.dom.madeWith.requestLinks, true, 'the Beta switch was on for Make link');
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
    // Left as found: the result put away, the Beta switch off again, both
    // visitor contexts closed, the host page closed.
    assert.equal(a.request.released, 'ready');
    assert.equal(w.dom.settings.requestLinks, false);
    assert.ok(w.visitors.every((v) => v.closed));
    assert.equal(w.visitors.length, 2, 'the sender and the used-link checker');
    assert.equal(w.dom.closed, true);
    // The host's captures live under private/.
    for (const c of a.evidence.captures)
        assert.match(c, /[\\/]private[\\/]host[\\/]/);
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
    assert.equal(w.dom.settings.requestLinks, false);
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
    ['H-DIR-W2D-req', ['beta-stuck'], 'FAIL', 'request-flow', /the Beta switch did not turn on/],
    ['H-DIR-W2D-req', ['make-error'], 'FAIL', 'request-flow', /Make link ended in error \(disabled\)/],
    ['H-REL-W2D-req', ['init-script'], 'ERROR', 'init-script-not-applied', /init-script-not-applied/],
    ['H-DIR-W2D-reqdecline', ['decline-copy'], 'FAIL', 'request-flow', /the visitor-1 read "They did not answer in time\. Nothing was sent\." instead of "They declined\. Nothing was sent\."/],
    ['H-DIR-W2D-reqblip', ['blip-no-absent'], 'FAIL', 'request-flow', /did not read "Their computer is not connected right now" within \d+ ms/],
    ['H-DIR-W2D-reqblip', ['no-reclaim'], 'FAIL', 'request-flow', /not Waiting again after the cut \(the reclaim\)/],
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

test('a Save to field that does not take SKIPs desktop-savedir and makes no link', async () => {
    const w = fakeRequestWorld({ host: { saveDirStuck: true } });
    const r = await runCell(small('H-DIR-W2D-req'), ctxFor(w));
    assert.equal(r.verdict, 'SKIP');
    assert.equal(r.reason, 'desktop-savedir');
    assert.equal(clicksOf(w, 'Make link').length, 0);
});

test('a host that is not on the wailsdev lane SKIPs request-host-uia-pending before anything opens', async () => {
    const w = fakeRequestWorld();
    const ctx = ctxFor(w, {
        buildFor: (surface) => ({
            kind: 'head',
            version: 'head',
            path: 'x.exe',
            launch: surface === 'desktop' ? 'portable' : undefined,
        }),
    });
    const r = await runCell(small('H-DIR-W2D-req'), ctx);
    assert.equal(r.verdict, 'SKIP');
    assert.equal(r.reason, UIA_PENDING);
    assert.equal(w.dom.clicks.length, 0);
    assert.equal(w.visitors.length, 0);
    // And the plan says so before any run: a request cell off wailsdev.
    const off = cellPlan({
        profile: 'head',
        cells: ['H-DIR-W2D-req'],
        probe: FEATURE,
        server: LOCAL,
        desktopMode: 'auto',
    }).find((c) => c.id === 'H-DIR-W2D-req');
    assert.equal(off.reason, UIA_PENDING);
});

test('a wailsdev host that may report stats is an ERROR wailsdev-config, never driven', async () => {
    const w = fakeRequestWorld({ host: { settings: { requestLinks: false, reportStats: true } } });
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
    const w = fakeRequestWorld({ host: { settings: { requestLinks: true } } });
    // The dev app already holds a waiting link of its own.
    Object.assign(w.dom, {
        state: 'waiting',
        gen: 1,
        link: `${WEB}/r/Xk3p9Q0aB1c#${FAKE_ROOM}`,
        linkSaveDir: 'C:\owner',
    });
    const r = await runCell(small('H-DIR-W2D-req'), ctxFor(w));
    assert.equal(r.verdict, 'ERROR', r.note);
    assert.equal(w.dom.state, 'waiting', 'the owner link still waits');
    assert.equal(clicksOf(w, 'Close link').length, 0);
    assert.ok(
        r.attempts[0].notes.some((l) => /which this cell did not make; left alone/.test(l)),
        r.attempts[0].notes.join(' | ')
    );
});
