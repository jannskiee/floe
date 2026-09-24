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
// sha-line-lie, heading-lie, stopped, no-prompt, not-used-up, decline-copy,
// blip-no-absent, no-reclaim, visitor-stats, visitor-seed, bytes-reported,
// init-script, beta-stuck, make-error, prompt-lie, goto-error, click-error.
// A wrong route is the world's `route` option on a cell that expects the
// other one.
import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { BLIP_HOST, BlipProxy } from '../blip.mjs';
import { DesktopLeg, PlaywrightDriver } from '../desktop.mjs';
import { fakeRequestDom } from './fake-request-dom.mjs';

const BLIP_PORT = 45999;
export const BLIP_URL = `http://${BLIP_HOST}:${BLIP_PORT}`;
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
            return ['The person who made this link may have closed Floe. Your files stay selected.'];
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
 * The world. `route` is the path the drop takes ('direct' or 'relay');
 * `transferMs` is how long an accepted drop moves on the fake clock.
 */
export function fakeRequestWorld({
    route = 'direct',
    faults = [],
    transferMs = 400,
    reclaimMs = 1500,
    host = {},
} = {}) {
    const set = new Set(faults);
    const h = fakeRequestDom({
        betaStuck: set.has('beta-stuck'),
        makeError: set.has('make-error') ? 'disabled' : null,
        settings: { requestLinks: false },
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
        current: null,
        acceptedAt: null,
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
        if (answer === 'accept') {
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
            dom.result = { files: n, saved: n - 1, bytes, verified: n - 1, renamed: 0, folder: sub, names: [] };
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
    world.adapters = {
        desktop: {
            createLeg: (opts) =>
                new DesktopLeg({
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
    };
    return world;
}
