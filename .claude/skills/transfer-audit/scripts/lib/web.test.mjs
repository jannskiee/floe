/**
 * Tests for web.mjs. The pure parts run everywhere: the init script text,
 * the sample classifier, the route fallback chain, the relay-policy check,
 * the stats guard and the localStorage seed against fake Playwright
 * objects, and the Playwright resolver's error. One live case runs only
 * with LTA_LIVE=1 and LTA_CLIENT_DIR=<repo>/client (the installed tree
 * that owns Playwright): it opens https://www.floe.one/ as a SENDER only,
 * picks a 1 KB file, reads the link, checks the init script landed and the
 * pill reads Ready, then closes. Nobody receives, so the room simply
 * expires; the context aborts /api/stats/report either way.
 *
 * Run: node --test .claude/skills/transfer-audit/scripts/lib/web.test.mjs
 */
import assert from 'node:assert/strict';
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { sleep } from './surfaces.mjs';
import {
    AUDIT_INIT,
    HASH_REFUSAL_AFTER_SENT_MS,
    HASH_REFUSAL_HOLD_MS,
    HASH_REFUSAL_SENTENCE,
    HASH_WIRE_REASONS,
    PlaywrightMissingError,
    REPORT_STATS_KEY,
    SAMPLE,
    SENTRY_ENVELOPE_RE,
    STALE_BUNDLE_KEY,
    TEXT,
    UMAMI_DISABLED_KEY,
    WEB_CHECKPOINT,
    WebLeg,
    bytesMovedFrom,
    candidateCensus,
    checkRelayPolicy,
    classifySample,
    corruptEndFrame,
    installHashbad,
    closeBrowser,
    createLeg,
    guardSentry,
    guardStats,
    loadPlaywright,
    pairBytesFrom,
    preflight,
    probeRelay,
    readCheckpoint,
    readPill,
    seedLocalStorage,
    shutdown,
    webRoute,
} from './web.mjs';

const made = [];
function fresh() {
    const dir = mkdtempSync(join(tmpdir(), 'transfer-audit-web-'));
    made.push(dir);
    return dir;
}

after(async () => {
    await closeBrowser();
    for (const d of made)
        rmSync(d, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100,
        });
});

const pc = (local, remote, policy = 'all') => ({
    policy,
    connectionState: 'connected',
    iceState: 'connected',
    pair: local || remote ? { local, remote } : null,
});
const sample = (pcs, extra = {}) => ({
    t: 1000,
    pcs,
    pill: null,
    status: [],
    bytesReported: [],
    ...extra,
});

test('AUDIT_INIT carries the relay policy only when the leg forces it', () => {
    const relay = AUDIT_INIT({ relayOnly: true });
    const direct = AUDIT_INIT({ relayOnly: false });
    assert.ok(relay.includes("iceTransportPolicy = 'relay'"));
    assert.ok(!direct.includes('iceTransportPolicy'));
    assert.ok(!AUDIT_INIT({}).includes('iceTransportPolicy'));
    for (const script of [relay, direct]) {
        assert.ok(script.includes('window.__floeAudit'));
        assert.ok(script.includes('class AuditPC extends Native'));
        assert.ok(script.includes('window.webkitRTCPeerConnection = AuditPC'));
        assert.ok(script.includes("'floe-connection-status'"));
        assert.ok(script.includes("'floe:bytes-reported'"));
        assert.doesNotThrow(() => new Function(script), 'the script compiles');
    }
    assert.ok(relay.includes('const relayOnly = true;'));
    assert.ok(direct.includes('const relayOnly = false;'));
});

test('SAMPLE is self-contained page code', () => {
    const src = String(SAMPLE);
    assert.ok(src.includes('window.__floeAudit'));
    assert.ok(src.includes("r.type === 'candidate-pair'"));
    assert.ok(src.includes("r.state === 'succeeded'"));
    assert.ok(src.includes('r.nominated'));
    assert.ok(src.includes('getConfiguration().iceTransportPolicy'));
    for (const outer of [
        'TEXT.',
        'REPORT_STATS_KEY',
        'MAX_SAMPLES',
        'classifySample',
    ])
        assert.ok(
            !src.includes(outer),
            `${outer} would be undefined in the page`
        );
});

test('classifySample: relay on either side wins, host pairs are direct', () => {
    assert.equal(
        classifySample(sample([pc('relay', 'srflx')])).verdict,
        'relay'
    );
    assert.equal(
        classifySample(sample([pc('host', 'relay')])).verdict,
        'relay'
    );
    assert.equal(
        classifySample(sample([pc('srflx', 'srflx')])).verdict,
        'direct'
    );
    assert.equal(
        classifySample(sample([pc('host', 'host')])).verdict,
        'direct'
    );
    assert.equal(classifySample(sample([pc(null, null)])), null);
    assert.equal(classifySample(sample([])), null);
    assert.equal(classifySample(null), null);
    // A closed first PC with no pair does not hide a live second one.
    const r = classifySample(sample([pc(null, null), pc('relay', 'host')]));
    assert.deepEqual(
        {
            verdict: r.verdict,
            local: r.local,
            remote: r.remote,
            source: r.source,
        },
        {
            verdict: 'relay',
            local: 'relay',
            remote: 'host',
            source: 'getStats',
        }
    );
});

test('webRoute: samples, then the last decisive event, then the pill', () => {
    assert.equal(webRoute({}), null);
    const viaStats = webRoute({
        samples: [sample([pc(null, null)]), sample([pc('host', 'srflx')])],
        events: [{ t: 1, detail: 'relay' }],
        pill: 'Relay',
    });
    assert.equal(viaStats.verdict, 'direct');
    assert.equal(viaStats.source, 'getStats');
    const viaEvent = webRoute({
        samples: [sample([pc(null, null)])],
        events: [
            { t: 1, detail: 'connected' },
            { t: 2, detail: 'relay' },
            { t: 3, detail: 'offline' },
        ],
        pill: 'Direct',
    });
    assert.equal(viaEvent.verdict, 'relay');
    assert.equal(viaEvent.source, 'event');
    const viaPill = webRoute({
        events: [{ t: 1, detail: 'connected' }],
        pill: 'Direct',
    });
    assert.deepEqual(
        { verdict: viaPill.verdict, source: viaPill.source },
        { verdict: 'direct', source: 'pill' }
    );
    assert.equal(webRoute({ pill: 'Ready' }), null);
    assert.equal(webRoute({ pill: 'Offline' }), null);
});

test('checkRelayPolicy: every PC on a forced leg must say relay', () => {
    assert.deepEqual(checkRelayPolicy([], false), {
        ok: true,
        checked: 0,
        offenders: [],
    });
    assert.deepEqual(checkRelayPolicy([], true), {
        ok: null,
        checked: 0,
        offenders: [],
    });
    assert.deepEqual(
        checkRelayPolicy([sample([pc('relay', 'srflx', 'relay')])], true),
        {
            ok: true,
            checked: 1,
            offenders: [],
        }
    );
    const bad = checkRelayPolicy(
        [sample([pc('relay', 'srflx', 'relay'), pc('host', 'host', 'all')])],
        true
    );
    assert.deepEqual(bad, { ok: false, checked: 2, offenders: ['all'] });
});

test('guardStats aborts the report and counts the attempt', async () => {
    const routes = [];
    const ctx = {
        route: async (pattern, handler) => routes.push({ pattern, handler }),
    };
    const rec = {};
    await guardStats(ctx, rec);
    assert.equal(routes.length, 1);
    assert.equal(routes[0].pattern, '**/api/stats/report');
    let aborted = null;
    const route = {
        request: () => ({
            method: () => 'POST',
            url: () => 'https://api.floe.one/api/stats/report',
        }),
        abort: async (reason) => {
            aborted = reason;
        },
    };
    await routes[0].handler(route);
    await routes[0].handler(route);
    assert.equal(aborted, 'blockedbyclient');
    assert.equal(rec.attempts.length, 2);
    assert.equal(rec.attempts[0].method, 'POST');
});

test('SENTRY_ENVELOPE_RE matches the envelope path on any ingest host and nothing else', () => {
    for (const url of [
        // The real host carries a region, which is why a host pattern such as
        // "ingest.sentry.io" matched nothing on 2026-10-12.
        'https://o4507.ingest.us.sentry.io/api/4508/envelope/?sentry_version=7&sentry_key=abc&sentry_client=sentry.javascript.nextjs%2F10.72.0',
        'https://o1.ingest.de.sentry.io/api/1/envelope/',
        'https://sentry.example.org/prefix/api/42/envelope/',
        'http://localhost:3001/api/9999/envelope/',
    ])
        assert.equal(SENTRY_ENVELOPE_RE.test(url), true, url);
    for (const url of [
        'https://api.floe.one/api/stats/report',
        'https://api.floe.one/api/turn-credentials',
        'https://www.floe.one/api/config',
        'https://o1.ingest.us.sentry.io/api/1/store/',
        'https://o1.ingest.us.sentry.io/api/envelope/',
        'https://o1.ingest.us.sentry.io/api/1/envelope/extra',
        'https://www.floe.one/docs/api/1/envelope',
    ])
        assert.equal(SENTRY_ENVELOPE_RE.test(url), false, url);
});

test('guardSentry answers the envelope locally, counts it and keeps nothing of it', async () => {
    const routes = [];
    const ctx = {
        route: async (pattern, handler) => routes.push({ pattern, handler }),
    };
    const rec = {};
    const shared = { webGuards: { sentryAnswered: 0 } };
    await guardSentry(ctx, rec, shared);
    assert.equal(routes.length, 1);
    assert.equal(routes[0].pattern, SENTRY_ENVELOPE_RE);
    const fulfilled = [];
    const route = {
        // An envelope's URL carries the project's key and its body the page
        // address: the guard reads neither.
        request: () => {
            throw new Error('the guard must not read the request');
        },
        fulfill: async (o) => fulfilled.push(o),
        // An abort would land in the leg's consoleErrors as
        // net::ERR_BLOCKED_BY_CLIENT and read as a page error.
        abort: async () => {
            throw new Error('the guard answers, it does not abort');
        },
    };
    await routes[0].handler(route);
    await routes[0].handler(route);
    assert.deepEqual(fulfilled[0], {
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: '{}',
    });
    assert.deepEqual(rec, { answered: 2 });
    assert.equal(shared.webGuards.sentryAnswered, 2, 'the run-wide count for the Safety table');
    // A probe has no run-wide record; its own count still holds.
    const alone = {};
    const routes2 = [];
    await guardSentry(
        { route: async (pattern, handler) => routes2.push({ pattern, handler }) },
        alone
    );
    await routes2[0].handler(route);
    assert.deepEqual(alone, { answered: 1 });
});

test('the client sends Sentry straight to its ingest host, so the path guard sees every envelope', () => {
    // A tunnel would post envelopes to a path on the page's own origin, and
    // the guard would then answer nothing while reporting zero.
    const repo = new URL('../../../../../', import.meta.url);
    const read = (rel) => readFileSync(new URL(rel, repo), 'utf8');
    const browserConfig = read('client/sentry.client.config.ts');
    assert.match(browserConfig, /dsn: process\.env\.NEXT_PUBLIC_SENTRY_DSN/);
    assert.doesNotMatch(browserConfig, /\btunnel\s*:/);
    assert.doesNotMatch(read('client/next.config.mjs'), /\btunnelRoute\b/);
});

const answer = (status, headers = {}) => ({
    status: () => status,
    headers: () => headers,
});
const titled = (title) => ({ title: async () => title });

test("readCheckpoint names Vercel's challenge and nothing else", async () => {
    const challenge = { 'x-vercel-mitigated': 'challenge', server: 'Vercel' };
    assert.deepEqual(
        await readCheckpoint(answer(403, challenge), titled('Vercel Security Checkpoint')),
        { status: 403, mitigated: 'challenge', title: true }
    );
    // Either signal is enough: the header on any status, or the page's title
    // on an error status.
    assert.deepEqual(await readCheckpoint(answer(429, challenge), titled('')), {
        status: 429,
        mitigated: 'challenge',
        title: false,
    });
    assert.deepEqual(
        await readCheckpoint(answer(403, {}), titled('Vercel Security Checkpoint')),
        { status: 403, mitigated: null, title: true }
    );
    // Not a challenge: the app, a refusal, a bare error, a page that only
    // borrows the title, a navigation with no response.
    for (const [res, page, what] of [
        [answer(200, { server: 'Vercel' }), titled('Floe'), 'the app'],
        [answer(403, { 'x-vercel-mitigated': 'deny' }), titled('Forbidden'), 'a deny'],
        [answer(403, {}), titled('403'), 'a bare 403'],
        [answer(500, {}), titled('500: This page could not load'), 'a server error'],
        [answer(200, {}), titled('Vercel Security Checkpoint'), 'a 200 with the title'],
        [null, titled('Vercel Security Checkpoint'), 'no response'],
        [undefined, titled(''), 'a fake page that returns nothing'],
    ])
        assert.equal(await readCheckpoint(res, page), null, what);
    // An unreadable page or response is not a challenge either.
    const broken = {
        title: async () => {
            throw new Error('page closed');
        },
    };
    assert.equal(await readCheckpoint(answer(403, {}), broken), null);
    assert.equal(
        await readCheckpoint(
            {
                status: () => {
                    throw new Error('gone');
                },
                headers: () => ({}),
            },
            titled('')
        ),
        null
    );
});

/** A browser whose only page answers `res` to goto; calls are recorded. */
function fakeWebBrowser(res, title = '') {
    const calls = [];
    const routes = [];
    const ctx = {
        async addInitScript(fn, arg) {
            calls.push(['init', typeof fn === 'function' ? arg : String(fn)]);
        },
        async route(pattern, handler) {
            routes.push({ pattern, handler });
            calls.push(['route', pattern]);
        },
        async newPage() {
            calls.push(['newPage']);
            return {
                on() {},
                async goto(url) {
                    calls.push(['goto', url]);
                    return res;
                },
                async title() {
                    return title;
                },
                locator() {
                    throw new Error('the leg read the page after a checkpoint');
                },
                getByText() {
                    throw new Error('the leg read the page after a checkpoint');
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
            async newContext(o) {
                calls.push(['newContext', o]);
                return ctx;
            },
        },
    };
}

test('a web leg served the checkpoint stops as SKIP web-checkpoint, and the next one loads nothing', async () => {
    const challenge = answer(403, { 'x-vercel-mitigated': 'challenge' });
    const shared = { webGuards: { sentryAnswered: 0 } };
    for (const role of ['sender', 'receiver']) {
        const f = fakeWebBrowser(challenge, 'Vercel Security Checkpoint');
        const own = { webGuards: { sentryAnswered: 0 } };
        const leg = createLeg({
            role,
            cellId: 'S-DIR-W2W',
            attempt: 1,
            infra: { web: 'https://www.floe.one' },
            files: ['a'],
            target: 'https://www.floe.one/#room=x',
            browser: f.browser,
            shared: own,
        });
        await assert.rejects(leg.start(), (err) => {
            assert.equal(err.name, 'PhaseError');
            assert.equal(err.verdict, 'SKIP');
            assert.equal(err.reason, WEB_CHECKPOINT);
            assert.match(err.message, /^web-checkpoint: /);
            assert.match(err.message, /HTTP 403/);
            assert.match(err.message, /cannot tell from here whether other visitors are affected/);
            return true;
        });
        assert.deepEqual(own.webCheckpoint, { status: 403, mitigated: 'challenge', title: true });
        assert.deepEqual(leg.evidence().mainDocument, { status: 403, mitigated: 'challenge' });
        // Every guard was in place before the page existed, on either role.
        const order = f.calls.map((c) => c[0]);
        assert.deepEqual(
            f.routes.map((r) => r.pattern),
            ['**/api/stats/report', SENTRY_ENVELOPE_RE]
        );
        assert.ok(order.lastIndexOf('route') < order.indexOf('newPage'));
        assert.ok(
            f.calls.some(
                (c) => c[0] === 'init' && Array.isArray(c[1]) && c[1][0] === UMAMI_DISABLED_KEY && c[1][1] === '1'
            ),
            `${role}: umami.disabled is seeded`
        );
    }
    // The latch: once one leg met the checkpoint, the next opens no context.
    shared.webCheckpoint = { status: 403, mitigated: 'challenge', title: true };
    const g = fakeWebBrowser(answer(200, {}), 'Floe');
    const next = createLeg({
        role: 'receiver',
        infra: { web: 'https://www.floe.one' },
        target: 'https://www.floe.one/#room=y',
        browser: g.browser,
        shared,
    });
    await assert.rejects(next.start(), (err) => {
        assert.equal(err.verdict, 'SKIP');
        assert.equal(err.reason, WEB_CHECKPOINT);
        assert.match(err.message, /an earlier page load of this run/);
        return true;
    });
    assert.deepEqual(g.calls, [], 'no context, no page, no request');
});

test('a refusal that is not the checkpoint does not stop the leg as a SKIP', async () => {
    // A deny or a bare 403 is a failure the audit must report, not this
    // machine's precondition: the leg goes on and fails on the page it reads.
    const f = fakeWebBrowser(answer(403, { 'x-vercel-mitigated': 'deny' }), 'Forbidden');
    const shared = {};
    const leg = createLeg({
        role: 'receiver',
        infra: { web: 'https://www.floe.one' },
        target: 'https://www.floe.one/#room=x',
        browser: f.browser,
        shared,
    });
    await assert.rejects(leg.start(), (err) => {
        assert.notEqual(err.verdict, 'SKIP');
        assert.notEqual(err.reason, WEB_CHECKPOINT);
        return true;
    });
    assert.equal(shared.webCheckpoint, undefined, 'nothing is latched');
    assert.deepEqual(leg.evidence().mainDocument, { status: 403, mitigated: 'deny' });
});

test('probeRelay reports a checkpoint apart from a forcer that did not take', async () => {
    const dir = fresh();
    const f = fakeWebBrowser(answer(403, { 'x-vercel-mitigated': 'challenge' }));
    const r = await probeRelay({
        web: 'https://www.floe.one',
        evidenceDir: dir,
        browser: f.browser,
    });
    assert.equal(r.ok, false);
    assert.equal(r.checkpoint, true);
    assert.match(r.error.message, /^web-checkpoint: /);
    assert.equal(r.receiver, null, 'the receiver was never opened');
});

test('seedLocalStorage installs an init script with the key and value', async () => {
    const calls = [];
    const ctx = { addInitScript: async (fn, arg) => calls.push({ fn, arg }) };
    await seedLocalStorage(ctx, REPORT_STATS_KEY, 'false');
    assert.equal(calls.length, 1);
    assert.equal(typeof calls[0].fn, 'function');
    assert.deepEqual(calls[0].arg, ['floe:report-stats', 'false']);
    assert.ok(String(calls[0].fn).includes('localStorage.setItem'));
});

test('loadPlaywright reports a missing install as a precondition', () => {
    assert.throws(
        () => loadPlaywright(fresh()),
        (err) => {
            assert.ok(err instanceof PlaywrightMissingError);
            assert.equal(err.code, 'playwright-missing');
            assert.equal(err.exitCode, 3);
            assert.match(err.message, /no package.json/);
            return true;
        }
    );
    const dir = fresh();
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}');
    assert.throws(
        () => loadPlaywright(dir),
        /@playwright\/test is not installed/
    );
    assert.throws(() => loadPlaywright(''), /clientDir is required/);
});

test('WebLeg construction and the receiver stats proof shape', () => {
    const leg = createLeg({
        role: 'receiver',
        cellId: 'S-DIR-W2W',
        attempt: 1,
        infra: { web: 'http://localhost:3000' },
        target: 'http://localhost:3000/#room=x',
    });
    assert.ok(leg instanceof WebLeg);
    assert.equal(leg.surface, 'web');
    assert.equal(leg.route(), null);
    const ev = leg.evidence();
    assert.equal(ev.policyOk, true, 'a direct leg passes the policy check');
    assert.equal(
        createLeg({
            role: 'sender',
            relayOnly: true,
            files: ['a'],
            infra: { web: 'x' },
        }).evidence().policyOk,
        null,
        'a relay-forced leg with no PC sampled yet is unknown, never false'
    );
    assert.equal(typeof shutdown, 'function');
    assert.deepEqual(ev.statsProof, {
        kind: 'route-abort',
        attempts: 0,
        bytesReportedEvents: 0,
        localStorageSeed: 'false',
        localStorageRead: null,
        breach: true,
    });
    assert.equal(
        createLeg({
            role: 'sender',
            files: ['a'],
            infra: { web: 'x' },
        }).evidence().statsProof,
        null
    );
    assert.equal(TEXT.pill.test('Ready'), true);
    assert.equal(TEXT.pill.test('READY'), false);
    assert.equal(
        TEXT.transferComplete,
        'Transfer complete',
        'the sender accepts the post-disconnect status a fast CLI receiver leaves behind'
    );
});

test('AUDIT_INIT tracks every data channel and SAMPLE carries the counter', () => {
    const script = AUDIT_INIT({});
    assert.ok(script.includes("addEventListener('datachannel'"));
    assert.ok(script.includes('createDataChannel(...args)'));
    assert.ok(script.includes('dcBytes: { in: 0, out: 0, messages: 0, binIn: 0, binOut: 0 }'));
    assert.ok(script.includes("if (typeof e.data !== 'string') audit.dcBytes.binIn += size(e.data)"));
    assert.ok(script.includes('audit.dcBytes.in += size(e.data)'));
    assert.doesNotThrow(() => new Function(script));
    assert.ok(String(SAMPLE).includes('dcBytes'));
});

test('bytesMovedFrom counts only binary frames, so a text refusal reason is not file data', () => {
    // The relay-cap refusal of 2026-09-17: one 143 B TEXT incompatible frame
    // arrived and no binary frame did. That is a correct refusal.
    assert.equal(bytesMovedFrom([sample([], { dcBytes: { in: 143, out: 0, messages: 1, binIn: 0, binOut: 0 } })]), 0);
    // A chunk that did cross is counted, in either direction.
    assert.equal(bytesMovedFrom([sample([], { dcBytes: { in: 4239, out: 20, messages: 3, binIn: 4096, binOut: 0 } })]), 4096);
    assert.equal(bytesMovedFrom([sample([], { dcBytes: { in: 0, out: 64, messages: 1, binIn: 0, binOut: 64 } })]), 64);
});

test('bytesMovedFrom counts data-channel bytes, pairBytesFrom keeps the pair counters for the record', () => {
    assert.equal(bytesMovedFrom([]), 0);
    assert.equal(bytesMovedFrom([sample([], { dcBytes: null })]), 0);
    assert.equal(
        bytesMovedFrom([
            sample([], { dcBytes: { in: 10, out: 5, messages: 2 } }),
            sample([], { dcBytes: null }),
        ]),
        15,
        'the latest sample that carries the counter wins'
    );
    assert.equal(
        bytesMovedFrom([
            sample([], { dcBytes: { in: 1, out: 0 } }),
            sample([], { dcBytes: { in: 4096, out: 64 } }),
        ]),
        4160
    );
    const pcs = (sent, received) => [
        {
            policy: 'all',
            pair: {
                local: 'host',
                remote: 'host',
                bytesSent: sent,
                bytesReceived: received,
            },
        },
    ];
    assert.deepEqual(
        pairBytesFrom([
            sample(pcs(10, 20)),
            sample(pcs(30, 25)),
            sample([pc(null, null)]),
        ]),
        { sent: 30, received: 25 }
    );
    const leg = createLeg({
        role: 'receiver',
        cellId: 'S-REL-C2W-cap3g',
        infra: { web: 'x' },
        target: 'x',
    });
    assert.equal(leg.bytesMoved(), 0, 'nothing sampled, nothing moved');
    // A connected refusal: handshake bytes on the pair, none on the channel.
    leg.samples.push(sample(pcs(2500, 2300), { dcBytes: { in: 0, out: 0 } }));
    assert.equal(leg.bytesMoved(), 0);
    leg.samples.push(
        sample(pcs(9000, 70000), { dcBytes: { in: 65536, out: 40 } })
    );
    assert.equal(leg.bytesMoved(), 65576);
    const ev = leg.evidence();
    assert.equal(ev.dcBytes, 65576);
    assert.deepEqual(ev.pairBytes, { sent: 9000, received: 70000 });
});

test('downloadZip clicks Download ZIP, waits for the download and saves it where asked', async () => {
    const dir = fresh();
    const dest = join(dir, 'evidence', 'received.zip');
    const events = [];
    const page = {
        waitForEvent: async (name, opts) => {
            events.push(['wait', name, opts.timeout]);
            return {
                saveAs: async (p) => {
                    events.push(['saveAs', p]);
                    writeFileSync(p, 'zip-bytes');
                },
            };
        },
        getByRole: (role, opts) => ({
            click: async () => {
                events.push(['click', role, String(opts.name)]);
            },
        }),
    };
    const leg = createLeg({
        role: 'receiver',
        cellId: 'S-DIR-C2W-zip',
        infra: { web: 'x' },
        target: 'x',
    });
    leg.page = page;
    assert.equal(await leg.downloadZip(dest), dest);
    assert.equal(readFileSync(dest, 'utf8'), 'zip-bytes');
    assert.deepEqual(
        events.map((e) => e[0]),
        ['wait', 'click', 'saveAs'],
        'the download listener is armed before the click'
    );
    assert.equal(events[0][1], 'download');
    assert.deepEqual(events[1].slice(1), ['button', String(TEXT.downloadZip)]);
    assert.ok(TEXT.downloadZip.test('Download ZIP'));
    assert.ok(!TEXT.downloadZip.test('Download All'));
    assert.ok(!TEXT.downloadZip.test('Zipping...'));
    assert.equal(leg.evidence().zipPath, dest);
    assert.ok(leg.marks.zip > 0);
    await assert.rejects(
        createLeg({
            role: 'sender',
            files: ['a'],
            infra: { web: 'x' },
        }).downloadZip(dest),
        /receiver/
    );
    leg.page = null;
    await assert.rejects(leg.downloadZip(dest), /receiver/);
});

test('stop() charges a browser:reload when the page reloaded itself for a stale bundle', async () => {
    const spent = [];
    const fakePage = (stale) => ({
        isClosed: () => false,
        getByText: () => ({
            first: () => ({ textContent: async () => 'Ready' }),
        }),
        evaluate: async (fn, arg) => (arg === STALE_BUNDLE_KEY ? stale : null),
    });
    const mk = (stale) => {
        const leg = createLeg({
            role: 'receiver',
            cellId: 'x',
            infra: { web: 'x' },
            target: 'x',
            ledger: { spend: (k) => spent.push(k) },
        });
        leg.page = fakePage(stale);
        leg.ctx = { close: async () => {} };
        return leg;
    };
    const reloaded = mk(String(Date.now()));
    await reloaded.stop('test');
    assert.deepEqual(spent, ['browser:reload']);
    assert.ok(reloaded.notes.includes('stale-bundle-reload'));
    assert.equal(reloaded.pillFinal, 'Ready');
    spent.length = 0;
    const clean = mk(null);
    await clean.stop('test');
    assert.deepEqual(spent, []);
    assert.ok(!clean.notes.includes('stale-bundle-reload'));
});

test('probeRelay paces two TURN and two connections first and keeps its fixture under the evidence dir', async () => {
    const dir = fresh();
    const waits = [];
    const ledger = {
        waitFor: async (cost) => {
            waits.push(cost);
            return 0;
        },
        spend: () => {},
    };
    const evidenceDir = join(dir, 'probe-evidence');
    const r = await probeRelay({
        web: 'https://web.invalid',
        clientDir: fresh(),
        evidenceDir,
        ledger,
        sizeBytes: 2048,
    });
    assert.deepEqual(waits, [{ turn: 2, conn: 2 }], 'paced before any page');
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'playwright-missing');
    const fixture = join(evidenceDir, 'fixture', 'probe.bin');
    assert.ok(existsSync(fixture), 'the fixture lives under the evidence dir');
    assert.equal(statSync(fixture).size, 2048);
    assert.equal(r.bytes, 2048);
    await assert.rejects(
        probeRelay({ web: 'x', clientDir: dir }),
        /evidenceDir is required/
    );
});

// ---------------------------------------------------------------------------
// live: https://www.floe.one/ as a sender only
// ---------------------------------------------------------------------------

const LIVE = process.env.LTA_LIVE === '1';
const CLIENT_DIR = process.env.LTA_CLIENT_DIR || '';

test(
    'live: floe.one sender page gets the init script, a link and a Ready pill',
    {
        skip: !LIVE
            ? 'set LTA_LIVE=1 and LTA_CLIENT_DIR'
            : !CLIENT_DIR && 'LTA_CLIENT_DIR unset',
    },
    async () => {
        const pre = await preflight({ clientDir: CLIENT_DIR });
        assert.equal(pre.ok, true, pre.reason);
        const dir = fresh();
        const file = join(dir, 'hello-1k.bin');
        writeFileSync(file, Buffer.alloc(1024, 0x41));
        const leg = createLeg({
            role: 'sender',
            cellId: 'LIVE-W-SENDER',
            attempt: 1,
            infra: { web: 'https://www.floe.one' },
            files: [file],
            clientDir: CLIENT_DIR,
            evidenceDir: join(dir, 'evidence'),
            deadlineAt: Date.now() + 90_000,
        });
        try {
            await leg.start();
            const link = await leg.link();
            assert.match(
                link,
                /^https:\/\/www\.floe\.one\/.*#room=[0-9a-f-]{36}$/
            );
            const audit = await leg.page.evaluate(() => {
                const a = window.__floeAudit;
                return (
                    a && {
                        relayOnly: a.relayOnly,
                        pcs: a.pcs.length,
                        status: a.status.length,
                    }
                );
            });
            assert.ok(audit, 'window.__floeAudit exists');
            assert.equal(audit.relayOnly, false);
            let pill = null;
            for (let i = 0; i < 40 && pill !== 'Ready'; i++) {
                pill = await readPill(leg.page, 500);
                if (pill !== 'Ready') await sleep(250);
            }
            assert.equal(pill, 'Ready');
            console.log(
                `live: link ${link.replace(/#room=.*/, '#room=<redacted>')}, pill ${pill}, pcs ${audit.pcs}, status events ${audit.status}`
            );
        } finally {
            await leg.stop('live test');
        }
        const ev = leg.evidence();
        assert.equal(ev.statsAttempts, 0);
        assert.equal(ev.pillFinal, 'Ready');
        assert.ok(ev.samples.length > 0);
        assert.ok(ev.screenshots.length === 1);
        assert.deepEqual(ev.pageErrors, []);
    }
);

test('the receiver honors expectFiles from the cell runner and defaults to one', () => {
    const base = {
        role: 'receiver',
        attempt: 1,
        infra: { web: 'http://localhost:3000' },
        target: 'http://localhost:3000/#room=x',
    };
    assert.equal(
        createLeg({ ...base, cellId: 'S-DIR-C2W-zip', expectFiles: 3 })
            .expectFiles,
        3
    );
    assert.equal(createLeg({ ...base, cellId: 'S-DIR-C2W' }).expectFiles, 1);
    assert.equal(
        createLeg({ ...base, cellId: 'S-DIR-C2W', files: ['a', 'b'] })
            .expectFiles,
        2
    );
});

test('AUDIT_INIT candidate census: gathered and received candidate types per PC', async () => {
    class FakePC {
        constructor(cfg) {
            this.cfg = cfg;
            this.listeners = {};
        }
        addEventListener(name, fn) {
            (this.listeners[name] ||= []).push(fn);
        }
        fire(name, ev) {
            for (const fn of this.listeners[name] || []) fn(ev);
        }
        createDataChannel() {
            return { addEventListener() {}, send() {} };
        }
        addIceCandidate() {
            return Promise.resolve();
        }
        setRemoteDescription() {
            return Promise.resolve();
        }
    }
    const window = { RTCPeerConnection: FakePC, addEventListener() {} };
    new Function('window', AUDIT_INIT({ relayOnly: true }))(window);
    const pc = new window.RTCPeerConnection({});
    assert.equal(pc.cfg.iceTransportPolicy, 'relay');
    assert.deepEqual(pc.__floeCand, { local: [], remote: [] });
    pc.fire('icecandidate', {
        candidate: {
            candidate:
                'candidate:1 1 udp 41885439 203.0.113.9 50000 typ relay raddr 0.0.0.0 rport 0',
        },
    });
    pc.fire('icecandidate', { candidate: null });
    await pc.addIceCandidate({
        candidate: 'candidate:2 1 udp 2130706431 192.168.1.5 5000 typ host',
    });
    await pc.addIceCandidate({
        candidate: 'candidate:2 1 udp 2130706431 192.168.1.6 5001 typ host',
    });
    await pc.setRemoteDescription({
        type: 'answer',
        sdp: 'v=0\r\na=candidate:3 1 udp 1694498815 198.51.100.7 6000 typ srflx raddr 192.168.1.5 rport 5000\r\na=end-of-candidates\r\n',
    });
    assert.deepEqual(pc.__floeCand, {
        local: ['relay'],
        remote: ['host', 'srflx'],
    });
    assert.equal(window.__floeAudit.pcs.length, 1);
    const src = SAMPLE.toString();
    assert.ok(
        src.includes('cand: pc.__floeCand'),
        'the sample carries the census'
    );
});

test('candidateCensus is the sorted union over samples; evidence carries it with the TURN statuses', () => {
    const s = (cand) => ({ t: 1, pcs: [{ policy: 'all', pair: null, cand }] });
    assert.deepEqual(candidateCensus([]), { local: [], remote: [] });
    assert.deepEqual(candidateCensus([{ t: 1, pcs: [{ policy: 'all' }] }]), {
        local: [],
        remote: [],
    });
    assert.deepEqual(
        candidateCensus([
            s({ local: ['srflx', 'host'], remote: ['relay'] }),
            s({ local: ['host'], remote: ['prflx'] }),
        ]),
        { local: ['host', 'srflx'], remote: ['prflx', 'relay'] }
    );
    const leg = createLeg({
        role: 'sender',
        relayOnly: true,
        files: ['a'],
        infra: { web: 'x' },
    });
    assert.deepEqual(leg.evidence().turnFetches, []);
    assert.deepEqual(leg.evidence().candidates, { local: [], remote: [] });
    leg.turnFetches.push({ t: 5, status: 429 });
    const ev = leg.evidence();
    assert.deepEqual(ev.turnFetches, [{ t: 5, status: 429 }]);
    assert.deepEqual(
        Object.keys(ev.turnFetches[0]),
        ['t', 'status'],
        'status only, never a body'
    );
    assert.ok(
        !JSON.stringify(ev).includes('credential'),
        'no credential-shaped key in the evidence'
    );
});

test('hashbad rewrite changes exactly one hex digit of an end frame and nothing else', () => {
    const digest = 'a'.repeat(64);
    const frame = `{"type":"end","sha256":"${digest}"}`;
    const out = corruptEndFrame(frame);
    assert.equal(out.length, frame.length, 'the frame keeps its length');
    assert.notEqual(out, frame, 'the frame changed');
    const changed = [...frame].filter((c, i) => c !== out[i]);
    assert.equal(changed.length, 1, 'exactly one character changed');
    const outDigest = JSON.parse(out).sha256;
    assert.match(outDigest, /^[0-9a-f]{64}$/, 'still 64 lowercase hex characters');
    assert.equal(outDigest.slice(1), digest.slice(1), 'only the first digit moved');
    assert.equal(JSON.parse(out).type, 'end', 'still an end frame');

    // Everything else is passed through untouched, including a chunk.
    for (const other of [
        '{"type":"end"}',
        '{"type":"metadata","id":"x"}',
        '{"type":"end","sha256":"ZZ"}',
        '',
    ]) {
        assert.equal(corruptEndFrame(other), other, `untouched: ${other}`);
    }
    const chunk = new Uint8Array([1, 2, 3]);
    assert.equal(corruptEndFrame(chunk), chunk, 'a chunk is returned as it came');
});

test('the hash refusal strings the web leg waits for are the products own words', () => {
    // Quoted rather than imported, so a copy change must break this test before
    // it silently turns a forced-mismatch cell into a done timeout (P0-27).
    const repo = new URL('../../../../../', import.meta.url);
    const read = (rel) => readFileSync(new URL(rel, repo), 'utf8');
    const receiverTs = read('client/lib/transfer/receiver.ts');
    for (const s of TEXT.selfDiscardedHash)
        assert.ok(receiverTs.includes(s), `receiver.ts no longer says: ${s}`);
    // A sender page renders the WIRE reason, so each string must be what BOTH
    // receivers put on the frame (review F2: an earlier pin read control.go's
    // local sentences, which no sender page ever shows).
    const receiverGo = read('cli/engine/transfer/receiver.go');
    for (const s of HASH_WIRE_REASONS) {
        assert.ok(receiverGo.includes(`"${s}"`), `receiver.go does not send: ${s}`);
        assert.ok(receiverTs.includes(s), `receiver.ts does not send: ${s}`);
        assert.ok(TEXT.peerRefusedHash.includes(s), `the leg stopped waiting for: ${s}`);
    }
    assert.match(
        receiverTs,
        /const HASH_MISMATCH_REASON = 'receiver discarded a file because its SHA-256 did not match';/
    );
    // The late refusal is the sender page's OWN sentence, not a wire reason,
    // so it is pinned here byte for byte. The client commit of this card puts
    // it in client/lib/senderStop.ts; the moment that file exists this test
    // reads it from there too, the same way the wire reasons are read.
    assert.equal(
        HASH_REFUSAL_SENTENCE,
        'The other side discarded a file that did not match what was sent. Try sending again.'
    );
    assert.ok(TEXT.peerRefusedHash.includes(HASH_REFUSAL_SENTENCE));
    const senderStop = new URL('client/lib/senderStop.ts', repo);
    if (existsSync(senderStop))
        assert.ok(
            readFileSync(senderStop, 'utf8').includes(HASH_REFUSAL_SENTENCE),
            'senderStop.ts no longer prints the sentence the sender leg waits for'
        );
});

test('a lying cell senders bound comes from the receivers own flush timeout', () => {
    // The refusal frame goes out and is then flushed for up to
    // controlFlushTimeout before the CLI receiver closes the channel, so the
    // bound has to sit above it with room for a loaded machine. Read from the
    // engine so a change there cannot quietly outlive the bound.
    const controlGo = readFileSync(
        new URL('../../../../../cli/engine/transfer/control.go', import.meta.url),
        'utf8'
    );
    const m = controlGo.match(
        /controlFlushTimeout = (\d+) \* time\.(Second|Millisecond)/
    );
    assert.ok(m, 'control.go no longer declares controlFlushTimeout');
    const flushMs = Number(m[1]) * (m[2] === 'Second' ? 1000 : 1);
    assert.equal(flushMs, 2000, 'the measured gap after All Files Sent! moved');
    assert.equal(HASH_REFUSAL_AFTER_SENT_MS, 15_000);
    assert.ok(
        HASH_REFUSAL_AFTER_SENT_MS > flushMs * 2,
        'the bound must outlast the receivers flush, not race it'
    );
    // The hold is the same clock read from the other end: the receiver closes
    // and exits after that flush, and the exit is what drops the socket that
    // fires peer-disconnected on the sender. Four times the flush, and inside
    // the first bound so a lying cell never pays for two long waits.
    assert.equal(HASH_REFUSAL_HOLD_MS, 8_000);
    assert.ok(
        HASH_REFUSAL_HOLD_MS > flushMs * 2,
        'the hold must outlast the receivers flush and exit, not race them'
    );
    assert.ok(
        HASH_REFUSAL_HOLD_MS < HASH_REFUSAL_AFTER_SENT_MS,
        'the hold must not dominate the wait that precedes it'
    );
});

/**
 * A page driven by the predicates awaitDone runs. Each waitForFunction poll
 * consumes the next frame and the last frame repeats, so a frame list is a
 * timeline: ['sent', 'sent', 'sent + refusal'] is a page that shows the
 * success line and then the refusal two polls later. The predicate reads
 * document.body.innerText in the browser, so the fake installs a document
 * while it runs and puts the old one back.
 *
 * A frame is the page's text, or { text, anchors, connected } for the
 * predicates that read more than the text: the receiver's completion counts
 * a[download], and awaitConnected reads window.__floeAudit, which is one
 * object for the life of the page (the init script's), so what a predicate
 * keeps on it between polls is still there on the next one.
 *
 * `polls` counts the frames read. With `stepMs` the page keeps its own clock:
 * Date.now() is that clock while a wait runs, each poll moves it on by stepMs
 * and nothing sleeps, so a test of a dwell, or of what happens before a
 * budget's last stretch, is a count of polls and does not depend on how fast
 * this machine gets through them (a loaded CI runner took 300 ms dwells and
 * "three polls before the look" for timeouts). `now()` reads that clock.
 */
function scriptedPage(frames, { stepMs = 0 } = {}) {
    let poll = 0;
    const timeouts = [];
    const audit = { pcs: [] };
    const realNow = Date.now;
    let t = realNow();
    return {
        timeouts,
        audit,
        get polls() {
            return poll;
        },
        now: () => (stepMs ? t : realNow()),
        async waitForFunction(fn, arg, opts = {}) {
            timeouts.push(opts.timeout);
            if (stepMs) Date.now = () => t;
            const deadline = Date.now() + (opts.timeout ?? 1000);
            const had = Object.getOwnPropertyDescriptor(globalThis, 'document');
            const hadWindow = Object.getOwnPropertyDescriptor(
                globalThis,
                'window'
            );
            try {
                for (;;) {
                    const raw = frames[Math.min(poll, frames.length - 1)];
                    const frame = typeof raw === 'string' ? { text: raw } : raw;
                    poll += 1;
                    globalThis.document = {
                        body: { innerText: frame.text },
                        querySelectorAll: () => ({
                            length: frame.anchors ?? 0,
                        }),
                    };
                    audit.pcs = frame.connected
                        ? [{ connectionState: 'connected' }]
                        : [];
                    globalThis.window = { __floeAudit: audit };
                    const value = fn(arg);
                    if (value) return { jsonValue: async () => value };
                    if (Date.now() >= deadline)
                        throw new Error(`Timeout ${opts.timeout}ms exceeded`);
                    if (stepMs) {
                        t += stepMs;
                        await sleep(0);
                    } else await sleep(10);
                }
            } finally {
                if (stepMs) Date.now = realNow;
                if (had) Object.defineProperty(globalThis, 'document', had);
                else delete globalThis.document;
                if (hadWindow)
                    Object.defineProperty(globalThis, 'window', hadWindow);
                else delete globalThis.window;
            }
        },
        evaluate: async () => null,
    };
}

test("a lying cell's web sender is complete only once the refusal copy shows", async (t) => {
    // F-SHA-4: a browser sender reached "All Files Sent!" and the CLI
    // receiver's hash-mismatch refusal landed about two seconds later and was
    // dropped, so the page went on claiming success. The old rule took
    // allSent on its own, which is why every H-DIR-W2C-hashbad run passed
    // while the page was lying.
    const mk = (frames, opts = {}) => {
        const leg = createLeg({
            role: 'sender',
            cellId: 'H-DIR-W2C-hashbad',
            attempt: 1,
            infra: { web: 'x' },
            files: ['a'],
            hashLie: 'corrupt',
            // Past, so budget() clamps both waits to its 1 s floor: the bound
            // itself is pinned by the test above.
            deadlineAt: Date.now(),
            ...opts,
        });
        leg.page = scriptedPage(frames);
        return leg;
    };

    await t.test('the refusal that lands after allSent is the verdict', async () => {
        const late = mk([
            TEXT.allSent,
            TEXT.allSent,
            `${TEXT.allSent}\n${HASH_REFUSAL_SENTENCE}`,
        ]);
        const done = await late.awaitDone(1000);
        assert.equal(done.kind, 'refusal');
        assert.equal(done.ok, true);
        assert.equal(
            late.page.timeouts.length,
            3,
            'allSent opened the refusal wait and then the hold'
        );
        assert.ok(!late.notes.includes('hash-refusal-missing'));
    });

    await t.test('a page still claiming success when the bound runs out fails', async () => {
        // It has to THROW, not report a failed completion: verifyAttempt reads
        // a forced-mismatch cell's SENDER result only when the sender is the
        // harness (cell.mjs), so a returned failure would leave this cell
        // passing exactly as it did before.
        const silent = mk([TEXT.allSent]);
        await assert.rejects(silent.awaitDone(1000), (err) => {
            assert.equal(err.name, 'PhaseError');
            assert.equal(err.phase, 'done');
            assert.equal(err.signatureKey, 'hash-refusal-missing');
            assert.match(err.message, /still claims success/);
            assert.ok(
                !/no completion in/.test(err.message),
                'the generic done wrapper must not swallow the wording'
            );
            return true;
        });
        assert.ok(
            silent.notes.includes('hash-refusal-missing'),
            'the evidence names why the cell failed'
        );
    });

    await t.test('a wire reason mid-send is still one wait', async () => {
        const early = mk([HASH_WIRE_REASONS[0]]);
        const done = await early.awaitDone(1000);
        assert.equal(done.kind, 'refusal');
        assert.equal(early.page.timeouts.length, 1);
    });

    // The refusal showing is not the end of it. The CLI receiver exits about
    // two seconds later and drops its signaling socket, and the sender's
    // onPeerDisconnected used to rewrite the status with receiveOutcome(),
    // which on a sender returns 'Transfer complete'. The banner stayed right,
    // so the wait above passed while the page contradicted itself.
    await t.test('a status that goes back to complete under the banner fails', async () => {
        const flips = mk([
            TEXT.allSent,
            `${TEXT.allSent}\n${HASH_REFUSAL_SENTENCE}`,
            `${TEXT.transferComplete}\n${HASH_REFUSAL_SENTENCE}`,
        ]);
        await assert.rejects(flips.awaitDone(1000), (err) => {
            assert.equal(err.name, 'PhaseError');
            assert.equal(err.phase, 'done');
            assert.equal(err.signatureKey, 'hash-refusal-overwritten');
            assert.match(err.message, /went back to/);
            return true;
        });
        assert.ok(
            flips.notes.includes('hash-refusal-overwritten'),
            'the evidence names why the cell failed'
        );
        assert.ok(
            !flips.notes.includes('hash-refusal-missing'),
            'the refusal did show, so the earlier signature must not fire'
        );
    });

    await t.test('a refusal that holds through the bound is the verdict', async () => {
        const holds = mk([
            TEXT.allSent,
            `${TEXT.allSent}\n${HASH_REFUSAL_SENTENCE}`,
            `${TEXT.allSent}\n${HASH_REFUSAL_SENTENCE}`,
        ]);
        const done = await holds.awaitDone(1000);
        assert.equal(done.kind, 'refusal');
        assert.equal(done.ok, true);
        assert.equal(holds.page.timeouts.length, 3, 'the hold is its own wait');
        assert.equal(holds.notes.length, 0);
    });

    // No other cell's verdict changed: a sender that does not lie is done at
    // allSent, exactly as before, and never opens the second wait.
    await t.test('a cell that does not lie is done at allSent', async () => {
        const honest = mk([TEXT.allSent], { hashLie: null, cellId: 'H-DIR-W2C' });
        const done = await honest.awaitDone(1000);
        assert.equal(done.ok, true);
        assert.equal(done.kind, 'transfer');
        assert.equal(done.detail.outcome, 'sent');
        assert.equal(honest.page.timeouts.length, 1, 'an ordinary cell waits once');
    });
});

test('the hashbad rewrite matches the end frame the client really builds', () => {
    // endMessage builds { type: 'end', sha256: digest } and JSON.stringify keeps
    // that key order; if the order flips, corruptEndFrame becomes a
    // pass-through and every hashbad cell reads as a false FAIL (review F10).
    const protocolTs = readFileSync(
        new URL('../../../../../client/lib/transfer/protocol.ts', import.meta.url),
        'utf8'
    );
    assert.match(protocolTs, /\{ type: 'end', sha256: digest \}/);
    const frame = JSON.stringify({ type: 'end', sha256: 'a'.repeat(64) });
    assert.notEqual(corruptEndFrame(frame), frame, 'the rewrite applies to that shape');
});

test('installHashbad ships the same rewrite into the page', async () => {
    let installed = null;
    await installHashbad({ addInitScript: (arg) => { installed = arg; } });
    assert.ok(installed && typeof installed.content === 'string', 'an init script with source');
    assert.ok(
        installed.content.includes('{"type":"end","sha256":"'),
        'the page gets the same prefix this test pinned'
    );
    assert.ok(
        installed.content.includes('RTCDataChannel.prototype.send'),
        'it wraps the send the app uses'
    );
});

// ------------------------------------------- the page states of 2026-10-12
//
// main gained four page states on 2026-10-12 (#533 and #535): a receive that
// ended short of the announced count, a receive still waiting for its next
// file, a receiver told nobody is on the sending side, and a sender retrying
// (then giving up on) a join its own room refused. The leg knew none of them,
// so each ran a connect or done budget out and was filed as connect-timeout or
// phase-timeout. They are named here the way awaitRefusalAfterSent names its
// own: a keyed PhaseError, a note, and a row in lib/triage.mjs.

test('the page states the web leg names are the products own words', () => {
    const repo = new URL('../../../../../', import.meta.url);
    const read = (rel) => readFileSync(new URL(rel, repo), 'utf8');
    const summary = read('client/lib/receiveSummary.ts');
    assert.ok(
        summary.includes(`\${sofar} ${TEXT.receiveShort}\``),
        `receiveSummary.ts no longer ends a short receive with: ${TEXT.receiveShort}`
    );
    // One state, two wordings: "Waiting for the next file" on main through
    // 2a6e273, "Waiting for the rest" on a later main. floe.one always runs
    // the newest main while a self-host or an older head keeps the first, so
    // the leg takes both from day one, and the source must say one of them.
    assert.deepEqual(
        [...TEXT.receiveWaiting],
        ['Waiting for the next file', 'Waiting for the rest']
    );
    assert.ok(
        TEXT.receiveWaiting.some((w) => summary.includes(`\${sofar} ${w}\``)),
        `receiveSummary.ts no longer says either of: ${TEXT.receiveWaiting.join(' / ')}`
    );
    const rejoin = read('client/lib/rejoinRetry.ts');
    assert.ok(
        rejoin.includes(`export const REJOINING_STATUS = '${TEXT.rejoining}';`),
        `rejoinRetry.ts REJOINING_STATUS is no longer: ${TEXT.rejoining}`
    );
    assert.ok(
        rejoin.includes(
            `export const REJOIN_FAILED_STATUS = '${TEXT.rejoinFailed}';`
        ),
        `rejoinRetry.ts REJOIN_FAILED_STATUS is no longer: ${TEXT.rejoinFailed}`
    );
    assert.ok(
        read('client/components/ReceiverPanel.tsx').includes(TEXT.senderAbsent),
        `ReceiverPanel.tsx no longer says: ${TEXT.senderAbsent}`
    );
    // The page renders them from these call sites, and the seat yield that
    // can clear the receiver's line by itself is why it needs a dwell.
    const page = read('client/components/P2PTransfer.tsx');
    assert.ok(page.includes('setStatus(REJOIN_FAILED_STATUS)'));
    assert.ok(page.includes('setStatus(REJOINING_STATUS)'));
    assert.ok(page.includes('senderAbsent={senderAbsent}'));
    assert.ok(read('client/lib/roomSeat.ts').includes('yieldSeat: true'));
    // Neither partial line may read as a completed receive of N files to the
    // receiver's own completion predicate (receiveSummary.ts says so too).
    for (const line of [
        `Received 1 of 3 files. ${TEXT.receiveShort}`,
        ...TEXT.receiveWaiting.map((w) => `Received 2 of 3 files. ${w}`),
    ])
        assert.ok(!/(\d+) files? received/.test(line), line);
});

/**
 * A leg on a scripted page, with every wait clamped to budget()'s 1 s floor.
 * `page` goes to scriptedPage: { stepMs } gives the page its own clock.
 */
function pageLeg(role, frames, opts = {}, page = {}) {
    const leg = createLeg({
        role,
        cellId: 'H-DIR-W2W',
        attempt: 1,
        infra: { web: 'x' },
        files: role === 'sender' ? ['a'] : undefined,
        expectFiles: 3,
        deadlineAt: Date.now(),
        ...opts,
    });
    leg.page = scriptedPage(frames, page);
    return leg;
}

test('a receive that ended short is receive-short at once, and one still waiting for its next file only when the done budget is about to run out', async (t) => {
    const short = `Received 1 of 3 files. ${TEXT.receiveShort}`;

    await t.test(
        'the latched early end fails without waiting out the budget',
        async () => {
            const leg = pageLeg('receiver', [short]);
            await assert.rejects(leg.awaitDone(1000), (err) => {
                assert.equal(err.name, 'PhaseError');
                assert.equal(err.phase, 'done');
                assert.equal(err.signatureKey, 'receive-short');
                assert.equal(
                    err.message,
                    'receive-short: the web receiver reads "The transfer ended before the rest arrived." (1 of 3 files)'
                );
                return true;
            });
            assert.equal(leg.page.polls, 1, 'named on the first poll');
            assert.ok(leg.notes.includes('receive-short'));
            assert.equal(
                leg.marks.done,
                undefined,
                'a receive that ended short is never marked done'
            );
        }
    );

    // Both wordings of the waiting line, each on its own: a page shows one.
    for (const wording of [
        'Waiting for the next file',
        'Waiting for the rest',
    ]) {
        const waiting = `Received 2 of 3 files. ${wording}`;

        await t.test(
            `a healthy receive between two files is left alone ("${wording}")`,
            async () => {
                const leg = pageLeg(
                    'receiver',
                    [
                        waiting,
                        waiting,
                        { text: '3 files received', anchors: 3 },
                    ],
                    { timeoutLookMs: 100 },
                    // Three polls, 200 ms on the page's clock: long before
                    // the look opens at 900, however slow this machine is.
                    { stepMs: 100 }
                );
                const done = await leg.awaitDone(1000);
                assert.equal(done.ok, true);
                assert.equal(done.detail.outcome, 'received');
                assert.deepEqual(leg.notes, []);
                assert.equal(leg.page.polls, 3);
            }
        );

        await t.test(
            `still on "${wording}" when the budget is about to run out is receive-short`,
            async () => {
                // The look opens 700 ms before the 1 s budget ends: 300 ms in.
                const leg = pageLeg('receiver', [waiting], {
                    timeoutLookMs: 700,
                });
                const t0 = Date.now();
                await assert.rejects(leg.awaitDone(1000), (err) => {
                    assert.equal(err.phase, 'done');
                    assert.equal(err.signatureKey, 'receive-short');
                    assert.equal(
                        err.message,
                        `receive-short: the web receiver still read "${wording}" (2 of 3 files) in the last 700 ms of its done budget (1000 ms)`
                    );
                    return true;
                });
                assert.ok(
                    Date.now() - t0 >= 300,
                    'never before the look opens'
                );
                assert.ok(leg.notes.includes('receive-short'));
            }
        );
    }

    await t.test(
        'a lying cell still ends on the discard copy, whatever the count line says',
        async () => {
            const leg = pageLeg(
                'receiver',
                [
                    `${TEXT.selfDiscardedHash[0]}\nReceived 1 of 2 files. ${TEXT.receiveShort}`,
                ],
                { peerLies: true }
            );
            const done = await leg.awaitDone(1000);
            assert.equal(done.kind, 'refusal');
        }
    );

    await t.test(
        'a page that says none of it times out with the words it always had',
        async () => {
            const leg = pageLeg('receiver', [TEXT.roomJoined]);
            await assert.rejects(leg.awaitDone(1000), (err) => {
                assert.match(
                    err.message,
                    /^web receiver: no completion in 1000 ms /
                );
                assert.equal(err.signatureKey, undefined);
                return true;
            });
        }
    );
});

test('a sender whose own room refused it is rejoin-failed: at once on the give-up status, and on the retry status only when the budget is about to run out', async (t) => {
    // P2PTransfer.tsx sets this banner with the give-up status. It starts
    // with a capital T and a lower-case l, so it never matches the status.
    const banner =
        'This link stopped working. Reload the page, add the files again, and share the new link.';

    await t.test('done: the give-up status fails at once', async () => {
        const leg = pageLeg('sender', [`${banner}\n${TEXT.rejoinFailed}`]);
        await assert.rejects(leg.awaitDone(1000), (err) => {
            assert.equal(err.phase, 'done');
            assert.equal(err.signatureKey, 'rejoin-failed');
            assert.equal(
                err.message,
                'rejoin-failed: the web sender reads "Link stopped working"'
            );
            return true;
        });
        assert.equal(leg.page.polls, 1, 'named on the first poll');
        assert.ok(leg.notes.includes('rejoin-failed'));
    });

    await t.test(
        'done: the banner left behind by a retry that then connected is not the status',
        async () => {
            const repo = new URL('../../../../../', import.meta.url);
            assert.ok(
                readFileSync(
                    new URL('client/components/P2PTransfer.tsx', repo),
                    'utf8'
                ).includes(banner)
            );
            const leg = pageLeg('sender', [
                `${banner}\nPeer joined. Starting transfer`,
                `${banner}\n${TEXT.allSent}`,
            ]);
            const done = await leg.awaitDone(1000);
            assert.equal(done.detail.outcome, 'sent');
        }
    );

    await t.test(
        'done: a retry in progress is left alone, and a sender that comes through is done',
        async () => {
            const leg = pageLeg(
                'sender',
                [TEXT.rejoining, TEXT.rejoining, TEXT.allSent],
                { timeoutLookMs: 100 },
                { stepMs: 100 }
            );
            const done = await leg.awaitDone(1000);
            assert.equal(done.detail.outcome, 'sent');
            assert.deepEqual(leg.notes, []);
            assert.equal(leg.page.polls, 3);
        }
    );

    await t.test(
        'done: still retrying when the budget is about to run out',
        async () => {
            const leg = pageLeg('sender', [TEXT.rejoining], {
                timeoutLookMs: 700,
            });
            const t0 = Date.now();
            await assert.rejects(leg.awaitDone(1000), (err) => {
                assert.equal(err.signatureKey, 'rejoin-failed');
                assert.equal(
                    err.message,
                    'rejoin-failed: the web sender still read "Reconnecting to your link" in the last 700 ms of its done budget (1000 ms)'
                );
                return true;
            });
            assert.ok(Date.now() - t0 >= 300);
        }
    );

    await t.test('connect: both forms, in the connect phase', async () => {
        const gaveUp = pageLeg('sender', [TEXT.rejoinFailed]);
        await assert.rejects(gaveUp.awaitConnected(1000), (err) => {
            assert.equal(err.phase, 'connect');
            assert.equal(err.signatureKey, 'rejoin-failed');
            assert.equal(
                err.message,
                'rejoin-failed: the web sender reads "Link stopped working"'
            );
            return true;
        });
        const retrying = pageLeg('sender', [TEXT.rejoining], {
            timeoutLookMs: 700,
        });
        const t0 = Date.now();
        await assert.rejects(retrying.awaitConnected(1000), (err) => {
            assert.equal(err.phase, 'connect');
            assert.equal(err.signatureKey, 'rejoin-failed');
            assert.match(
                err.message,
                /still read "Reconnecting to your link" in the last 700 ms of its connect budget \(1000 ms\)$/
            );
            return true;
        });
        assert.ok(Date.now() - t0 >= 300);
        // A retry that gets its seat back and connects is an ordinary connect.
        const back = pageLeg(
            'sender',
            [
                TEXT.rejoining,
                { text: 'Peer joined. Starting transfer', connected: true },
            ],
            { timeoutLookMs: 100 },
            { stepMs: 100 }
        );
        await back.awaitConnected(1000);
        assert.ok(back.marks.connected > 0);
        assert.deepEqual(back.notes, []);
    });

    await t.test(
        'a receiver page never reads a sender status as its own',
        async () => {
            const leg = pageLeg('receiver', [TEXT.rejoinFailed]);
            await assert.rejects(leg.awaitConnected(1000), (err) => {
                assert.match(err.message, /no PC reached connected in 1000 ms/);
                assert.equal(err.signatureKey, undefined);
                return true;
            });
        }
    );
});

test('a receiver told nobody is sending is sender-absent only after the line held for the whole dwell', async (t) => {
    const absent = `${TEXT.roomJoined}\n${TEXT.senderAbsent}`;

    await t.test('the default dwell is 20 s and the look 2 s', async () => {
        const mod = await import('./web.mjs');
        assert.equal(mod.SENDER_ABSENT_DWELL_MS, 20_000);
        assert.equal(mod.TIMEOUT_LOOK_MS, 2_000);
        // Why 20: a sender page whose socket dropped retries its join on
        // REJOIN_DELAYS_MS, and the receiver's line stands until the try
        // that gets the seat back, so it can honestly stand for the longest
        // gap between two tries. The dwell has to outlast that gap, and
        // still fit the shortest connect budget (45 s, lib/matrix.mjs
        // phaseTimeouts) or the state could never be named.
        const src = readFileSync(
            new URL(
                '../../../../../client/lib/rejoinRetry.ts',
                import.meta.url
            ),
            'utf8'
        );
        const delays = /REJOIN_DELAYS_MS = \[([^\]]+)\]/
            .exec(src)[1]
            .split(',')
            .map((n) => Number(n.trim()));
        assert.deepEqual(delays, [2000, 4000, 8000, 15000, 15000, 15000]);
        assert.ok(mod.SENDER_ABSENT_DWELL_MS > Math.max(...delays));
        assert.ok(mod.SENDER_ABSENT_DWELL_MS < 45_000);
    });

    await t.test(
        'a line that holds for the dwell fails, and never sooner',
        async () => {
            // The page's own clock, 100 ms a poll: the line is first read at
            // 0 and has held for 300 on the fourth poll, whatever the wall
            // clock did meanwhile.
            const leg = pageLeg(
                'receiver',
                [absent],
                { senderAbsentDwellMs: 300 },
                { stepMs: 100 }
            );
            const t0 = leg.page.now();
            await assert.rejects(leg.awaitConnected(1000), (err) => {
                assert.equal(err.name, 'PhaseError');
                assert.equal(err.phase, 'connect');
                assert.equal(err.signatureKey, 'sender-absent');
                // The dwell's own words: a connect budget that ran out says
                // "no PC reached connected" and carries no key.
                assert.equal(
                    err.message,
                    'sender-absent: the web receiver read "The sender is not connected" for 300 ms without a break'
                );
                return true;
            });
            const took = leg.page.now() - t0;
            assert.ok(took >= 300, `the dwell was waited out (${took} ms)`);
            assert.equal(leg.page.polls, 4, 'and not one poll longer');
            assert.ok(leg.notes.includes('sender-absent'));
        }
    );

    await t.test(
        'a sender that comes back inside the dwell is an ordinary connect',
        async () => {
            const leg = pageLeg(
                'receiver',
                [absent, absent, { text: TEXT.roomJoined, connected: true }],
                { senderAbsentDwellMs: 300 },
                { stepMs: 100 }
            );
            await leg.awaitConnected(1000);
            assert.ok(leg.marks.connected > 0);
            assert.deepEqual(leg.notes, []);
            assert.equal(leg.page.polls, 3);
        }
    );

    await t.test(
        'the dwell starts over when the line goes away and comes back',
        async () => {
            let clearedAt = null;
            const cleared = {
                get text() {
                    clearedAt = Date.now();
                    return TEXT.roomJoined;
                },
            };
            const leg = pageLeg(
                'receiver',
                [absent, absent, absent, cleared, absent],
                { senderAbsentDwellMs: 300 },
                // On the page's clock the first showing has held 200 ms when
                // the line clears, so only a dwell that started over fails.
                { stepMs: 100 }
            );
            await assert.rejects(leg.awaitConnected(1000), (err) => {
                assert.equal(err.signatureKey, 'sender-absent');
                return true;
            });
            assert.ok(clearedAt, 'the page was read without the line once');
            assert.ok(
                leg.page.now() - clearedAt >= 300,
                'the dwell was counted from the second showing'
            );
            assert.ok(leg.page.audit.senderAbsentSince > clearedAt);
            assert.equal(leg.page.polls, 8, 'three, the clear, then four more');
        }
    );

    await t.test(
        'a line that shows too late to hold for the dwell leaves the plain connect timeout',
        async () => {
            const leg = pageLeg('receiver', [absent], {
                senderAbsentDwellMs: 5000,
            });
            await assert.rejects(leg.awaitConnected(1000), (err) => {
                assert.match(
                    err.message,
                    /^web receiver: no PC reached connected in 1000 ms /
                );
                assert.equal(err.signatureKey, undefined);
                return true;
            });
        }
    );

    await t.test('a sender page is never read for it', async () => {
        const leg = pageLeg('sender', [absent], { senderAbsentDwellMs: 50 });
        await assert.rejects(leg.awaitConnected(1000), (err) => {
            assert.match(err.message, /no PC reached connected in 1000 ms/);
            return true;
        });
    });
});

// ------------------------------------------------ the SHA-256 line (G5)
//
// Evidence only. The audit's own compare of both hashes is the oracle; what
// the page says about its own check is recorded and never judged, so a page
// without the line passes exactly as it did.

/**
 * Lets the leg's one-off page reads see the scripted page's current text.
 * `text` is the transfer card, which the app renders as the page's one
 * <main> (client/components/P2PTransfer.tsx); `landing` is the rest of the
 * homepage around it, and `card: false` is a page with no transfer card.
 */
function readable(leg, text, { landing = '', card = true } = {}) {
    leg.page.evaluate = async (fn, arg) => {
        const had = Object.getOwnPropertyDescriptor(globalThis, 'document');
        globalThis.document = {
            body: { innerText: [text, landing].filter(Boolean).join('\n') },
            querySelector: (sel) =>
                sel === 'main' && card ? { innerText: text } : null,
        };
        try {
            return fn(arg);
        } finally {
            if (had) Object.defineProperty(globalThis, 'document', had);
            else delete globalThis.document;
        }
    };
    return leg;
}

test('the SHA-256 line the web leg records is the apps own', () => {
    const repo = new URL('../../../../../', import.meta.url);
    assert.equal(TEXT.verifiedLine, 'SHA-256 matched');
    assert.ok(
        readFileSync(
            new URL('client/lib/verifiedLine.ts', repo),
            'utf8'
        ).includes(`export const VERIFIED_LINE = '${TEXT.verifiedLine}';`),
        'verifiedLine.ts no longer says it'
    );
});

test('a finished web leg records whether its page showed the SHA-256 line, and never fails for its absence', async (t) => {
    await t.test('a receiver whose page shows it', async () => {
        const text = `3 files received\n${TEXT.verifiedLine}`;
        const leg = readable(pageLeg('receiver', [{ text, anchors: 3 }]), text);
        const done = await leg.awaitDone(1000);
        assert.equal(done.ok, true);
        assert.equal(done.kind, 'transfer');
        assert.deepEqual(done.detail, {
            outcome: 'received',
            verified: 'SHA-256 matched',
        });
    });

    await t.test(
        'a sender whose page does not show it yet is still done',
        async () => {
            const leg = readable(
                pageLeg('sender', [TEXT.allSent]),
                TEXT.allSent
            );
            const done = await leg.awaitDone(1000);
            assert.equal(done.ok, true);
            assert.deepEqual(done.detail, { outcome: 'sent', verified: null });
        }
    );

    // The transfer page is the homepage, and its landing sections say the
    // same words whatever the transfer did: CliTerminal.tsx prints
    // "Verified   SHA-256 matched" in its animation and always carries an
    // sr-only paragraph ending in them, and the FAQ quotes them. Read from
    // the whole body, the line was there on every web leg.
    await t.test(
        'the landing text around the card never counts: only the transfer card is read',
        async () => {
            const landing = [
                '  Verified   SHA-256 matched',
                'Its summary includes the line Verified, SHA-256 matched.',
                TEXT.verifiedLine,
            ].join('\n');
            const text = '3 files received';
            const leg = readable(
                pageLeg('receiver', [{ text, anchors: 3 }]),
                text,
                {
                    landing,
                }
            );
            assert.equal(await leg.readVerifiedLine(), false);
            const done = await leg.awaitDone(1000);
            assert.equal(done.ok, true);
            assert.deepEqual(done.detail, {
                outcome: 'received',
                verified: null,
            });

            // In the card it is a line of its own (ReceiverPanel.tsx and
            // ShareLinkPanel.tsx each give it its own block), so a sentence
            // that only quotes the words is not the line.
            const quoted = readable(
                pageLeg('sender', [TEXT.allSent]),
                `${TEXT.allSent}\nThe CLI shows SHA-256 matched when every file verified`,
                { landing }
            );
            assert.equal(await quoted.readVerifiedLine(), false);
            const shown = readable(
                pageLeg('sender', [TEXT.allSent]),
                `${TEXT.allSent}\n  ${TEXT.verifiedLine}  `
            );
            assert.equal(await shown.readVerifiedLine(), true);

            // A page with no transfer card has nothing to read.
            const bare = readable(pageLeg('sender', [TEXT.allSent]), '', {
                landing,
                card: false,
            });
            assert.equal(await bare.readVerifiedLine(), null);
        }
    );

    await t.test(
        'a page that cannot be read is null, never a failure',
        async () => {
            const leg = pageLeg('sender', [TEXT.allSent]);
            leg.page.evaluate = async () => {
                throw new Error('Target closed');
            };
            const done = await leg.awaitDone(1000);
            assert.equal(done.ok, true);
            assert.equal(done.detail.verified, null);
        }
    );

    await t.test(
        'stop() reads the page once more, which is where a sender line shows',
        async () => {
            const fakePage = (shown) => ({
                isClosed: () => false,
                getByText: () => ({
                    first: () => ({ textContent: async () => 'Ready' }),
                }),
                evaluate: async (fn, arg) =>
                    arg === TEXT.verifiedLine ? shown : null,
            });
            const mk = (shown) => {
                const leg = createLeg({
                    role: 'sender',
                    cellId: 'x',
                    infra: { web: 'x' },
                    files: ['a'],
                });
                leg.page = fakePage(shown);
                leg.ctx = { close: async () => {} };
                return leg;
            };
            const before = mk(true);
            assert.equal(before.evidence().verifiedLine, null, 'not read yet');
            await before.stop('test');
            assert.equal(before.evidence().verifiedLine, true);
            const without = mk(false);
            await without.stop('test');
            assert.equal(without.evidence().verifiedLine, false);
        }
    );
});
