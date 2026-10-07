// One request link, end to end, without a browser, an app or a server: the
// host view of tests/fake-request-dom.mjs driven through the real
// PlaywrightDriver and DesktopLeg, visitor pages behind a fake Playwright
// browser (lib/visitor.mjs drives them unchanged), a signaling "server" that
// answers each visitor's Send from the host's state, and a fake blip proxy.
// Everything moves on the host fake's clock, so the 1.2 s Accept wait, a
// 5 s cut and a reclaim cost no real time. On Accept the drop "arrives":
// the visitor's files are copied into an exclusive subfolder of the folder
// the link was made with, so the runner's manifest check reads real files.
//
// Faults (world option `faults`) are the failure shapes the runner must
// name: hash-bad, extra-file, stray-file, part-left, verified-short,
// sha-line-lie, heading-lie (the done view's SHA-256 matched text disagrees
// with the counts: missing with every file verified, shown when one was not),
// stopped, no-prompt, not-used-up, decline-copy,
// blip-no-absent, no-reclaim, visitor-stats, visitor-seed, bytes-reported,
// init-script, make-error, prompt-lie, goto-error, click-error,
// for TA-10a auto-asks (the host prompts on an automatic link anyway),
// auto-unmarked (the result lacks the automatic mark), auto-chip-ready (the
// chip reads READY on an automatic link) and no-auto-switch (a build without
// the Auto-accept switch), and for TA-16's CLI visitor cli-exit (exits 1 on a fixed line after the
// drop), cli-no-arrived (exits 0 without TL-03's line) and cli-stats-env
// (started without FLOE_NO_STATS=1). A wrong route is the world's `route`
// option on a cell that expects the other one.
//
// `lane: 'uia'` (FU-26) makes the host an exe leg instead: the real
// DesktopLeg and UiaDriver over tests/fake-request-uia.mjs, the same view
// read through UIA snapshots. Its launch applies what the leg's desktop.json
// would carry (edit(): the server address and Hide my IP; no Beta switch since
// H7), and `uia` passes
// the fake client's options (activates, idle).
//
// TA-16's visitor is fakeCliVisitor, the CLI adapter's leg in its
// request-visitor mode as lib/request.mjs drives it: start() is the CLI
// joining and printing WAIT, which asks the host exactly as a web Send does,
// and awaitDone() is its exit once the drop has arrived or stopped.
import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { BLIP_HOST, BlipProxy } from '../blip.mjs';
import {
    DesktopLeg,
    PlaywrightDriver,
    UiaDriver,
    activeLegs,
    seedRedirectedConfig,
    statsProofFor,
} from '../desktop.mjs';
import { PhaseError } from '../surfaces.mjs';
import { fakeRequestDom } from './fake-request-dom.mjs';
import { fakeRequestUiaClient } from './fake-request-uia.mjs';

const BLIP_PORT = 45999;
export const BLIP_URL = `http://${BLIP_HOST}:${BLIP_PORT}`;
// TA-14's local Caddy (FU-26), as lib/caddy.mjs would publish it.
export const CADDY_URL = 'http://127.0.0.1:45998';
const SUB = 'Floe request 1';

const TITLES = {
    ready: 'SEND FILES THROUGH THIS LINK',
    waiting: 'Waiting for them to accept',
    sending: 'SENDING 1 OF 1',
    declined: 'They declined. Nothing was sent.',
    timedout: 'They did not answer in time. Nothing was sent.',
    absent: 'Their computer is not connected right now',
    used: 'This link has already been used',
    refused: 'A file changed or was damaged on the way, so their Floe deleted it',
};

const sizeOf = (p) => {
    try {
        return statSync(p).size;
    } catch {
        return 0;
    }
};

/**
 * A visitor page on the fake browser. `world` answers its Send; without a
 * world (visitor.test.mjs) the test scripts `v.state` itself.
 */
export function fakeVisitorContext(world, opts = {}) {
    const v = {
        id: (world?.visitors.length ?? 0) + 1,
        opts,
        inits: [],
        routes: [],
        seeded: new Map(),
        relayOnly: false,
        files: [],
        state: 'loading',
        verified: 0,
        closed: false,
        listeners: {},
        shots: [],
        url: null,
        gotoError: world?.has('goto-error')
            ? (u) => `page.goto: net::ERR_CONNECTION_REFUSED at ${u}`
            : null,
    };
    if (world) world.visitors.push(v);
    const emit = (ev, arg) => (v.listeners[ev] || []).forEach((fn) => fn(arg));
    v.emit = emit;
    v.reportStats = () => {
        for (const r of v.routes)
            r.handler({
                request: () => ({
                    method: () => 'POST',
                    url: () => 'http://localhost:3001/api/stats/report',
                }),
                abort: async () => {},
            });
    };
    const tick = () => world?.tick();
    const titleOf = () => {
        tick();
        if (v.state === 'arrived')
            return v.files.length === 1 ? '1 FILE ARRIVED' : `ALL ${v.files.length} FILES ARRIVED`;
        return TITLES[v.state] ?? null;
    };
    const linesOf = () => {
        tick();
        if (v.state === 'arrived') {
            const n = v.files.length;
            const sha =
                v.verified === n || world?.has('sha-line-lie')
                    ? " Their app reports every file's SHA-256 matched."
                    : '';
            return [`4.0 MB in 1s, ${v.route ?? 'direct'}.${sha}`];
        }
        if (v.state === 'absent')
            return ['They may have closed Floe. Your files stay selected.'];
        return [];
    };
    const buttons = () => {
        tick();
        if (v.state === 'ready' && v.files.length)
            return [v.files.length === 1 ? 'Send 1 file' : `Send ${v.files.length} files`];
        if (v.state === 'absent') return ['Try again'];
        if (v.state === 'declined' || v.state === 'timedout') return ['Back to files'];
        if (v.state === 'waiting') return ['Cancel'];
        return [];
    };
    const connected = () => ['sending', 'arrived'].includes(v.state);
    const pc = () => {
        const route = v.route ?? 'direct';
        const local = v.relayOnly ? 'relay' : route === 'relay' ? 'srflx' : 'host';
        const remote = route === 'relay' && !v.relayOnly ? 'relay' : 'host';
        return {
            connectionState: 'connected',
            iceConnectionState: 'connected',
            __floeCand: { local: [local], remote: [remote] },
            getConfiguration: () => ({
                iceTransportPolicy:
                    v.relayOnly && !world?.has('init-script') ? 'relay' : 'all',
            }),
            async getStats() {
                const m = new Map();
                m.set('p', {
                    type: 'candidate-pair',
                    state: 'succeeded',
                    nominated: true,
                    localCandidateId: 'l',
                    remoteCandidateId: 'r',
                    bytesSent: 1000,
                    bytesReceived: 100,
                });
                m.set('l', { candidateType: local, protocol: 'udp' });
                m.set('r', { candidateType: remote });
                return m;
            },
        };
    };
    const node = (textContent) => ({ textContent, contains: () => false });
    const page = {
        v,
        on(ev, fn) {
            (v.listeners[ev] ||= []).push(fn);
        },
        async goto(url) {
            v.url = url;
            if (v.gotoError) throw new Error(v.gotoError(url));
            v.state = 'ready';
        },
        locator(sel) {
            if (!/input\[type="file"\]/.test(sel))
                throw new Error(`fake visitor: locator ${sel} not modeled`);
            return {
                first: () => ({
                    async setInputFiles(paths) {
                        v.files = [...paths];
                    },
                }),
            };
        },
        getByRole(role, { name }) {
            if (role !== 'button')
                throw new Error(`fake visitor: role ${role} not modeled`);
            const self = {
                first: () => self,
                async isVisible() {
                    return buttons().includes(name);
                },
                async click() {
                    if (!buttons().includes(name))
                        throw new Error(`fake visitor: no visible button "${name}"`);
                    // Playwright's call log names the page's URL, fragment
                    // and all, in a click that times out.
                    if (world?.has('click-error') && /^Send /.test(name))
                        throw new Error(
                            `locator.click: Timeout 30000ms exceeded.\nCall log:\n  - navigated to "${v.url}"`
                        );
                    if (/^Send \d+ files?$/.test(name) || name === 'Try again') {
                        if (world) world.visitorSend(v);
                        else v.state = 'waiting';
                    } else if (name === 'Back to files') v.state = 'ready';
                },
            };
            return self;
        },
        async evaluate(fn, arg) {
            const saved = {
                window: globalThis.window,
                document: globalThis.document,
                localStorage: globalThis.localStorage,
                hadWindow: 'window' in globalThis,
                hadDocument: 'document' in globalThis,
                hadStorage: 'localStorage' in globalThis,
            };
            globalThis.window = {
                __floeAudit: {
                    pcs: connected() ? [pc()] : [],
                    status: [],
                    bytesReported: world?.has('bytes-reported') ? [{ t: 1, bytes: 1 }] : [],
                    dcBytes: { in: 0, out: 0, messages: 0, binIn: 0, binOut: 0 },
                },
            };
            globalThis.document = {
                querySelectorAll: (sel) => {
                    if (sel === 'h1') {
                        const t = titleOf();
                        return t ? [node(t)] : [];
                    }
                    if (sel === 'section p') return linesOf().map(node);
                    if (sel === 'button') return buttons().map(node);
                    return [];
                },
            };
            globalThis.localStorage = {
                getItem: (k) => (v.seeded.has(k) ? v.seeded.get(k) : null),
            };
            try {
                return await fn(arg);
            } finally {
                for (const [k, had] of [
                    ['window', saved.hadWindow],
                    ['document', saved.hadDocument],
                    ['localStorage', saved.hadStorage],
                ]) {
                    if (had) globalThis[k] = saved[k];
                    else delete globalThis[k];
                }
            }
        },
        async screenshot({ path: file } = {}) {
            v.shots.push(file);
        },
        isClosed() {
            return v.closed;
        },
    };
    const ctx = {
        v,
        async addInitScript(script, arg) {
            v.inits.push([script, arg]);
            if (Array.isArray(arg) && arg[0] === 'floe:report-stats')
                v.seeded.set(arg[0], world?.has('visitor-seed') ? 'true' : arg[1]);
            if (
                typeof script === 'string' &&
                script.includes("cfg.iceTransportPolicy = 'relay'")
            )
                v.relayOnly = true;
        },
        async route(pattern, handler) {
            v.routes.push({ pattern, handler });
        },
        async newPage() {
            return page;
        },
        async close() {
            v.closed = true;
        },
    };
    v.page = page;
    v.ctx = ctx;
    return ctx;
}

/**
 * TA-16's CLI visitor on the world: the shape lib/cli.mjs's CliLeg has in its
 * request-visitor mode (start, awaitDone, route, evidence, stop), with the
 * lines sendto.go prints. The link it was handed is in its argv, as the real
 * leg's is, so the runner's redaction is what keeps it out of the record.
 */
export function fakeCliVisitor(world, opts) {
    const v = {
        id: world.cliVisitors.length + 1,
        cli: true,
        opts,
        files: [...(opts.files || [])],
        state: 'loading',
        verified: 0,
        route: null,
        emit: () => {},
        exited: null,
        stopped: null,
    };
    world.cliVisitors.push(v);
    const env = world.has('cli-stats-env')
        ? { FLOE_NO_UPDATE_CHECK: '1' }
        : { FLOE_NO_STATS: '1', FLOE_NO_UPDATE_CHECK: '1' };
    const argv = ['floe', 'send', ...v.files, '--to', opts.requestLink, '--server', opts.infra?.server];
    const lines = () => {
        const n = v.files.length;
        const out = ['', `  Sending   ${v.files.join(', ')} (${n === 1 ? '1 file' : `${n} files`}, 4 KB)`, '  Joining the request link...'];
        if (v.state === 'loading') return out;
        out.push('  Connecting...', `  Connected (${world.route})`, '  Waiting for them to accept. They have 9 min to answer.', '  Nothing is saved until they accept.');
        if (v.state === 'arrived' && !world.has('cli-no-arrived') && !world.has('cli-exit')) {
            out.push('', n === 1 ? `  1 file arrived (4 KB in 0s, ${world.route}).` : `  All ${n} files arrived (4 KB in 0s, ${world.route}).`);
            if (v.verified === n || world.has('sha-line-lie'))
                out.push("  Their app reports every file's SHA-256 matched.");
        }
        return out;
    };
    const outcome = () => {
        if (v.state === 'refused')
            return 'A file changed or was damaged on the way, so their Floe deleted it.';
        if (v.state === 'arrived' && world.has('cli-exit'))
            return 'Connection lost. 0 of 1 file arrived. Ask them for a new link to send it.';
        return null;
    };
    const parsed = () => {
        const out = lines();
        const a = out.map((l) => l.match(/^ {2}(?:All (\d+) files|(1) file) arrived \((.+)\)\.$/)).find(Boolean);
        return {
            arrived: a ? { files: Number(a[1] ?? a[2]), detail: a[3], line: a[0].trim() } : null,
            shaLine: out.includes("  Their app reports every file's SHA-256 matched."),
            connected: v.state === 'loading' ? null : world.route,
            outcome: outcome(),
        };
    };
    return {
        surface: 'cli',
        role: 'sender',
        label: opts.label,
        opts,
        v,
        pid: null,
        async start() {
            world.tick();
            v.state = 'ready';
            world.visitorSend(v);
            if (v.state !== 'waiting')
                throw new Error(`fake CLI visitor: the host answered ${v.state}, not a seat`);
            return this;
        },
        async code() {
            return null;
        },
        async link() {
            return null;
        },
        async awaitDone(timeoutMs) {
            const start = world.clock.now();
            for (;;) {
                world.tick();
                if (v.state === 'arrived' || v.state === 'refused') break;
                if (world.clock.now() - start >= timeoutMs)
                    return { ok: false, kind: 'error', exitCode: null, detail: { ...parsed(), error: null } };
                await world.clock.nap(100);
            }
            const r = parsed();
            // cli-no-arrived exits 0 without TL-03's line; a refusal or
            // cli-exit ends on 1 and its fixed line.
            const code = v.state === 'refused' || world.has('cli-exit') ? 1 : 0;
            v.exited = code;
            return { ok: code === 0 && Boolean(r.arrived), kind: code === 0 ? 'transfer' : 'error', exitCode: code, detail: { ...r, error: null } };
        },
        route() {
            return v.state === 'loading'
                ? null
                : { t: world.clock.now(), source: 'cli-connected', local: null, remote: null, verdict: world.route };
        },
        evidence() {
            return {
                surface: 'cli',
                role: 'sender',
                argv,
                env,
                exit: v.exited === null ? null : { code: v.exited },
                statsProof: { kind: 'sender-env', floeNoStats: env.FLOE_NO_STATS ?? null },
                request: parsed(),
                notes: [],
            };
        },
        async stop(reason) {
            v.stopped = reason;
        },
    };
}

/**
 * The world. `route` is the path the drop takes ('direct' or 'relay');
 * `transferMs` is how long an accepted drop moves on the fake clock.
 */
export function fakeRequestWorld({
    route = 'direct',
    faults = [],
    transferMs = 400,
    reclaimMs = 1500,
    host = {},
    lane = 'wailsdev',
    uia = {},
} = {}) {
    const set = new Set(faults);
    const h = fakeRequestDom({
        makeError: set.has('make-error') ? 'disabled' : null,
        autoSwitch: !set.has('no-auto-switch'),
        autoAsks: set.has('auto-asks'),
        autoChip: !set.has('auto-chip-ready'),
        ...host,
    });
    const dom = h.dom;
    const world = {
        host: h,
        dom,
        clock: { now: h.now, nap: h.nap },
        faults: set,
        route,
        visitors: [],
        cliVisitors: [],
        current: null,
        acceptedAt: null,
        autoAccepted: false,
        linkUsed: false,
        blips: [],
        sends: [],
        has: (f) => set.has(f),
        tick: () => h.tick(),
    };
    const turnAnswer = (v) =>
        v.emit('response', {
            url: () => 'http://localhost:3001/api/turn-credentials',
            status: () => 200,
        });
    world.visitorSend = (v) => {
        world.sends.push({ id: v.id, t: h.now() });
        turnAnswer(v);
        if (world.has('visitor-stats')) v.reportStats();
        if (world.linkUsed) {
            v.state = world.has('not-used-up') ? 'waiting' : 'used';
            return;
        }
        const st = h.snapshot().state;
        if (st === 'reconnecting') {
            v.state = world.has('blip-no-absent') ? 'waiting' : 'absent';
            return;
        }
        if (st !== 'waiting') {
            v.state = 'used';
            return;
        }
        v.state = 'waiting';
        world.current = v;
        if (world.has('no-prompt')) return;
        const totalBytes = v.files.reduce((a, p) => a + sizeOf(p), 0);
        h.requestAt(h.now(), {
            files: v.files.length + (world.has('prompt-lie') ? 1 : 0),
            totalBytes,
            warnings: [],
        });
    };
    dom.onAnswer = (answer) => {
        const v = world.current;
        if (!v) return;
        if (answer === 'accept' || answer === 'auto-accept') {
            world.autoAccepted = answer === 'auto-accept';
            v.state = 'sending';
            v.route = world.route;
            dom.route = world.route;
            world.acceptedAt = h.now();
        } else if (answer === 'decline') {
            v.state = world.has('decline-copy') ? 'timedout' : 'declined';
            world.current = null;
        }
    };
    dom.onTick = (t) => {
        if (
            world.acceptedAt === null ||
            dom.state !== 'receiving' ||
            t < world.acceptedAt + transferMs
        )
            return;
        world.acceptedAt = null;
        const v = world.current;
        const base = dom.linkSaveDir;
        const sub = path.join(base, SUB);
        mkdirSync(sub, { recursive: true });
        let bytes = 0;
        v.files.forEach((p, i) => {
            const dst = path.join(sub, path.basename(p));
            if (i === 0 && world.has('hash-bad')) writeFileSync(dst, 'not the bytes that were sent');
            else copyFileSync(p, dst);
            bytes += sizeOf(dst);
        });
        if (world.has('extra-file')) writeFileSync(path.join(sub, 'extra.bin'), 'x');
        if (world.has('stray-file')) writeFileSync(path.join(base, 'stray.bin'), 'x');
        if (world.has('part-left')) writeFileSync(path.join(sub, 'left.bin.part'), 'x');
        const n = v.files.length;
        world.linkUsed = true;
        if (world.has('stopped')) {
            dom.state = 'stopped';
            dom.code = 'hash-mismatch';
            dom.result = { files: n, saved: n - 1, bytes, verified: n - 1, renamed: 0, folder: sub, names: [], autoAccepted: world.autoAccepted };
            v.state = 'refused';
            return;
        }
        const verified = world.has('verified-short') ? n - 1 : n;
        dom.state = 'done';
        dom.result = {
            files: n,
            saved: n,
            bytes,
            verified,
            renamed: 0,
            folder: sub,
            names: v.files.map((p) => path.basename(p)),
            autoAccepted: world.autoAccepted && !world.has('auto-unmarked'),
        };
        if (world.has('heading-lie')) dom.forceVerifiedLine = verified !== n;
        v.verified = verified;
        v.state = 'arrived';
    };
    world.browser = {
        async newContext(opts) {
            return fakeVisitorContext(world, opts);
        },
    };
    // The real BlipProxy, so the runner reads exactly the fields the real
    // proxy has: the first live TA-13 run (2026-09-24) died on a `url` the
    // old hand-written fake had and the real proxy did not. Nothing listens:
    // start() is never called, the port is the one it would have bound, and
    // only the socket side (live, cut, stop) is scripted on the fake clock.
    world.startBlip = async ({ upstream }) => {
        const b = new BlipProxy({ upstream, now: h.now });
        b.port = BLIP_PORT;
        b.upstream = upstream;
        b.cuts = [];
        b.stopped = false;
        // One proxied socket: the host's /ws, once its link was made
        // through this proxy's own URL.
        const hostSockets = () =>
            b.url && dom.madeWith?.server === b.url && !b.stopped ? 1 : 0;
        Object.defineProperty(b, 'live', { get: hostSockets });
        b.cut = async (ms, { wait = h.nap } = {}) => {
            const from = h.now();
            const destroyed = hostSockets();
            b.cuts.push({ from, ms });
            // Only a host whose link was made through the proxy loses
            // its socket.
            if (destroyed)
                dom.blip = {
                    from,
                    until: from + ms,
                    reclaimMs: world.has('no-reclaim') ? Infinity : reclaimMs,
                };
            await wait(ms);
            return { cutAt: from, resumedAt: h.now(), destroyed };
        };
        b.stop = async () => {
            b.stopped = true;
        };
        world.blips.push(b);
        return b;
    };
    // The exe host (lane 'uia'): a fresh app per launch, opening on Receive >
    // CODE, with what its desktop.json carried applied to the fake's
    // settings; no process, no window, no helper.
    world.launchEdits = [];
    const uiaLeg = (opts) => {
        const leg = new DesktopLeg({ ...opts, lister: async () => [] });
        leg.launch = async () => {
            activeLegs.add(leg);
            dom.closed = false;
            dom.settingsOpen = false;
            dom.mode = 'receive';
            dom.requestView = false;
            const e = leg.edit();
            world.launchEdits.push(e);
            if (e.server) dom.settings.server = e.server;
            if (e.web !== undefined) dom.settings.web = e.web;
            dom.settings.hideIP = Boolean(e.hideIP);
            world.uiaClient = fakeRequestUiaClient(h, uia);
            // The redirected desktop.json a real launch seeds, so the host's
            // stats proof reads the file it launched with.
            const appData = path.join(leg.evidenceDir, 'appdata');
            const configPath = seedRedirectedConfig(appData, e);
            leg.launchProof = statsProofFor(configPath);
            leg.plan = { mode: leg.mode, configPath, appData };
            leg.hwnd = 4242;
            leg.driver = new UiaDriver(world.uiaClient, 4242, {});
            return leg.driver;
        };
        return leg;
    };
    // TA-14 (FU-26): a stand-in for lib/caddy.mjs startCaddy. A reload
    // closes every WebSocket behind the proxy: a host whose link was made
    // through it and waits goes Reconnecting and reclaims, as a blip does;
    // a drop that receives carries on over its data channel. Faults:
    // docker-absent (the SKIP startCaddy throws), no-reclaim.
    world.caddies = [];
    world.startCaddy = async ({ upstream, runDir }) => {
        if (set.has('docker-absent'))
            throw new PhaseError('caddy', 'docker-absent: fake Docker is not answering', {
                verdict: 'SKIP',
                reason: 'docker-absent',
            });
        const c = { url: CADDY_URL, upstream, runDir, reloads: [], stopped: false };
        const hostBehind = () => !c.stopped && dom.madeWith?.server === c.url;
        c.reload = async () => {
            const at = h.now();
            c.reloads.push({ at, state: dom.state, hostBehind: hostBehind() });
            if (hostBehind() && dom.state === 'waiting')
                dom.blip = {
                    from: at,
                    until: at,
                    reclaimMs: set.has('no-reclaim') ? Infinity : reclaimMs,
                };
            return { at };
        };
        c.stop = async () => {
            c.stopped = true;
        };
        world.caddies.push(c);
        return c;
    };
    world.adapters = {
        desktop: {
            createLeg: (opts) =>
                lane === 'uia'
                    ? uiaLeg(opts)
                    : new DesktopLeg({
                          ...opts,
                          // PlaywrightDriver.open makes a fresh page per launch,
                          // so a retry's host finds the view as a new page does.
                          openDriver: async () => {
                              dom.closed = false;
                              dom.settingsOpen = false;
                              dom.mode = 'receive';
                              dom.requestView = false;
                              return new PlaywrightDriver(h.page, h.context, {});
                          },
                          lister: async () => [],
                      }),
        },
        web: { getBrowser: async () => world.browser },
        // TA-16: only a request-link visitor comes from the world; every
        // other CLI leg stays the plain fake's.
        cli: { createLeg: (opts) => fakeCliVisitor(world, opts) },
    };
    return world;
}
