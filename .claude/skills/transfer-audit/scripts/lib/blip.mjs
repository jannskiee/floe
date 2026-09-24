// The host blip for TA-13 (H-DIR-W2D-reqblip): a TCP proxy the driver owns,
// in front of the local signaling server. The desktop's server address
// points at the proxy for that cell only (the APPDATA-isolated desktop.json,
// probe P2), so cut(ms) can drop the host's /ws and nothing else: every
// proxied socket is destroyed, new ones are refused for `ms`, then the
// proxy accepts again and the host reclaims its reservation.
//
// Both ends are loopback by construction. The proxy binds 127.0.0.1 only,
// and an upstream that is not loopback is refused before anything listens:
// there is no safe way to cut one user's socket on a shared server, so this
// never fronts api.floe.one (OD-33). It carries bytes and never reads them.
import net from 'node:net';
import { isLoopbackUrl } from './matrix.mjs';

export const BLIP_HOST = '127.0.0.1';

/** { host, port } of a loopback http(s) URL, or a thrown refusal. */
export function loopbackTarget(upstream) {
    if (!isLoopbackUrl(upstream))
        throw new Error(
            `blip: upstream ${upstream} is not a loopback http(s) URL; the blip proxy only fronts a local server`
        );
    const u = new URL(upstream);
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port };
}

export class BlipProxy {
    constructor({ upstream, now = Date.now } = {}) {
        this.target = loopbackTarget(upstream);
        this.now = now;
        this.server = null;
        this.port = null;
        this.pairs = new Set();
        this.cutUntil = 0;
        this.stats = { accepted: 0, refused: 0, cuts: 0, destroyed: 0 };
    }

    /** Listen on a free 127.0.0.1 port; resolves { port, url }. */
    async start() {
        if (this.server) throw new Error('blip: already started');
        this.server = net.createServer((client) => this._accept(client));
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, BLIP_HOST, () => {
                this.server.off('error', reject);
                resolve();
            });
        });
        this.port = this.server.address().port;
        return { port: this.port, url: this.url };
    }

    /**
     * The URL the host is pointed at, or null before start(). request.mjs
     * reads it off the instance startBlip returns; start() alone used to
     * return it, so the first live TA-13 run (2026-09-24) swapped nothing
     * and cut a proxy the host was never behind.
     */
    get url() {
        return this.port == null ? null : `http://${BLIP_HOST}:${this.port}`;
    }

    get cutting() {
        return this.now() < this.cutUntil;
    }

    _accept(client) {
        client.on('error', () => {});
        if (this.cutting) {
            this.stats.refused += 1;
            client.destroy();
            return;
        }
        this.stats.accepted += 1;
        const upstream = net.connect(this.target.port, this.target.host);
        upstream.on('error', () => {});
        const pair = { client, upstream };
        this.pairs.add(pair);
        const drop = () => {
            if (!this.pairs.delete(pair)) return;
            client.destroy();
            upstream.destroy();
        };
        client.on('close', drop);
        upstream.on('close', drop);
        client.pipe(upstream);
        upstream.pipe(client);
    }

    /**
     * Destroy every proxied socket now and refuse new ones for `ms`, then
     * accept again. Resolves { cutAt, resumedAt, destroyed } after the
     * window.
     */
    async cut(ms, { wait = (d) => new Promise((r) => setTimeout(r, d)) } = {}) {
        if (!this.server) throw new Error('blip: not started');
        if (!(Number.isFinite(ms) && ms > 0))
            throw new Error(`blip: cut wants a positive window, got ${ms}`);
        const cutAt = this.now();
        this.cutUntil = cutAt + ms;
        this.stats.cuts += 1;
        let destroyed = 0;
        for (const pair of [...this.pairs]) {
            this.pairs.delete(pair);
            pair.client.destroy();
            pair.upstream.destroy();
            destroyed += 1;
        }
        this.stats.destroyed += destroyed;
        await wait(ms);
        return { cutAt, resumedAt: this.now(), destroyed };
    }

    get live() {
        return this.pairs.size;
    }

    async stop() {
        for (const pair of [...this.pairs]) {
            pair.client.destroy();
            pair.upstream.destroy();
        }
        this.pairs.clear();
        if (!this.server) return;
        const s = this.server;
        this.server = null;
        await new Promise((resolve) => s.close(() => resolve()));
    }
}

export async function startBlip(opts) {
    const b = new BlipProxy(opts);
    await b.start();
    return b;
}
