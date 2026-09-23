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

import type { BrowserContext, Page, WebSocketRoute } from '@playwright/test';
import { createHash } from 'crypto';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { E2E_HOST_BINARY } from './cli-binary';
import { SERVER_URL, WEB_URL } from './helpers';

export interface RequestHostEvent {
    event: string;
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
    /** -hold-after-file: hold the receive loop this many ms after the first
     *  committed file, between the `holding` and `released` events. */
    holdAfterFile?: number;
}

export interface RequestHost {
    proc: ChildProcess;
    events: RequestHostEvent[];
    outDir: string;
    exited: Promise<number | null>;
    /** Every event so far and a bounded stderr tail, for failure messages. */
    describe(): string;
    stop(): void;
}

/** Start the harness in request mode. Every stdout line must parse as JSON. */
export function startRequestHost(opts: RequestHostOptions): RequestHost {
    const args = ['request', '-server', SERVER_URL, '-web', WEB_URL, '-out', opts.outDir];
    if (opts.decide) args.push('-decide', opts.decide);
    if (opts.fastTimers) args.push('-fast-timers');
    if (opts.keepWaiting) args.push('-keep-waiting');
    if (opts.corruptHash) args.push('-corrupt-hash');
    if (opts.blipAfter) args.push('-blip-after', opts.blipAfter);
    if (opts.timeout) args.push('-timeout', opts.timeout);
    if (opts.joinAfter !== undefined) args.push('-join-after', String(opts.joinAfter));
    if (opts.holdAfterFile !== undefined) args.push('-hold-after-file', String(opts.holdAfterFile));
    const proc = spawn(E2E_HOST_BINARY, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const events: RequestHostEvent[] = [];
    const host = { proc, events, outDir: opts.outDir } as RequestHost & { waiters: Array<() => void>; closed: boolean };
    host.waiters = [];
    host.closed = false;
    let stderrTail = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000);
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
            events.push(parsed);
            host.waiters.splice(0).forEach((w) => w());
        }
    });
    host.exited = new Promise<number | null>((resolve) => {
        const done = (code: number | null) => {
            host.closed = true;
            host.waiters.splice(0).forEach((w) => w());
            resolve(code);
        };
        proc.on('close', (code) => done(code));
        proc.on('error', () => done(-1));
    });
    host.describe = () => `${JSON.stringify(events)}${stderrTail ? ` stderr tail: ${stderrTail}` : ''}`;
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

/** Every file under `dir`, as forward-slash relative path to SHA-256. */
export function sha256Manifest(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
        for (const name of readdirSync(d)) {
            const full = join(d, name);
            if (statSync(full).isDirectory()) walk(full);
            else out[relative(dir, full).split(sep).join('/')] = createHash('sha256').update(readFileSync(full)).digest('hex');
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
 * Count stats attempts for the whole context: every POST to the report
 * endpoint (aborted, so nothing leaves the machine) and every page-side
 * `floe:bytes-reported` event. Returns a reader for the total.
 */
export async function countStatsAttempts(context: BrowserContext): Promise<(pages: Page[]) => Promise<number>> {
    let routed = 0;
    await context.route('**/api/stats/report', (route) => {
        routed++;
        return route.abort();
    });
    await context.addInitScript(() => {
        const w = window as unknown as { __floeStatsEvents?: number };
        w.__floeStatsEvents = 0;
        window.addEventListener('floe:bytes-reported', () => {
            w.__floeStatsEvents = (w.__floeStatsEvents ?? 0) + 1;
        });
    });
    return async (pages: Page[]) => {
        let events = 0;
        for (const p of pages) {
            if (p.isClosed()) continue;
            events += await p.evaluate(() => (window as unknown as { __floeStatsEvents?: number }).__floeStatsEvents ?? 0);
        }
        return routed + events;
    };
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
