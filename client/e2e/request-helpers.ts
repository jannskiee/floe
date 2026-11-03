/**
 * Helpers for the request-link spec (S1-ENG-09's client half, S1-WEB-05).
 *
 * The Go host harness (cli/internal/e2ehost, built by global-setup.ts) runs in
 * request mode: it makes a fresh host token, joins the reserved room the token
 * derives, prints the link, and plays the host for each visit with a scripted
 * Decide. It prints JSON lines only, never the token, and always runs with an
 * empty stats URL.
 *
 * Privacy helpers: every request-link test counts stats attempts (they must be
 * 0), serves a STUN-only ICE list unless it is the local relay cell, and can
 * record the page's Socket.IO packets on both transports to count
 * `request-join` and read the ICE candidate types the page sent. None of them
 * reads, logs or attaches a TURN response.
 */

import type { BrowserContext, Page, PlaywrightWorkerOptions, WebSocketRoute } from '@playwright/test';
import { createHash, randomBytes } from 'crypto';
import { closeSync, openSync, readdirSync, readSync, statSync } from 'fs';
import { connect, createServer, type AddressInfo } from 'net';
import { join, relative, sep } from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { E2E_HOST_BINARY } from './cli-binary';
import { describeHarness } from './harness-redact';
import { SERVER_URL, WEB_URL } from './helpers';

export interface RequestHostEvent {
    event: string;
    /** Date.now() when this side read the line; set here, never by the
     *  harness. Two events' gap is the harness's own gap, since both lines
     *  cross the same pipe. */
    receivedAt?: number;
    [field: string]: unknown;
}

export interface RequestHostOptions {
    /** Where the harness writes received files (its -out). */
    outDir: string;
    /** -decide: comma list, one step per visit, the last repeating. */
    decide?: string;
    /** -fast-timers: the decide window answers expired after 5 s. */
    fastTimers?: boolean;
    /** -keep-waiting: request-reopen after a refused visit. */
    keepWaiting?: boolean;
    /** -corrupt-hash: flip a digit of each end-frame digest. */
    corruptHash?: boolean;
    /** -blip-after: drop and reclaim the host socket after this event. */
    blipAfter?: string;
    /** -timeout, a Go duration (default 2m in the harness). */
    timeout?: string;
    /** -join-after: print the link, then claim the room this many ms later. */
    joinAfter?: number;
    /** -join-on-stdin: print the link, then claim the room on `join()`. */
    joinOnStdin?: boolean;
    /** -hold-after-file: hold the receive loop this many ms after the first
     *  committed file, between the `holding` and `released` events. */
    holdAfterFile?: number;
    /** -max-files: turns the receiver's request limits on with this file cap. */
    maxFiles?: number;
    /** -stop-after-file: after the first committed file, stop the drop with
     *  this refusal code (saved 1), as a receiver that refused it would. The
     *  harness refuses an unknown code at start. Excludes holdAfterFile. */
    stopAfterFile?: string;
    /** -stop-reason: the reason that stop's frame carries; the harness never
     *  prints it. Only with stopAfterFile. */
    stopReason?: string;
    /** -close-before-visit: the host closes its link right after joining,
     *  with nobody seated (Close link while it waits), and exits 0. */
    closeBeforeVisit?: boolean;
    /** -key: the link is #<room>.<key>, and the engine checks the visitor with that key. */
    key?: boolean;
    /** -kc, with key: bad runs the engine under another key, none with no key at all. */
    kc?: 'bad' | 'none';
}

export interface RequestHost {
    proc: ChildProcess;
    events: RequestHostEvent[];
    outDir: string;
    exited: Promise<number | null>;
    /** Every event so far and a bounded stderr tail, for failure messages,
     *  with the link and the room id redacted (describeHarness). */
    describe(): string;
    /** Release a -join-on-stdin host into its room. */
    join(): void;
    stop(): void;
}

/**
 * A door to the signaling server that names a network of its own.
 *
 * The server allows 20 new links per network address per 24 hours (REQUEST_CREATES_PER_DAY,
 * a constant on purpose, with no switch), and this suite makes more than that from one
 * machine in one run. So each host comes through a door like this, which does what the
 * proxy in front of the production server does: it says who connected, in an
 * X-Forwarded-For the server reads as the rate key (playwright.config.ts pins
 * TRUSTED_PROXY_COUNT to 1 for this). Only the first request on a connection carries it,
 * and a WebSocket is one request. Listening with no host binds in this tick (with one, it
 * waits on a lookup), so the port can be read at once and the callers stay synchronous;
 * the signaling server it leads to listens on every address the same way.
 */
export function signalingDoor(): { url: string; close(): void } {
    const [a, b, c] = randomBytes(3);
    const address = `10.${a}.${b}.${c}`;
    const server = createServer((client) => {
        const upstream = connect(Number(new URL(SERVER_URL).port), '127.0.0.1');
        client.on('error', () => upstream.destroy());
        upstream.on('error', () => client.destroy());
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
        client.once('data', (first: Buffer) => {
            const line = first.indexOf('\r\n') + 2;
            upstream.write(first.subarray(0, line));
            upstream.write(`X-Forwarded-For: ${address}\r\n`);
            upstream.write(first.subarray(line));
            client.pipe(upstream);
            upstream.pipe(client);
        });
    });
    server.listen(0);
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/** The three parts of a keyed or bare request link, for a test that needs them apart. */
export function partsOfRequestLink(link: string): { linkId: string; room: string; key: string | null } {
    const url = new URL(link);
    const [room, key] = url.hash.slice(1).split('.');
    return { linkId: url.pathname.split('/').pop() ?? '', room, key: key ?? null };
}

/** Start the harness in request mode. Every stdout line must parse as JSON. */
export function startRequestHost(opts: RequestHostOptions): RequestHost {
    const door = signalingDoor();
    const args = ['request', '-server', door.url, '-web', WEB_URL, '-out', opts.outDir];
    if (opts.key) args.push('-key');
    if (opts.kc) args.push(`-kc=${opts.kc}`);
    if (opts.decide) args.push('-decide', opts.decide);
    if (opts.fastTimers) args.push('-fast-timers');
    if (opts.keepWaiting) args.push('-keep-waiting');
    if (opts.corruptHash) args.push('-corrupt-hash');
    if (opts.blipAfter) args.push('-blip-after', opts.blipAfter);
    if (opts.timeout) args.push('-timeout', opts.timeout);
    if (opts.joinAfter !== undefined) args.push('-join-after', String(opts.joinAfter));
    if (opts.holdAfterFile !== undefined) args.push('-hold-after-file', String(opts.holdAfterFile));
    if (opts.joinOnStdin) args.push('-join-on-stdin');
    if (opts.maxFiles !== undefined) args.push('-max-files', String(opts.maxFiles));
    if (opts.stopAfterFile !== undefined) args.push('-stop-after-file', opts.stopAfterFile);
    if (opts.stopReason !== undefined) args.push('-stop-reason', opts.stopReason);
    if (opts.closeBeforeVisit) args.push('-close-before-visit');
    const proc = spawn(E2E_HOST_BINARY, args, { stdio: [opts.joinOnStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const events: RequestHostEvent[] = [];
    const host = { proc, events, outDir: opts.outDir } as RequestHost & { waiters: Array<() => void>; closed: boolean };
    host.waiters = [];
    host.closed = false;
    let stderrTail = '';
    let stderrCut = false;
    proc.stderr?.on('data', (chunk: Buffer) => {
        const all = stderrTail + chunk.toString();
        stderrCut ||= all.length > 2000;
        stderrTail = all.slice(-2000);
    });
    let buffered = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
        buffered += chunk.toString();
        let nl: number;
        while ((nl = buffered.indexOf('\n')) >= 0) {
            const line = buffered.slice(0, nl).trim();
            buffered = buffered.slice(nl + 1);
            if (!line) continue;
            let parsed: RequestHostEvent;
            try {
                parsed = JSON.parse(line) as RequestHostEvent;
            } catch {
                parsed = { event: 'unparsed-line' };
            }
            if (typeof parsed !== 'object' || parsed === null) parsed = { event: 'unparsed-line' };
            parsed.receivedAt = Date.now();
            events.push(parsed);
            host.waiters.splice(0).forEach((w) => w());
        }
    });
    host.exited = new Promise<number | null>((resolve) => {
        const done = (code: number | null) => {
            door.close();
            host.closed = true;
            host.waiters.splice(0).forEach((w) => w());
            resolve(code);
        };
        proc.on('close', (code) => done(code));
        proc.on('error', () => done(-1));
    });
    host.describe = () => describeHarness(events, stderrTail, stderrCut);
    host.join = () => {
        if (!proc.stdin) throw new Error('join() needs a host started with joinOnStdin');
        proc.stdin.write('\n');
    };
    host.stop = () => {
        if (!host.closed) proc.kill();
    };
    return host;
}

/**
 * Wait for the harness's `nth` event named `name` (1-based). An `error` event
 * or the harness exiting first fails the wait with everything it printed.
 */
export function waitForHostEvent(
    host: RequestHost,
    name: string,
    timeoutMs = 60_000,
    nth = 1
): Promise<RequestHostEvent> {
    const h = host as RequestHost & { waiters: Array<() => void>; closed: boolean };
    return new Promise<RequestHostEvent>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`harness did not emit "${name}" #${nth} within ${timeoutMs} ms: ${host.describe()}`)),
            timeoutMs
        );
        const check = () => {
            const hits = host.events.filter((e) => e.event === name);
            if (hits.length >= nth) {
                clearTimeout(timer);
                resolve(hits[nth - 1]);
                return;
            }
            if (host.events.some((e) => e.event === 'error') || h.closed) {
                clearTimeout(timer);
                reject(new Error(`harness ended before "${name}" #${nth}: ${host.describe()}`));
                return;
            }
            h.waiters.push(check);
        };
        check();
    });
}

/** The link the harness printed: `<web>/r/<linkId>#<roomId>`. */
export async function requestLink(host: RequestHost): Promise<string> {
    const e = await waitForHostEvent(host, 'link', 30_000);
    if (typeof e.link !== 'string') throw new Error(`link event without a link: ${host.describe()}`);
    return e.link;
}

/**
 * SHA-256 of one file, read in 4 MiB slices. readFileSync refuses any file
 * over 2 GiB with ERR_FS_FILE_TOO_LARGE, which S1-WEB-06's 4 GiB + 1 B cell
 * (M-08) would hit.
 */
function sha256File(path: string): string {
    const hash = createHash('sha256');
    const slab = Buffer.allocUnsafe(4 * 1024 * 1024);
    const fd = openSync(path, 'r');
    try {
        let n: number;
        while ((n = readSync(fd, slab, 0, slab.length, null)) > 0) hash.update(slab.subarray(0, n));
    } finally {
        closeSync(fd);
    }
    return hash.digest('hex');
}

/** Every file under `dir`, as forward-slash relative path to SHA-256. */
export function sha256Manifest(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
        for (const name of readdirSync(d)) {
            const full = join(d, name);
            if (statSync(full).isDirectory()) walk(full);
            else out[relative(dir, full).split(sep).join('/')] = sha256File(full);
        }
    };
    walk(dir);
    return out;
}

/** Every directory under `dir`, relative, forward slashes. */
export function directoriesUnder(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
        for (const name of readdirSync(d)) {
            const full = join(d, name);
            if (statSync(full).isDirectory()) {
                out.push(relative(dir, full).split(sep).join('/'));
                walk(full);
            }
        }
    };
    walk(dir);
    return out;
}

/**
 * The received files match the sent ones: every sent relative path arrived
 * (inside the drop subfolder the host creates) with the same SHA-256, and
 * nothing else arrived. Returns a message for the first mismatch, or null.
 */
export function deliveredMismatch(outDir: string, sent: Record<string, string>): string | null {
    const got = sha256Manifest(outDir);
    const keys = Object.keys(got);
    for (const [rel, sha] of Object.entries(sent)) {
        const hit = keys.find((k) => k === rel || k.endsWith('/' + rel));
        if (!hit) return `missing ${rel}; received ${JSON.stringify(keys)}`;
        if (got[hit] !== sha) return `hash differs for ${rel}`;
    }
    if (keys.length !== Object.keys(sent).length) return `received ${keys.length} files, sent ${Object.keys(sent).length}`;
    if (keys.some((k) => k.endsWith('.part'))) return 'a .part file is left';
    return null;
}

/**
 * Count stats attempts for the whole context: every request to a stats route,
 * GET or POST, from any page (report POSTs are also aborted, so nothing leaves
 * the machine), and every page-side `floe:bytes-reported` event. Both counts
 * live on this side, so they survive a navigation and a closed page (review
 * 1, F6). Returns a reader for the total.
 */
export async function countStatsAttempts(context: BrowserContext): Promise<() => Promise<number>> {
    let requests = 0;
    let events = 0;
    context.on('request', (r) => {
        if (/\/api\/stats(\/|\?|$)/.test(r.url())) requests++;
    });
    await context.route('**/api/stats/report', (route) => route.abort());
    await context.exposeBinding('__floeStatsEvent', () => {
        events++;
    });
    await context.addInitScript(() => {
        window.addEventListener('floe:bytes-reported', () => {
            void (window as unknown as { __floeStatsEvent: () => Promise<void> }).__floeStatsEvent();
        });
    });
    return async () => requests + events;
}

/**
 * Whether Playwright records a trace for this attempt under this trace option.
 * Unknown and future modes count as recording.
 */
export function traceRecords(trace: PlaywrightWorkerOptions['trace'], retry: number): boolean {
    const mode = typeof trace === 'string' ? trace : trace.mode;
    switch (mode) {
        case 'off':
            return false;
        case 'on-first-retry':
            return retry === 1;
        case 'on-all-retries':
            return retry > 0;
        case 'retain-on-first-failure':
            return retry === 0;
        default:
            return true;
    }
}

/**
 * Serve a STUN-only ICE list to every page in the context, so a local server
 * that holds coturn credentials never hands them to these cells and every one
 * stays direct, as on the egress-only CI runners. The real response is never
 * fetched, read or logged.
 */
export async function stunOnlyIce(context: BrowserContext): Promise<void> {
    await context.route('**/api/turn-credentials', (route) =>
        route.fulfill({ json: [{ urls: 'stun:stun.l.google.com:19302' }] })
    );
}

export interface SocketFrames {
    /** Every Socket.IO packet the page sent to the signaling server, over
     *  either transport: WebSocket text frames and each packet of a polling
     *  POST body. */
    outgoing: string[];
    /** How many socket.io WebSockets the page has opened so far. */
    socketsOpened(): number;
    /** Close the page's side of every forwarded socket (a signaling blip). */
    closePageSockets(): Promise<void>;
}

/**
 * Record every Socket.IO packet the page sends, over both transports, and
 * forward its WebSocket frames both ways. Install before the first navigation.
 *
 * Both transports, because Socket.IO starts on HTTP long-polling and upgrades
 * later, and the visitor emits request-join on its first connect, before the
 * upgrade: the first local run's trace showed it in a polling POST while the
 * WebSocket probe was still going (WP-W2 review 1, F2). Engine.io v4 joins the
 * packets of one polling body with U+001E.
 */
export async function forwardSocketFrames(page: Page): Promise<SocketFrames> {
    const outgoing: string[] = [];
    const routes: WebSocketRoute[] = [];
    page.on('request', (r) => {
        if (r.method() === 'POST' && /\/socket\.io\/\?.*transport=polling/.test(r.url())) {
            outgoing.push(...(r.postData() ?? '').split('\x1e'));
        }
    });
    await page.routeWebSocket(/socket\.io/, (ws) => {
        routes.push(ws);
        const server = ws.connectToServer();
        ws.onMessage((message) => {
            if (typeof message === 'string') outgoing.push(message);
            server.send(message);
        });
        server.onMessage((message) => ws.send(message));
    });
    return {
        outgoing,
        socketsOpened: () => routes.length,
        async closePageSockets() {
            for (const ws of routes) {
                try {
                    await ws.close();
                } catch {
                    // Already closed by an earlier blip or by the page.
                }
            }
        },
    };
}

/**
 * What a page puts on its data channels, in order, read where simple-peer hands it to the
 * browser, so a wrapper around peer.send cannot hide a frame: a control frame by its type,
 * anything else as text or binary:<bytes>. A receiver frames control as binary, so a small
 * one is read by content. channelText is the control frames as they were written.
 */
export async function watchChannel(context: BrowserContext): Promise<void> {
    await context.addInitScript(() => {
        const sent: string[] = [];
        const text: string[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        w.__channelSent = sent;
        w.__channelText = text;
        const typeOf = (frame: string): string | null => {
            try {
                const parsed = JSON.parse(frame);
                return typeof parsed?.type === 'string' ? parsed.type : null;
            } catch {
                return null;
            }
        };
        const real = RTCDataChannel.prototype.send;
        RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: unknown) {
            if (typeof data === 'string') {
                sent.push(typeOf(data) ?? 'text');
                text.push(data);
            } else {
                const bytes = data as ArrayBufferView;
                const small = bytes.byteLength <= 1000 ? new TextDecoder().decode(bytes) : null;
                const type = small === null ? null : typeOf(small);
                sent.push(type ?? `binary:${bytes.byteLength}`);
                if (type !== null && small !== null) text.push(small);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (real as any).call(this, data);
        } as typeof RTCDataChannel.prototype.send;
    });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const channelSent = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__channelSent ?? []);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const channelText = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__channelText ?? []);

/**
 * Every request a context makes and every socket frame it sends or hears, polling included.
 * A navigation's URL is read up to its #: the browser sends no fragment, and Playwright
 * reports it on the request anyway.
 */
export function watchTraffic(context: BrowserContext) {
    const urls: string[] = [];
    const bodies: string[] = [];
    const headers: Promise<void>[] = [];
    const heardHeaders: string[] = [];
    const answers: Promise<void>[] = [];
    const frames: string[] = [];
    let sockets = 0;
    context.on('request', (request) => {
        urls.push(request.url().split('#')[0]);
        const body = request.postData();
        if (body) bodies.push(body);
        // A request a service worker answered never resolves allHeaders() in Chromium, so
        // the headers Playwright already holds stand in for it after a moment.
        const asSent = Promise.race([
            request.allHeaders(),
            new Promise<Record<string, string>>((resolve) => setTimeout(() => resolve(request.headers()), 2_000)),
        ]);
        headers.push(
            asSent.then(
                (all) => void heardHeaders.push(Object.values(all).join('\n')),
                () => undefined,
            ),
        );
    });
    // What the server said over polling, the half of a socket no frame event reports.
    context.on('response', (response) => {
        if (!/\/socket\.io\/\?.*transport=polling/.test(response.url())) return;
        answers.push(
            response.text().then(
                (text) => void bodies.push(text),
                () => undefined,
            ),
        );
    });
    return {
        /** Call before the page navigates: a socket opened earlier goes unseen. */
        watchSockets(page: Page) {
            page.on('websocket', (ws) => {
                sockets += 1;
                urls.push(ws.url());
                const hear = (frame: { payload: string | Buffer }) =>
                    frames.push(typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('latin1'));
                ws.on('framesent', hear);
                ws.on('framereceived', hear);
            });
        },
        sockets: () => sockets,
        /** Everything this context said to or heard from a server, as one string. */
        async everything(): Promise<string> {
            await Promise.all([...headers, ...answers]);
            return [...urls, ...bodies, ...heardHeaders, ...frames].join('\n');
        },
    };
}

/** What the page keeps in the browser that holds this text, with the count of stored responses. */
export function storedByPage(page: Page, secret: string) {
    return page.evaluate(async (needle) => {
        const hits: string[] = [];
        const urls: string[] = [];
        let entries = 0;
        for (const name of await caches.keys()) {
            const cache = await caches.open(name);
            for (const request of await cache.keys()) {
                entries += 1;
                urls.push(request.url);
                if (request.url.includes(needle)) hits.push(`cache url in ${name}`);
                const response = await cache.match(request);
                if (response && (await response.text()).includes(needle)) hits.push(`cache body in ${name}`);
            }
        }
        for (const store of [localStorage, sessionStorage]) {
            for (let i = 0; i < store.length; i += 1) {
                const key = store.key(i) as string;
                if (key.includes(needle) || (store.getItem(key) ?? '').includes(needle)) hits.push('web storage');
            }
        }
        if (document.cookie.includes(needle)) hits.push('cookie');
        return { entries, hits, urls };
    }, secret);
}

/**
 * Make the worker control this page, on a build that has one, so what follows meets its
 * navigate guard. In a fresh context no worker is in the way, so a store read afterward
 * could not show the leak it names. lib/serviceWorkerRegistration.ts registers the worker
 * in a production build only: returns false under next dev, and throws on CI if it never
 * takes control, where a pass would then say nothing. Polled, not waitForFunction, which
 * takes the promise getRegistration returns as truthy whatever it resolves to.
 */
export async function underTheWorker(page: Page): Promise<boolean> {
    await page.goto('/');
    if (!process.env.CI) return page.evaluate(() => !!navigator.serviceWorker?.controller);
    await page.evaluate(() => navigator.serviceWorker.ready);
    const deadline = Date.now() + 30_000;
    while (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
        if (Date.now() > deadline) throw new Error('the worker never took control of this page');
        await page.waitForTimeout(100);
    }
    return true;
}

/** Outgoing Socket.IO event frames with this event name. */
export function framesFor(frames: string[], event: string): string[] {
    return frames.filter((f) => f.includes(`["${event}"`));
}

/** The `typ` of every ICE candidate the page sent in `signal` payloads. An
 *  empty end-of-candidates entry has no type and is skipped. */
export function outgoingCandidateTypes(frames: string[]): string[] {
    const types: string[] = [];
    for (const f of framesFor(frames, 'signal')) {
        for (const m of f.matchAll(/ typ ([a-z]+)/g)) types.push(m[1]);
    }
    return types;
}
