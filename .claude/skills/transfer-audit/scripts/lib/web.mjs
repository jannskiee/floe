/**
 * Web surface adapter for the transfer-audit skill: one headless Chromium
 * per process, a fresh browser context per leg (no service worker, no
 * storage carried over, the same isolation client/e2e/docs-screenshots.mjs
 * relies on when it drives production), and every selector quoted from the
 * client at f14a8d7.
 *
 * Playwright comes from the installed client tree, never from a package of
 * this skill's own: createRequire(<clientDir>/package.json) resolves
 * @playwright/test the way the e2e suite does, so the browser is the one
 * `pnpm test:e2e` already uses (1.62.1, chromium-1234 on this box). A
 * missing install is a PlaywrightMissingError with exitCode 3, a
 * precondition, not a product finding.
 *
 * The relay forcer is an init script that subclasses window.RTCPeerConnection
 * before any app script runs. simple-peer reads globalThis.RTCPeerConnection
 * per Peer at construction (get-browser-rtc index.js:5-7, simple-peer
 * index.js:66-68,101), so the subclass is what the app instantiates, and
 * `iceTransportPolicy: 'relay'` lands in the config the page cannot set
 * itself (docs/how-it-works/relay-connection.mdx: no relay-only mode in the
 * browser). The relay branch is only present in the script text when the
 * leg forces the relay, so a direct leg cannot force one by accident. Every
 * relay-forced leg re-verifies the policy on its own PCs and reports
 * init-script-not-applied as a harness error, never as a product FAIL.
 *
 * The route oracle samples getStats() every 250 ms WHILE the transfer is
 * live: the app destroys the peer at completion and a late getStats() is
 * empty. The predicate is the one client/hooks/useConnectionType.ts uses
 * (nominated succeeded candidate-pair) with the relay rule from
 * client/lib/relay.ts isRelayPair.
 *
 * Stats safety on a receiver is enforced and proven in one place: the
 * context aborts every request to /api/stats/report and counts the
 * attempts (docs-screenshots.mjs:52-57), localStorage['floe:report-stats']
 * is seeded to the literal 'false' before the page loads
 * (useTransferAnalytics.ts:16 reads `!== 'false'`), and the
 * floe:bytes-reported window event (dispatched only when reporting is on,
 * useTransferAnalytics.ts:40,60-62) is collected as the third proof.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Leg, PhaseError, SafetyError, sleep } from './surfaces.mjs';

export const REPORT_STATS_KEY = 'floe:report-stats';
export const STALE_BUNDLE_KEY = 'floe:stale-bundle-reloaded-at';
export const STATS_ROUTE = '**/api/stats/report';
export const SAMPLE_INTERVAL_MS = 250;
export const MAX_SAMPLES = 4000;
export const GOTO_TIMEOUT_MS = 30_000;
export const LINK_TIMEOUT_MS = 20_000;
export const JOIN_TIMEOUT_MS = 30_000;
export const HASH_TIMEOUT_MS = 120_000;

// Strings the adapter waits for, client/components/P2PTransfer.tsx unless
// noted. The pill regex is textContent (title case; CSS uppercases it).
export const TEXT = Object.freeze({
    createLink: /create secure link/i, // :980
    downloadZip: /^Download ZIP$/, // :1059 (accessible name of the button)
    roomJoined: 'Secure room joined', // :1009
    allSent: 'All Files Sent!', // :755
    // onPeerDisconnected and onDisconnect: replaces allSent with this as soon as
    // the peer leaves, and on the sender it is only reachable after
    // onAllSent set transferCompleteRef; a CLI receiver exits within the
    // 500 ms poll, so the sender must accept both.
    transferComplete: 'Transfer complete',
    relayBlocked: 'Transfer blocked. Relay limit exceeded.', // :636
    relayBanner:
        'Transfer limit exceeded. Relay connections are capped at 2 GB.', // :843
    connectionFailed: 'Connection failed', // the three setStatus('Connection failed') sites
    linkInvalid: 'Link Invalid', // :810
    tooManyRefreshes: 'Too many refreshes. Reconnecting', // :217
    received: /^(\d+) files? received$/, // :1110
    pill: /^(Direct|Relay|Ready|Offline)$/, // ConnectionStatusBadge.tsx:59-66
});

export class PlaywrightMissingError extends Error {
    constructor(message, extra = {}) {
        super(message);
        this.name = 'PlaywrightMissingError';
        this.code = 'playwright-missing';
        this.exitCode = 3;
        Object.assign(this, extra);
    }
}

/** { pw, chromium, exe, version } or a PlaywrightMissingError. */
export function loadPlaywright(clientDir) {
    if (!clientDir) {
        throw new PlaywrightMissingError(
            'clientDir is required: the installed client tree (<repo>/client) owns Playwright'
        );
    }
    const pkg = join(clientDir, 'package.json');
    if (!existsSync(pkg)) {
        throw new PlaywrightMissingError(
            `no package.json at ${pkg}: pass --client-dir <repo>/client`,
            { clientDir }
        );
    }
    const req = createRequire(pkg);
    let pw;
    try {
        pw = req('@playwright/test');
    } catch (err) {
        throw new PlaywrightMissingError(
            `@playwright/test is not installed under ${clientDir}: run corepack pnpm install --frozen-lockfile from client/ (not from the root, where corepack picks pnpm 11.7.0)`,
            { clientDir, cause: err }
        );
    }
    const exe = pw.chromium.executablePath();
    if (!existsSync(exe)) {
        throw new PlaywrightMissingError(
            `chromium missing at ${exe}: run client\\node_modules\\.bin\\playwright.CMD install chromium`,
            { clientDir, exe }
        );
    }
    let version = null;
    try {
        version = req('@playwright/test/package.json').version;
    } catch {
        // Older layouts hide package.json; the browser still launches.
    }
    return { pw, chromium: pw.chromium, exe, version };
}

let shared = null;

/** One headless Chromium per process; later calls reuse it. */
export async function getBrowser({
    clientDir,
    headless = true,
    args = [],
} = {}) {
    if (shared) return shared.promise;
    const { chromium } = loadPlaywright(clientDir);
    const entry = { clientDir };
    entry.promise = chromium.launch({ headless, args }).then(
        (browser) => {
            browser.on('disconnected', () => {
                if (shared === entry) shared = null;
            });
            return browser;
        },
        (err) => {
            if (shared === entry) shared = null;
            throw err;
        }
    );
    shared = entry;
    return entry.promise;
}

export async function closeBrowser() {
    if (!shared) return false;
    const entry = shared;
    shared = null;
    try {
        const browser = await entry.promise;
        await browser.close();
        return true;
    } catch {
        return false;
    }
}

/** audit.mjs calls shutdown() on every adapter it used; ours closes Chromium. */
export async function shutdown() {
    return closeBrowser();
}

/**
 * Page-side init script as source text. The relay branch exists in the
 * text only when relayOnly is true. Every data channel the page opens or
 * receives is tracked by message and by send, so bytesMoved() counts what
 * actually crossed the channel: the candidate-pair counters include the
 * DTLS and SCTP handshake and are never zero on a connected peer, which
 * would trip the refusal cells' zero-byte guard on every run.
 */
/**
 * The TURN credential endpoint on any origin the audit points a page at
 * (production, a self-host, the local stack), with or without a query. The
 * leg records the STATUS of each answer, never the body.
 */
export const TURN_FETCH_RE = /\/api\/turn-credentials(?:\?|$)/;

export function AUDIT_INIT({ relayOnly = false } = {}) {
    const force = relayOnly
        ? "            cfg.iceTransportPolicy = 'relay';\n"
        : '';
    return [
        '(() => {',
        `    const relayOnly = ${relayOnly ? 'true' : 'false'};`,
        '    const audit = (window.__floeAudit = {',
        '        relayOnly,',
        '        pcs: [],',
        '        status: [],',
        '        bytesReported: [],',
        '        dcBytes: { in: 0, out: 0, messages: 0 },',
        '        installedAt: Date.now(),',
        '    });',
        '    const size = (d) =>',
        "        d && typeof d.byteLength === 'number'",
        '            ? d.byteLength',
        "            : d && typeof d.size === 'number'",
        '              ? d.size',
        "              : typeof d === 'string'",
        '                ? d.length',
        '                : 0;',
        '    const track = (ch) => {',
        '        if (!ch || ch.__floeTracked) return;',
        '        ch.__floeTracked = true;',
        "        ch.addEventListener('message', (e) => {",
        '            audit.dcBytes.in += size(e.data);',
        '            audit.dcBytes.messages += 1;',
        '        });',
        '        const send = ch.send;',
        '        ch.send = function (d) {',
        '            audit.dcBytes.out += size(d);',
        '            return send.call(this, d);',
        '        };',
        '    };',
        // Candidate census: the type of every candidate this page gathered
        // (icecandidate) and every one the peer sent (addIceCandidate, or
        // inline in the remote SDP). A relay-only page that gathers nothing
        // (its TURN fetch was refused) and a peer that offers only host
        // candidates to a relay-only page both leave a connect-timeout that
        // this census explains. RFC 5245 grammar: six tokens, then typ.
        '    const typ = (s) => {',
        "        const m = / typ (host|srflx|prflx|relay)/.exec(String(s || ''));",
        '        return m ? m[1] : null;',
        '    };',
        '    const note = (arr, t) => {',
        '        if (t && arr.indexOf(t) === -1) arr.push(t);',
        '    };',
        '    const Native = window.RTCPeerConnection;',
        '    if (!Native) return;',
        '    class AuditPC extends Native {',
        '        constructor(config, ...rest) {',
        '            const cfg = Object.assign({}, config || {});',
        force,
        '            super(cfg, ...rest);',
        '            audit.pcs.push(this);',
        '            this.__floeCand = { local: [], remote: [] };',
        "            this.addEventListener('datachannel', (e) => track(e.channel));",
        "            this.addEventListener('icecandidate', (e) =>",
        '                note(this.__floeCand.local, typ(e.candidate && e.candidate.candidate))',
        '            );',
        '        }',
        '        createDataChannel(...args) {',
        '            const ch = super.createDataChannel(...args);',
        '            track(ch);',
        '            return ch;',
        '        }',
        '        addIceCandidate(c, ...rest) {',
        '            note(this.__floeCand.remote, typ(c && c.candidate));',
        '            return super.addIceCandidate(c, ...rest);',
        '        }',
        '        setRemoteDescription(desc, ...rest) {',
        "            const sdp = String((desc && desc.sdp) || '');",
        '            const re = /a=candidate:[^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ typ (host|srflx|prflx|relay)/g;',
        '            let m;',
        '            while ((m = re.exec(sdp))) note(this.__floeCand.remote, m[1]);',
        '            return super.setRemoteDescription(desc, ...rest);',
        '        }',
        '    }',
        '    window.RTCPeerConnection = AuditPC;',
        '    window.webkitRTCPeerConnection = AuditPC;',
        // P2PTransfer.tsx:517-524: 'direct' | 'relay' | 'connected' | 'offline'
        "    window.addEventListener('floe-connection-status', (e) =>",
        '        audit.status.push({ t: Date.now(), detail: e.detail })',
        '    );',
        // useTransferAnalytics.ts:60-62: receiver only, reporting on only
        "    window.addEventListener('floe:bytes-reported', (e) =>",
        '        audit.bytesReported.push({',
        '            t: Date.now(),',
        '            bytes: e.detail && e.detail.bytes,',
        '        })',
        '    );',
        '})();',
    ]
        .filter((line) => line !== '')
        .join('\n');
}

/**
 * Page function: one sample of every PC the page built plus the pill text.
 * Must not reference module scope (it is serialized by page.evaluate).
 */
export const SAMPLE = async () => {
    const a = window.__floeAudit;
    if (!a) return null;
    const pcs = [];
    for (const pc of a.pcs) {
        let pair = null;
        try {
            const stats = await pc.getStats();
            stats.forEach((r) => {
                if (
                    r.type === 'candidate-pair' &&
                    r.state === 'succeeded' &&
                    r.nominated
                ) {
                    const l = stats.get(r.localCandidateId);
                    const m = stats.get(r.remoteCandidateId);
                    pair = {
                        local: l && l.candidateType,
                        remote: m && m.candidateType,
                        protocol: l && l.protocol,
                        relayProtocol: l && l.relayProtocol,
                        bytesSent: r.bytesSent,
                        bytesReceived: r.bytesReceived,
                    };
                }
            });
        } catch {
            // A closed PC throws; the sample records it without a pair.
        }
        let policy = null;
        try {
            policy = pc.getConfiguration().iceTransportPolicy || 'all';
        } catch {
            // getConfiguration is absent on a closed PC in some builds.
        }
        pcs.push({
            policy,
            connectionState: pc.connectionState,
            iceState: pc.iceConnectionState,
            pair,
            cand: pc.__floeCand
                ? {
                      local: pc.__floeCand.local.slice(),
                      remote: pc.__floeCand.remote.slice(),
                  }
                : null,
        });
    }
    let pill = null;
    for (const span of document.querySelectorAll('span')) {
        const t = (span.textContent || '').trim();
        if (/^(Direct|Relay|Ready|Offline)$/.test(t)) {
            pill = t;
            break;
        }
    }
    return {
        t: Date.now(),
        pcs,
        pill,
        status: a.status.slice(),
        bytesReported: a.bytesReported.slice(),
        dcBytes: a.dcBytes
            ? {
                  in: a.dcBytes.in,
                  out: a.dcBytes.out,
                  messages: a.dcBytes.messages,
              }
            : null,
    };
};

/**
 * Pure: the union of candidate types every PC on the page gathered (local)
 * and received (remote) across the samples, each list sorted. Empty lists
 * on a leg that never built a PC, or whose init script predates the census.
 */
export function candidateCensus(samples = []) {
    const local = new Set();
    const remote = new Set();
    for (const s of samples) {
        for (const pc of (s && s.pcs) || []) {
            const c = pc && pc.cand;
            if (!c) continue;
            for (const t of c.local || []) local.add(t);
            for (const t of c.remote || []) remote.add(t);
        }
    }
    return { local: [...local].sort(), remote: [...remote].sort() };
}

/**
 * Pure: bytes that crossed the page's data channels (both directions) as
 * of the latest sample that carries the counter. The refusal cells read
 * this through WebLeg.bytesMoved(): a relay-capped sender refuses before
 * any metadata, so a correct refusal leaves this at 0.
 */
export function bytesMovedFrom(samples = []) {
    for (let i = samples.length - 1; i >= 0; i--) {
        const dc = samples[i] && samples[i].dcBytes;
        if (dc) return (Number(dc.in) || 0) + (Number(dc.out) || 0);
    }
    return 0;
}

/**
 * Pure: the peak candidate-pair byte counters over the samples, for the
 * record only (they include the DTLS and SCTP handshake).
 */
export function pairBytesFrom(samples = []) {
    let sent = 0;
    let received = 0;
    for (const s of samples)
        for (const pc of (s && s.pcs) || []) {
            const p = pc && pc.pair;
            if (!p) continue;
            sent = Math.max(sent, Number(p.bytesSent) || 0);
            received = Math.max(received, Number(p.bytesReceived) || 0);
        }
    return { sent, received };
}

/** Polls SAMPLE until stop(); samples is the growing array (capped). */
export function startSampler(
    page,
    { intervalMs = SAMPLE_INTERVAL_MS, onSample } = {}
) {
    let stopped = false;
    const samples = [];
    const loop = (async () => {
        while (!stopped) {
            const s = await page.evaluate(SAMPLE).catch(() => null);
            if (s && !stopped) {
                if (samples.length >= MAX_SAMPLES) samples.splice(1, 1);
                samples.push(s);
                if (onSample) onSample(s);
            }
            await sleep(intervalMs);
        }
    })();
    return {
        samples,
        stop: async () => {
            stopped = true;
            await loop;
        },
    };
}

/** Enforcement and proof in one: abort the report, count the attempt. */
export async function guardStats(ctx, rec) {
    if (!Array.isArray(rec.attempts)) rec.attempts = [];
    await ctx.route(STATS_ROUTE, (route) => {
        const request = route.request();
        rec.attempts.push({
            t: Date.now(),
            method: request.method(),
            url: request.url(),
        });
        return route.abort('blockedbyclient');
    });
    return rec;
}

/** Seed one localStorage key before any page script (docs-visual-qa.mjs). */
export async function seedLocalStorage(ctx, key, value) {
    await ctx.addInitScript(
        ([k, v]) => {
            try {
                localStorage.setItem(k, v);
            } catch {
                // Storage can be blocked; the route abort still holds.
            }
        },
        [key, value]
    );
}

/** The pill textContent via the exact-text locator, or null. */
export async function readPill(page, timeoutMs = 1000) {
    try {
        const el = page.getByText(TEXT.pill, { exact: true }).first();
        const text = await el.textContent({ timeout: timeoutMs });
        return text ? text.trim() : null;
    } catch {
        return null;
    }
}

/** Pure: the first PC with a nominated pair decides. */
export function classifySample(sample) {
    for (const pc of (sample && sample.pcs) || []) {
        const pair = pc && pc.pair;
        if (!pair || (!pair.local && !pair.remote)) continue;
        const relay = pair.local === 'relay' || pair.remote === 'relay';
        return {
            t: sample.t ?? null,
            source: 'getStats',
            local: pair.local || null,
            remote: pair.remote || null,
            verdict: relay ? 'relay' : 'direct',
        };
    }
    return null;
}

/** Pure: samples, then the last decisive status event, then the pill. */
export function webRoute({ samples = [], events = [], pill = null } = {}) {
    for (const s of samples) {
        const r = classifySample(s);
        if (r) return r;
    }
    const last = [...events]
        .reverse()
        .find((e) => e && (e.detail === 'direct' || e.detail === 'relay'));
    if (last) {
        return {
            t: last.t ?? null,
            source: 'event',
            local: null,
            remote: null,
            verdict: last.detail,
        };
    }
    const p = pill ? String(pill).trim().toLowerCase() : '';
    if (p === 'direct' || p === 'relay') {
        return {
            t: Date.now(),
            source: 'pill',
            local: null,
            remote: null,
            verdict: p,
        };
    }
    return null;
}

/**
 * Pure: on a relay-forced leg every sampled PC must report policy 'relay'.
 * { ok, checked, offenders } with ok null when no PC was sampled yet.
 */
export function checkRelayPolicy(samples, relayOnly) {
    if (!relayOnly) return { ok: true, checked: 0, offenders: [] };
    const pcs = samples.flatMap((s) => (s && s.pcs) || []);
    if (!pcs.length) return { ok: null, checked: 0, offenders: [] };
    const offenders = pcs
        .filter((pc) => pc.policy !== 'relay')
        .map((pc) => pc.policy);
    return { ok: offenders.length === 0, checked: pcs.length, offenders };
}

function statusEvents(samples) {
    const last = samples.at(-1);
    return last ? last.status : [];
}

function bytesReportedEvents(samples) {
    const last = samples.at(-1);
    return last ? last.bytesReported : [];
}

export class WebLeg extends Leg {
    constructor(opts) {
        super(opts);
        this.surface = 'web';
        this.relayOnly = Boolean(opts.relayOnly);
        this.expectFiles =
            opts.expectFiles ?? (opts.files ? opts.files.length : 1);
        this.ctx = null;
        this.page = null;
        this.sampler = null;
        this.samples = [];
        this.statsRec = { attempts: [] };
        this.consoleErrors = [];
        this.pageErrors = [];
        this.screenshots = [];
        this.marks = {};
        this.pillFinal = null;
        this.localStorageRead = null;
        this.staleBundle = null;
        this.harnessError = null;
        this.zipPath = null;
        this._link = null;
        // { t, status } per TURN_FETCH_RE answer: the status only, never
        // the body (the body carries TURN credentials).
        this.turnFetches = [];
    }

    /** Bytes that crossed the page's data channels so far (never throws). */
    bytesMoved() {
        try {
            return bytesMovedFrom(this.samples);
        } catch {
            return 0;
        }
    }

    budget(ms) {
        const { deadlineAt } = this.opts;
        if (!deadlineAt) return ms;
        return Math.max(1000, Math.min(ms, deadlineAt - Date.now()));
    }

    web() {
        const web = (this.opts.infra && this.opts.infra.web) || this.opts.web;
        if (!web) throw new PhaseError('start', 'web: infra.web is required');
        return web.replace(/\/+$/, '');
    }

    async start() {
        const { opts } = this;
        const browser = await getBrowser({
            clientDir: opts.clientDir,
            headless: opts.headless ?? true,
            args: opts.browserArgs,
        });
        this.ctx = await browser.newContext({
            viewport: opts.viewport ?? { width: 1280, height: 900 },
            userAgent: opts.userAgent,
            acceptDownloads: true,
            // floe.one ships a service worker, and context routing does not
            // intercept what a service worker serves: the stats guard and
            // the TURN status oracle both rest on that interception.
            serviceWorkers: 'block',
        });
        await this.ctx.addInitScript(AUDIT_INIT({ relayOnly: this.relayOnly }));
        // The route guard sits on every context: senders never report, but
        // the attestation "browser attempts 0" then covers every page.
        await guardStats(this.ctx, this.statsRec);
        if (this.role === 'receiver')
            await seedLocalStorage(this.ctx, REPORT_STATS_KEY, 'false');
        this.page = await this.ctx.newPage();
        this.page.on('console', (msg) => {
            if (msg.type() === 'error')
                this.consoleErrors.push({ t: Date.now(), text: msg.text() });
        });
        this.page.on('pageerror', (err) => {
            this.pageErrors.push({
                t: Date.now(),
                text: String(err && err.message),
            });
        });
        // One row per request: both events can fire for the same one, and
        // the hint reads the last row, so a 200 must not be overwritten by
        // a late failure event.
        const answered = new WeakSet();
        this.page.on('response', (res) => {
            try {
                if (!TURN_FETCH_RE.test(res.url())) return;
                answered.add(res.request());
                this.turnFetches.push({
                    t: Date.now(),
                    status: res.status(),
                });
            } catch {
                // A response torn down with its context has no url().
            }
        });
        // A fetch that never gets headers (refused, reset, DNS, TLS) is the
        // other way a relay-forced page ends with no candidates; status 0
        // reads as a non-200 answer for the hint.
        this.page.on('requestfailed', (req) => {
            try {
                if (!TURN_FETCH_RE.test(req.url()) || answered.has(req)) return;
                this.turnFetches.push({
                    t: Date.now(),
                    status: 0,
                    failure: String(req.failure()?.errorText || 'failed'),
                });
            } catch {
                // Same teardown race as above.
            }
        });
        const ledger = opts.ledger;
        // P2PTransfer.tsx:471-473 fetches TURN once per page load and opens
        // one Socket.IO connection.
        if (ledger && typeof ledger.spend === 'function') {
            ledger.spend('turn');
            ledger.spend('conn');
        }
        const page = this.page;
        try {
            if (this.role === 'sender') {
                const files = opts.files || [];
                if (!files.length)
                    throw new PhaseError(
                        'start',
                        'web sender: opts.files is empty'
                    );
                await page.goto(`${this.web()}/`, {
                    waitUntil: 'domcontentloaded',
                    timeout: this.budget(GOTO_TIMEOUT_MS),
                });
                // helpers.ts:96-104: the input is opacity:0 over the drop
                // zone and has `multiple` (P2PTransfer.tsx:897-905).
                await page
                    .locator('input[type="file"]')
                    .first()
                    .setInputFiles(files, {
                        timeout: this.budget(GOTO_TIMEOUT_MS),
                    });
                await page
                    .locator('button', { hasText: TEXT.createLink })
                    .click({ timeout: this.budget(LINK_TIMEOUT_MS) });
                const linkEl = page
                    .locator('code')
                    .filter({ hasText: '#room=' });
                await linkEl.waitFor({
                    state: 'visible',
                    timeout: this.budget(LINK_TIMEOUT_MS),
                });
                this._link = ((await linkEl.textContent()) || '').trim();
                this.marks.link = Date.now();
            } else {
                const target = opts.target ?? opts.link;
                if (!target)
                    throw new PhaseError('start', 'web receiver: no link');
                await page.goto(target, {
                    waitUntil: 'domcontentloaded',
                    timeout: this.budget(GOTO_TIMEOUT_MS),
                });
                await page
                    .getByText(TEXT.roomJoined)
                    .first()
                    .waitFor({
                        state: 'visible',
                        timeout: this.budget(JOIN_TIMEOUT_MS),
                    });
                this.marks.joined = Date.now();
                this.localStorageRead = await page
                    .evaluate((k) => {
                        try {
                            return localStorage.getItem(k);
                        } catch {
                            return null;
                        }
                    }, REPORT_STATS_KEY)
                    .catch(() => null);
            }
        } catch (err) {
            if (err instanceof PhaseError) throw err;
            throw new PhaseError('start', `web ${this.role}: ${err.message}`, {
                cause: err,
            });
        }
        this.sampler = startSampler(page, {
            intervalMs: opts.sampleIntervalMs ?? SAMPLE_INTERVAL_MS,
        });
        this.samples = this.sampler.samples;
        return this;
    }

    async link() {
        if (this.role === 'receiver') return this.opts.target ?? this.opts.link;
        return this._link;
    }

    async awaitConnected(timeoutMs) {
        const page = this.page;
        try {
            await page.waitForFunction(
                () => {
                    const a = window.__floeAudit;
                    return Boolean(
                        a &&
                        a.pcs.some((pc) => pc.connectionState === 'connected')
                    );
                },
                null,
                { timeout: this.budget(timeoutMs), polling: 250 }
            );
        } catch (err) {
            throw new PhaseError(
                'connect',
                `web ${this.role}: no PC reached connected in ${timeoutMs} ms (${err.message})`,
                { cause: err }
            );
        }
        this.marks.connected = Date.now();
        const sample = await page.evaluate(SAMPLE).catch(() => null);
        if (sample) this.samples.push(sample);
        const policy = checkRelayPolicy(sample ? [sample] : [], this.relayOnly);
        if (policy.ok === false) {
            this.harnessError = 'init-script-not-applied';
            throw new PhaseError(
                'connect',
                `web ${this.role}: relay forced but PC policies are ${JSON.stringify(policy.offenders)}`,
                {
                    code: 'init-script-not-applied',
                    reason: 'init-script-not-applied',
                    harness: true,
                    policy,
                }
            );
        }
        return sample;
    }

    route() {
        try {
            const last = this.samples.at(-1);
            return webRoute({
                samples: this.samples,
                events: last ? last.status : [],
                pill: last ? last.pill : null,
            });
        } catch {
            return null;
        }
    }

    async awaitDone(timeoutMs) {
        const page = this.page;
        const t0 = Date.now();
        const budget = this.budget(timeoutMs);
        let outcome;
        try {
            if (this.role === 'sender') {
                const handle = await page.waitForFunction(
                    (want) => {
                        const text =
                            (document.body && document.body.innerText) || '';
                        if (
                            text.includes(want.allSent) ||
                            text.includes(want.transferComplete)
                        )
                            return 'sent';
                        if (
                            text.includes(want.relayBlocked) ||
                            text.includes(want.relayBanner)
                        )
                            return 'refusal';
                        if (text.includes(want.connectionFailed))
                            return 'failed';
                        return null;
                    },
                    {
                        allSent: TEXT.allSent,
                        transferComplete: TEXT.transferComplete,
                        relayBlocked: TEXT.relayBlocked,
                        relayBanner: TEXT.relayBanner,
                        connectionFailed: TEXT.connectionFailed,
                    },
                    { timeout: budget, polling: 500 }
                );
                outcome = await handle.jsonValue();
            } else {
                const handle = await page.waitForFunction(
                    (n) => {
                        const text =
                            (document.body && document.body.innerText) || '';
                        const anchors =
                            document.querySelectorAll('a[download]').length;
                        const m = text.match(/(\d+) files? received/);
                        if (anchors >= n && m && Number(m[1]) >= n)
                            return 'received';
                        if (text.includes('Link Invalid')) return 'invalid';
                        return null;
                    },
                    this.expectFiles,
                    { timeout: budget, polling: 500 }
                );
                outcome = await handle.jsonValue();
            }
        } catch (err) {
            throw new PhaseError(
                'done',
                `web ${this.role}: no completion in ${timeoutMs} ms (${err.message})`,
                { cause: err }
            );
        }
        this.marks.done = Date.now();
        const ms = Date.now() - t0;
        if (
            this.role === 'receiver' &&
            bytesReportedEvents(this.samples).length
        ) {
            throw new SafetyError(
                'web receiver: floe:bytes-reported fired despite the localStorage opt-out',
                { events: bytesReportedEvents(this.samples) }
            );
        }
        if (outcome === 'sent' || outcome === 'received')
            return { ok: true, kind: 'transfer', detail: { outcome }, ms };
        if (outcome === 'refusal')
            return {
                ok: true,
                kind: 'refusal',
                detail: { outcome, side: 'self' },
                ms,
            };
        return { ok: false, kind: 'error', detail: { outcome }, ms };
    }

    /** Receiver: every a[download] hashed in-page (helpers.ts:85-93). */
    async outputs() {
        if (this.role !== 'receiver' || !this.page) return [];
        const anchors = await this.page
            .locator('a[download]')
            .evaluateAll((els) =>
                els.map((a) => ({
                    name: a.getAttribute('download'),
                    href: a.href,
                }))
            );
        const out = [];
        for (const a of anchors) {
            const { bytes, sha256 } = await this.page.evaluate(async (url) => {
                const buf = await fetch(url).then((r) => r.arrayBuffer());
                const hash = await crypto.subtle.digest('SHA-256', buf);
                return {
                    bytes: buf.byteLength,
                    sha256: Array.from(new Uint8Array(hash))
                        .map((b) => b.toString(16).padStart(2, '0'))
                        .join(''),
                };
            }, a.href);
            out.push({
                name: a.name,
                rel: a.name,
                bytes,
                sha256,
                href: a.href,
            });
        }
        return out;
    }

    /**
     * Receiver, zip cells: click "Download ZIP" (P2PTransfer.tsx:1059) and
     * save the browser download to destPath. Returns destPath.
     */
    async downloadZip(destPath) {
        if (this.role !== 'receiver' || !this.page)
            throw new PhaseError(
                'verify',
                'web: downloadZip needs a receiver with an open page'
            );
        if (!destPath)
            throw new PhaseError('verify', 'web: downloadZip needs a path');
        mkdirSync(dirname(destPath), { recursive: true });
        const page = this.page;
        // The click and the download event race; wait for both together.
        const [download] = await Promise.all([
            page.waitForEvent('download', {
                timeout: this.budget(HASH_TIMEOUT_MS),
            }),
            page
                .getByRole('button', { name: TEXT.downloadZip })
                .click({ timeout: this.budget(LINK_TIMEOUT_MS) }),
        ]);
        await download.saveAs(destPath);
        this.marks.zip = Date.now();
        this.zipPath = destPath;
        return destPath;
    }

    async stop(reason) {
        await super.stop(reason);
        if (this.sampler) await this.sampler.stop();
        const page = this.page;
        if (page && !page.isClosed()) {
            this.pillFinal = await readPill(page);
            const final = await page.evaluate(SAMPLE).catch(() => null);
            if (final) this.samples.push(final);
            this.staleBundle = await page
                .evaluate((k) => {
                    try {
                        return sessionStorage.getItem(k);
                    } catch {
                        return null;
                    }
                }, STALE_BUNDLE_KEY)
                .catch(() => null);
            if (this.staleBundle) {
                this.notes.push('stale-bundle-reload');
                // The app reloaded itself once: a second TURN fetch and a
                // second Socket.IO connection on the same page.
                const ledger = this.opts.ledger;
                if (ledger && typeof ledger.spend === 'function')
                    ledger.spend('browser:reload');
            }
            if (this.opts.evidenceDir) {
                try {
                    mkdirSync(this.opts.evidenceDir, { recursive: true });
                    const path = join(
                        this.opts.evidenceDir,
                        `${this.role}-final.png`
                    );
                    await page.screenshot({ path });
                    this.screenshots.push(path);
                } catch (err) {
                    this.notes.push(`screenshot failed: ${err.message}`);
                }
            }
        }
        if (this.ctx) {
            await this.ctx.close().catch(() => {});
            this.ctx = null;
        }
    }

    evidence() {
        const events = statusEvents(this.samples);
        const reported = bytesReportedEvents(this.samples);
        const policy = checkRelayPolicy(this.samples, this.relayOnly);
        return {
            surface: 'web',
            role: this.role,
            relayOnly: this.relayOnly,
            link: this._link,
            marks: this.marks,
            samples: this.samples,
            events,
            bytesReportedEvents: reported,
            pillFinal: this.pillFinal,
            policy,
            policyOk: policy.ok,
            harnessError: this.harnessError,
            consoleErrors: this.consoleErrors,
            pageErrors: this.pageErrors,
            screenshots: this.screenshots,
            staleBundle: this.staleBundle,
            zipPath: this.zipPath,
            dcBytes: bytesMovedFrom(this.samples),
            pairBytes: pairBytesFrom(this.samples),
            turnFetches: this.turnFetches.slice(),
            candidates: candidateCensus(this.samples),
            statsAttempts: this.statsRec.attempts.length,
            statsProof:
                this.role === 'receiver'
                    ? {
                          kind: 'route-abort',
                          attempts: this.statsRec.attempts.length,
                          bytesReportedEvents: reported.length,
                          localStorageSeed: 'false',
                          localStorageRead: this.localStorageRead,
                          breach:
                              reported.length > 0 ||
                              this.localStorageRead !== 'false',
                      }
                    : null,
            notes: this.notes,
        };
    }
}

export function createLeg(opts) {
    return new WebLeg(opts);
}

/** { ok, reason, detail: { playwright, chromium, exe } }; launches once. */
export async function preflight(opts = {}) {
    let loaded;
    try {
        loaded = loadPlaywright(opts.clientDir);
    } catch (err) {
        return { ok: false, reason: err.message, detail: { code: err.code } };
    }
    const detail = {
        playwright: loaded.version,
        exe: loaded.exe,
        chromium: null,
    };
    try {
        const browser = await loaded.chromium.launch({ headless: true });
        detail.chromium = browser.version();
        await browser.close();
    } catch (err) {
        return {
            ok: false,
            reason: `chromium did not launch: ${err.message}`,
            detail,
        };
    }
    return { ok: true, reason: null, detail };
}

function makeRandomFile(path, bytes) {
    const data = randomBytes(bytes);
    writeFileSync(path, data);
    return createHash('sha256').update(data).digest('hex');
}

/**
 * Step-0 probe P3: a relay-forced browser sender and a plain browser
 * receiver on opts.web move a 1 MiB fixture. Returns what the audit needs
 * to trust the forcer: the nominated pair types on both sides, the pills,
 * the status events, whether the hashes match and the receiver's stats
 * proof. Never throws for a product outcome; harness errors propagate.
 */
export async function probeRelay(opts) {
    const {
        web,
        clientDir,
        evidenceDir,
        ledger,
        log = null,
        sizeBytes = 1024 * 1024,
        connectTimeoutMs = 60_000,
        routeTimeoutMs = 15_000,
        doneTimeoutMs = 90_000,
    } = opts;
    // The fixture is evidence too and lives under the fenced evidence dir;
    // there is no fallback outside it.
    if (!evidenceDir)
        throw new PhaseError(
            'probe',
            'probeRelay: evidenceDir is required (the fixture and both legs write under it)',
            { harness: true }
        );
    const evidence = evidenceDir;
    const dir = join(evidence, 'fixture');
    mkdirSync(dir, { recursive: true });
    const fixture = join(dir, 'probe.bin');
    const expected = makeRandomFile(fixture, sizeBytes);
    // Two page loads: two TURN fetches and two Socket.IO connections on
    // production, paced like any cell so a probe right after a run cannot
    // push the window over the soft cap.
    if (ledger && typeof ledger.waitFor === 'function')
        await ledger.waitFor({ turn: 2, conn: 2 }, { log });
    const t0 = Date.now();
    const common = {
        cellId: 'P3',
        attempt: 1,
        infra: { web },
        clientDir,
        ledger,
        deadlineAt: t0 + connectTimeoutMs + doneTimeoutMs + 60_000,
        statsOff: true,
    };
    const sender = new WebLeg({
        ...common,
        role: 'sender',
        relayOnly: true,
        files: [fixture],
        evidenceDir: join(evidence, 'probe-sender'),
    });
    let receiver = null;
    const result = {
        ok: false,
        web,
        bytes: sizeBytes,
        sha256: { expected, got: null },
        hashesEqual: false,
        sender: null,
        receiver: null,
        error: null,
        ms: 0,
    };
    try {
        await sender.start();
        const link = await sender.link();
        receiver = new WebLeg({
            ...common,
            role: 'receiver',
            relayOnly: false,
            target: link,
            expectFiles: 1,
            evidenceDir: join(evidence, 'probe-receiver'),
        });
        await receiver.start();
        await Promise.all([
            sender.awaitConnected(connectTimeoutMs),
            receiver.awaitConnected(connectTimeoutMs),
        ]);
        const [sRoute, rRoute] = await Promise.all([
            sender.awaitRoute(routeTimeoutMs),
            receiver.awaitRoute(routeTimeoutMs),
        ]);
        const [sDone, rDone] = await Promise.all([
            sender.awaitDone(doneTimeoutMs),
            receiver.awaitDone(doneTimeoutMs),
        ]);
        const outputs = await receiver.outputs();
        result.sha256.got = outputs[0] ? outputs[0].sha256 : null;
        result.hashesEqual = result.sha256.got === expected;
        result.sender = { route: sRoute, done: sDone };
        result.receiver = { route: rRoute, done: rDone, outputs };
    } catch (err) {
        result.error = {
            name: err.name,
            message: err.message,
            code: err.code ?? null,
        };
        if (err instanceof SafetyError) throw err;
        if (err && err.harness) throw err;
    } finally {
        await sender.stop('probe').catch(() => {});
        if (receiver) await receiver.stop('probe').catch(() => {});
    }
    const sEv = sender.evidence();
    const rEv = receiver ? receiver.evidence() : null;
    result.sender = {
        ...(result.sender || {}),
        pill: sEv.pillFinal,
        events: sEv.events,
        policy: sEv.policy,
        pair: sEv.samples.map(classifySample).find(Boolean) || null,
    };
    result.receiver = rEv
        ? {
              ...(result.receiver || {}),
              pill: rEv.pillFinal,
              events: rEv.events,
              pair: rEv.samples.map(classifySample).find(Boolean) || null,
              statsProof: rEv.statsProof,
          }
        : null;
    result.ok =
        result.hashesEqual &&
        !result.error &&
        Boolean(result.sender.pair) &&
        result.sender.pair.local === 'relay' &&
        result.sender.policy.ok === true &&
        result.receiver.statsProof.attempts === 0 &&
        result.receiver.statsProof.bytesReportedEvents === 0;
    result.ms = Date.now() - t0;
    return result;
}
