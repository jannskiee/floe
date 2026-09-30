// The local Docker Caddy of TA-14 (H-DIR-W2D-reqcaddy; S1-REL-03a step 9,
// built in FU-26 as a 17 P-15 carry-over): a Caddy in a container, in front
// of the local signaling server, that the cell reloads once while a request
// link waits and once while its drop receives. Caddy force-closes proxied
// WebSockets on a reload by default and stream_close_delay defaults to none
// (spec 09 2.7.2 TA-14, gap G-03), so a reload drops every socket behind it,
// which is what a `caddy reload` on api.floe.one would do to every user.
// That is why this cell never touches production (OD-33): the upstream must
// be the local server (reached from the container as host.docker.internal),
// the container publishes on 127.0.0.1 only, and the cell is SKIP unless the
// run names --caddy.
//
// Every docker call goes through the injected exec with windowsHide, so no
// console window takes the foreground (FU-02: a visible child console does),
// and the container is removed by its own id and never by name or pattern.
// INFERRED until the first live run: the Windows bind-mount form of the
// Caddyfile path, the caddy:2 image's reload through its default admin
// endpoint, and host.docker.internal on Docker Desktop.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { isLoopbackUrl } from './matrix.mjs';
import { PhaseError } from './surfaces.mjs';

export const CADDY_IMAGE = 'caddy:2';
export const CADDY_CONFIG = '/etc/caddy/Caddyfile';
export const CADDY_HOST = '127.0.0.1';
/** Docker Desktop's name for the Windows host, as seen from a container. */
export const DOCKER_HOST_ALIAS = 'host.docker.internal';
const UPSTREAM_RE = /^(host\.docker\.internal|127\.0\.0\.1|localhost):(\d{1,5})$/;
const CONTAINER_ID_RE = /^[0-9a-f]{12,64}$/;
const DOCKER_TIMEOUT_MS = 120_000;

function defaultDockerExec(cmd, args, opts = {}) {
    return execFileSync(cmd, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...opts,
    });
}

function checkPort(port) {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1024 || p > 65535)
        throw new Error(`caddy: port ${port} is not a free high port`);
    return p;
}

function checkUpstream(upstream) {
    const m = UPSTREAM_RE.exec(String(upstream ?? ''));
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535)
        throw new Error(
            `caddy: upstream ${upstream} is not the local server (host.docker.internal or loopback, with a port); this Caddy only fronts a local server`
        );
    return String(upstream);
}

/**
 * The container's address for the local server under test: its port on
 * host.docker.internal. A server URL that is not loopback is refused: there
 * is no reload of a shared server that does not drop its users (OD-33).
 */
export function caddyUpstream(serverUrl) {
    if (!isLoopbackUrl(serverUrl))
        throw new Error(
            `caddy: ${serverUrl ?? 'no server'} is not a loopback http(s) URL; TA-14 only fronts the local server`
        );
    const u = new URL(serverUrl);
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    return `${DOCKER_HOST_ALIAS}:${port}`;
}

/**
 * One site on `port`, proxying to `upstream`, with automatic HTTPS off. No
 * stream_close_delay on purpose: a reload closes the proxied WebSockets, the
 * Caddy default that production runs with.
 */
export function renderCaddyfile({ port, upstream }) {
    const p = checkPort(port);
    const up = checkUpstream(upstream);
    return ['{', '\tauto_https off', '}', '', `:${p} {`, `\treverse_proxy ${up}`, '}', ''].join('\n');
}

/** { ok, version } from `docker version`, or { ok:false, detail } when Docker is not answering. */
export function dockerVersion({ exec = defaultDockerExec } = {}) {
    try {
        const out = String(
            exec('docker', ['version', '--format', '{{.Server.Version}}'], {
                windowsHide: true,
                timeout: 30_000,
            }) ?? ''
        ).trim();
        if (!out) return { ok: false, detail: 'docker version printed no server version' };
        return { ok: true, version: out.split(/\r?\n/)[0] };
    } catch (e) {
        return { ok: false, detail: String(e.message).split(/\r?\n/)[0] };
    }
}

/** A free port on 127.0.0.1 (listen on 0, read it, close). */
export function freeLoopbackPort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.unref();
        s.once('error', reject);
        s.listen(0, CADDY_HOST, () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

// Containers this process started and has not removed: the exit hook below
// removes them if the run dies before its teardown.
const running = new Set();
process.on('exit', () => {
    for (const c of [...running]) {
        try {
            c.exec('docker', ['rm', '-f', c.id], { windowsHide: true, timeout: 15_000 });
        } catch {
            // Best effort; the container carries --rm and binds 127.0.0.1 only.
        }
        running.delete(c);
    }
});

export class CaddyProxy {
    constructor({
        exec = defaultDockerExec,
        runDir,
        port,
        upstream,
        image = CADDY_IMAGE,
        now = Date.now,
        log = null,
    } = {}) {
        this.exec = exec;
        this.runDir = runDir;
        this.port = checkPort(port);
        this.upstream = checkUpstream(upstream);
        this.image = image;
        this.now = now;
        this.log = typeof log === 'function' ? log : () => {};
        this.id = null;
        this.file = null;
        this.reloads = [];
        this.stopped = false;
        this._stopPromise = null;
    }

    get url() {
        return `http://${CADDY_HOST}:${this.port}`;
    }

    _docker(args, timeout = DOCKER_TIMEOUT_MS) {
        return String(this.exec('docker', args, { windowsHide: true, timeout }) ?? '');
    }

    /** Write the Caddyfile into the run folder and start the container; resolves { id, url }. */
    async start() {
        if (!this.runDir) throw new Error('caddy: no run folder for the Caddyfile');
        mkdirSync(this.runDir, { recursive: true });
        this.file = path.join(this.runDir, 'Caddyfile');
        writeFileSync(this.file, renderCaddyfile({ port: this.port, upstream: this.upstream }));
        const out = this._docker([
            'run',
            '--rm',
            '-d',
            '-p',
            `${CADDY_HOST}:${this.port}:${this.port}`,
            '-v',
            `${this.file}:${CADDY_CONFIG}:ro`,
            this.image,
        ]);
        const id = out.trim().split(/\r?\n/).pop() ?? '';
        if (!CONTAINER_ID_RE.test(id))
            throw new Error(`caddy: docker run printed no container id (${JSON.stringify(out.trim().slice(0, 80))})`);
        this.id = id;
        running.add(this);
        this.log(`caddy: container ${id.slice(0, 12)} on ${this.url} -> ${this.upstream}`);
        return { id, url: this.url };
    }

    /** One `caddy reload --force` inside the container; resolves { at }. */
    async reload() {
        if (this.stopped || !this.id) throw new Error('caddy: the proxy is stopped');
        this._docker(['exec', this.id, 'caddy', 'reload', '--config', CADDY_CONFIG, '--force'], 60_000);
        const at = this.now();
        this.reloads.push(at);
        this.log(`caddy: reload ${this.reloads.length}`);
        return { at };
    }

    /** Remove this proxy's own container, once, whoever asks. */
    stop() {
        if (!this._stopPromise)
            this._stopPromise = (async () => {
                this.stopped = true;
                if (!this.id) return;
                try {
                    this._docker(['rm', '-f', this.id], 30_000);
                } finally {
                    running.delete(this);
                }
            })();
        return this._stopPromise;
    }
}

/**
 * TA-14's Caddy: Docker must answer (SKIP docker-absent otherwise, before
 * anything is written), the upstream is the local server, the port a free
 * loopback one unless a test names it.
 */
export async function startCaddy({
    upstream,
    exec = defaultDockerExec,
    runDir,
    port = null,
    now = Date.now,
    log = null,
} = {}) {
    const up = caddyUpstream(upstream);
    const docker = dockerVersion({ exec });
    if (!docker.ok)
        throw new PhaseError('caddy', `docker-absent: ${docker.detail}`, {
            verdict: 'SKIP',
            reason: 'docker-absent',
        });
    const c = new CaddyProxy({
        exec,
        runDir,
        port: port ?? (await freeLoopbackPort()),
        upstream: up,
        now,
        log,
    });
    await c.start();
    return c;
}
