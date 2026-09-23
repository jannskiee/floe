// lib/visitor.mjs: the request link visitor's context against a fake
// browser. No Chromium, no network.
//
// Run: node --test .claude/skills/transfer-audit/scripts/lib/visitor.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
    VISITOR_TEXT,
    arrivedTitle,
    inProgressTitle,
    openVisitor,
    sendLabel,
    visitorTarget,
} from './visitor.mjs';
import { fakeVisitorContext } from './tests/fake-request-world.mjs';

const tmp = mkdtempSync(path.join(tmpdir(), 'lta-visitor-'));
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }));

const ROOM = '6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';
const LINK = `http://localhost:3000/r/Xk3p9Q0aB1c#${ROOM}`;
const WEB = 'http://localhost:3000';

function fakeBrowser({ stored = 'false', gotoFails = false } = {}) {
    const calls = [];
    const routes = [];
    const ctx = {
        async addInitScript(fn, arg) {
            calls.push(['init', fn, arg]);
        },
        async route(pattern, handler) {
            routes.push({ pattern, handler });
            calls.push(['route', pattern]);
        },
        async newPage() {
            calls.push(['newPage']);
            return {
                async goto(url, o) {
                    calls.push(['goto', url, o]);
                    if (gotoFails) throw new Error('page.goto: net::ERR');
                },
                async evaluate(fn, arg) {
                    calls.push(['evaluate', arg]);
                    return stored;
                },
            };
        },
        async close() {
            calls.push(['close']);
        },
    };
    return {
        calls,
        routes,
        browser: {
            async newContext() {
                calls.push(['newContext']);
                return ctx;
            },
        },
    };
}

const report = {
    request: () => ({
        method: () => 'POST',
        url: () => 'http://localhost:3001/api/stats/report',
    }),
    abort: async () => {},
};

test('visitor seeds floe:report-stats to false and counts every stats report it aborts', async () => {
    const f = fakeBrowser();
    const logs = [];
    const v = await openVisitor({
        browser: f.browser,
        link: LINK,
        web: WEB,
        log: (l) => logs.push(l),
    });
    const inits = f.calls.filter((c) => c[0] === 'init');
    assert.deepEqual(inits[0][2], ['floe:report-stats', 'false']);
    assert.deepEqual(
        f.calls.filter((c) => c[0] === 'route').map((c) => c[1]),
        ['**/api/stats/report']
    );
    // The guards are in place before the page exists.
    const order = f.calls.map((c) => c[0]);
    assert.ok(order.indexOf('route') < order.indexOf('newPage'));
    assert.ok(order.indexOf('init') < order.indexOf('newPage'));
    assert.deepEqual(f.calls.find((c) => c[0] === 'goto')[1], LINK);
    assert.deepEqual(v.statsProof(), {
        kind: 'route-abort',
        route: '**/api/stats/report',
        attempts: 0,
        localStorage: 'false',
        bytesReportedEvents: 0,
        breach: false,
    });
    await f.routes[0].handler(report);
    assert.equal(v.statsProof().attempts, 1);
    assert.equal(v.statsProof().breach, true, 'one attempt is a breach');
    assert.ok(logs.length > 0);
    for (const l of logs) assert.ok(!l.includes(ROOM), `no room in "${l}"`);
});

test('a seed that does not read back as "false" is a breach', async () => {
    const f = fakeBrowser({ stored: null });
    const v = await openVisitor({ browser: f.browser, link: LINK, web: WEB });
    assert.equal(v.statsProof().breach, true);
    assert.equal(v.statsProof().localStorage, null);
});

test('the relay forcer rides the audit init script only when asked', async () => {
    const on = fakeBrowser();
    await openVisitor({ browser: on.browser, link: LINK, web: WEB, relayOnly: true });
    const onScript = on.calls.filter((c) => c[0] === 'init').map((c) => String(c[1]));
    assert.ok(onScript.some((s) => s.includes("cfg.iceTransportPolicy = 'relay'")));
    const off = fakeBrowser();
    await openVisitor({ browser: off.browser, link: LINK, web: WEB });
    const offScript = off.calls.filter((c) => c[0] === 'init').map((c) => String(c[1]));
    assert.ok(!offScript.some((s) => s.includes("cfg.iceTransportPolicy = 'relay'")));
});

test('the visitor refuses a link that is not a request link or points away from the web under test', async () => {
    for (const bad of [
        'http://localhost:3000/#room=abc',
        `https://www.floe.one/r/Xk3p9Q0aB1c#${ROOM}`,
        `http://localhost:3001/r/Xk3p9Q0aB1c#${ROOM}`,
        'not a link',
    ]) {
        const f = fakeBrowser();
        await assert.rejects(
            openVisitor({ browser: f.browser, link: bad, web: WEB }),
            /visitor: /,
            bad
        );
        assert.equal(f.calls.length, 0, 'refused before any context exists');
    }
    assert.equal(
        visitorTarget(`https://floe.one/r/Xk3p9Q0aB1c#${ROOM}`, 'https://www.floe.one'),
        `https://floe.one/r/Xk3p9Q0aB1c#${ROOM}`
    );
});

test('a failed open closes the context it made', async () => {
    const f = fakeBrowser({ gotoFails: true });
    await assert.rejects(
        openVisitor({ browser: f.browser, link: LINK, web: WEB }),
        /ERR/
    );
    assert.equal(f.calls.at(-1)[0], 'close');
});

// ------------------------------------------ the page, driven (WP-R2)

/** A fake browser whose visitor page the test scripts by hand. */
function scripted() {
    let v = null;
    return {
        get v() {
            return v;
        },
        browser: {
            async newContext(opts) {
                const ctx = fakeVisitorContext(null, opts);
                v = ctx.v;
                return ctx;
            },
        },
    };
}

const clock = () => {
    const c = { t: 0 };
    return { now: () => c.t, nap: async (ms) => void (c.t += ms), c };
};

function fixtureFile(name, bytes = 1024) {
    const p = path.join(tmp, name);
    writeFileSync(p, Buffer.alloc(bytes, 7));
    return p;
}

test('the visitor copy is the frozen table, and only Ready, Connecting, Waiting and Sending count as in progress', () => {
    assert.deepEqual(VISITOR_TEXT, {
        ready: 'SEND FILES THROUGH THIS LINK',
        connecting: 'Connecting to their computer',
        waiting: 'Waiting for them to accept',
        hostAbsent: 'Their computer is not connected right now',
        used: 'This link has already been used',
        declined: 'They declined. Nothing was sent.',
        tryAgain: 'Try again',
        backToFiles: 'Back to files',
        shaMatched: "Their app reports every file's SHA-256 matched.",
    });
    assert.equal(sendLabel(1), 'Send 1 file');
    assert.equal(sendLabel(3), 'Send 3 files');
    assert.equal(arrivedTitle(1), 'ALL 1 FILES ARRIVED', 'statusCopy keeps the plural');
    for (const t of [VISITOR_TEXT.ready, VISITOR_TEXT.connecting, VISITOR_TEXT.waiting, 'SENDING 2 OF 5'])
        assert.ok(inProgressTitle(t), t);
    for (const t of [VISITOR_TEXT.hostAbsent, VISITOR_TEXT.used, VISITOR_TEXT.declined, 'Connection lost', arrivedTitle(2)])
        assert.ok(!inProgressTitle(t), t);
});

test('the visitor picks files through the hidden input, sends by the label that counts them, and spends one TURN and one socket per attempt', async () => {
    const s = scripted();
    const spent = [];
    const ledger = { spend: (k) => spent.push(k) };
    const v = await openVisitor({ browser: s.browser, link: LINK, web: WEB, ledger, tag: 'visitor-1' });
    const k = clock();
    await assert.rejects(v.send(), /Send before any file/);
    const files = [fixtureFile('a.bin'), fixtureFile('b.bin')];
    const r = await v.addFiles(files, k);
    assert.deepEqual(r, { added: 2, send: 'Send 2 files' });
    assert.deepEqual(s.v.files, files);
    await v.send(k);
    assert.equal(s.v.state, 'waiting', 'the Send button was the one clicked');
    assert.deepEqual(spent, ['turn', 'conn']);
    // A pick the page never counts is a request-flow failure, not a hang.
    const stuck = scripted();
    const w = await openVisitor({ browser: stuck.browser, link: LINK, web: WEB });
    stuck.v.page.locator = () => ({ first: () => ({ setInputFiles: async () => {} }) });
    await assert.rejects(
        w.addFiles(files, { ...clock(), timeoutMs: 1000 }),
        /request-flow: the visitor never offered "Send 2 files"/
    );
});

test('awaitTitle returns on the title asked for, fails at once on any other ending, and names the last title on a timeout', async () => {
    const s = scripted();
    const v = await openVisitor({ browser: s.browser, link: LINK, web: WEB, tag: 'visitor-2' });
    s.v.state = 'declined';
    const got = await v.awaitTitle([VISITOR_TEXT.declined], { ...clock(), timeoutMs: 5000 });
    assert.equal(got.title, VISITOR_TEXT.declined);

    s.v.state = 'used';
    await assert.rejects(
        v.awaitTitle([arrivedTitle(1)], { ...clock(), timeoutMs: 60_000 }),
        (e) =>
            e.signatureKey === 'request-flow' &&
            e.message ===
                'request-flow: the visitor-2 read "This link has already been used" instead of "ALL 1 FILES ARRIVED"'
    );

    s.v.state = 'waiting';
    const k = clock();
    await assert.rejects(
        v.awaitTitle([VISITOR_TEXT.hostAbsent], { ...k, timeoutMs: 2000 }),
        /did not read "Their computer is not connected right now" within 2000 ms \(last: "Waiting for them to accept"\)/
    );
    assert.ok(k.c.t >= 2000, 'it waited the whole window on the fake clock');
    assert.deepEqual(
        v.titles.map((x) => x.titles),
        [VISITOR_TEXT.declined, VISITOR_TEXT.used, VISITOR_TEXT.waiting],
        'each title change is kept once'
    );
});

test('the visitor route comes from the nominated pair while the drop is live, then from the delivered line', async () => {
    const s = scripted();
    const v = await openVisitor({ browser: s.browser, link: LINK, web: WEB, relayOnly: true });
    s.v.files = ['x'];
    s.v.state = 'sending';
    s.v.route = 'relay';
    await v.sampleOnce();
    const r = v.route();
    assert.equal(r.verdict, 'relay');
    assert.equal(r.source, 'getStats');
    assert.equal(r.local, 'relay', 'the forced visitor shows local=relay');
    assert.deepEqual(v.policy(), { ok: true, checked: 1, offenders: [] });

    const t = scripted();
    const w = await openVisitor({ browser: t.browser, link: LINK, web: WEB });
    assert.equal(w.route([]), null, 'no pair and no line is no route');
    assert.deepEqual(w.route(['64.0 MB in 3s, direct. Their app reports every file\'s SHA-256 matched.']), {
        t: null,
        source: 'visitor-line',
        local: null,
        remote: null,
        verdict: 'direct',
    });
});

test('the visitor records TURN answers by status only, and its evidence carries the link without the room', async () => {
    const s = scripted();
    const v = await openVisitor({ browser: s.browser, link: LINK, web: WEB });
    s.v.emit('response', {
        url: () => 'http://localhost:3001/api/turn-credentials',
        status: () => 200,
        text: async () => '{"iceServers":[{"credential":"secret"}]}',
    });
    s.v.emit('response', { url: () => 'http://localhost:3001/health', status: () => 200 });
    const ev = v.evidence();
    assert.equal(ev.turnFetches.length, 1);
    assert.deepEqual(Object.keys(ev.turnFetches[0]).sort(), ['status', 't']);
    const text = JSON.stringify(ev);
    assert.ok(!text.includes('secret'), 'no TURN body');
    assert.ok(!text.includes(ROOM), 'no room');
    assert.equal(ev.link, 'http://localhost:3000/r/Xk3p9Q0aB1c#<room>');
});

test('a navigation error keeps its words and loses the room it names', async () => {
    const s = scripted();
    const browser = {
        async newContext(opts) {
            const ctx = await s.browser.newContext(opts);
            s.v.gotoError = (url) => `page.goto: net::ERR_CONNECTION_REFUSED at ${url}`;
            return ctx;
        },
    };
    await assert.rejects(
        openVisitor({ browser, link: LINK, web: WEB, tag: 'visitor-1' }),
        (e) =>
            e.message ===
                'visitor-1: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/r/Xk3p9Q0aB1c#<room>' &&
            !e.message.includes(ROOM)
    );
    assert.equal(s.v.closed, true, 'the context it made is closed');
});
