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
    PlaywrightMissingError,
    REPORT_STATS_KEY,
    SAMPLE,
    STALE_BUNDLE_KEY,
    TEXT,
    WebLeg,
    bytesMovedFrom,
    candidateCensus,
    checkRelayPolicy,
    classifySample,
    closeBrowser,
    createLeg,
    guardStats,
    loadPlaywright,
    pairBytesFrom,
    preflight,
    probeRelay,
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
    assert.ok(script.includes('dcBytes: { in: 0, out: 0, messages: 0 }'));
    assert.ok(script.includes('audit.dcBytes.in += size(e.data)'));
    assert.doesNotThrow(() => new Function(script));
    assert.ok(String(SAMPLE).includes('dcBytes'));
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
