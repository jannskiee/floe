// lib/visitor.mjs: the request link visitor's context against a fake
// browser. No Chromium, no network.
//
// Run: node --test .claude/skills/transfer-audit/scripts/lib/visitor.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openVisitor, visitorTarget } from './visitor.mjs';

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
