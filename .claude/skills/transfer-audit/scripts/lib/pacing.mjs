// Pacing ledger against the production limiters (server/server.js: TURN 20,
// connections 30, code 60, stats 60 per IP per rolling 60 s). Pure apart
// from the injected clock, persisted as JSON at --out/ledger.json so two
// runs inside one minute share the same window. Headroom is 50 percent
// (10 TURN, 15 conn, 30 code) and there is an 8 s floor between leg starts,
// so the user's own floe.one traffic on the same IP still has room.
// A 429 symptom calls penalize(), which blocks one full window; two
// consecutive symptoms make infraDown() true and the run marks the rest
// SKIP infra-down.
import { readFileSync, writeFileSync } from 'node:fs';

export const PROD_LIMITS = Object.freeze({
    turn: 20,
    conn: 30,
    code: 60,
    stats: 60,
});
export const RELAXED_LIMITS = Object.freeze({
    turn: 1000,
    conn: 1000,
    code: 1000,
    stats: 60,
});
export const HEADROOM = 0.5;
export const WINDOW_MS = 60_000;
export const MIN_GAP_MS = 8_000;
export const BUCKETS = Object.freeze(['turn', 'conn', 'code']);

// Cost per leg. The CLI fetches /api/turn-credentials even with --no-relay,
// so a direct CLI leg still costs one TURN fetch.
export const COST = Object.freeze({
    'web:sender': { turn: 1, conn: 1, code: 0 },
    'web:receiver': { turn: 1, conn: 1, code: 0 },
    'cli:sender': { turn: 1, conn: 1, code: 1 },
    'cli:receiver:link': { turn: 1, conn: 1, code: 0 },
    'cli:receiver:code': { turn: 1, conn: 1, code: 1 },
    'wsl:sender': { turn: 1, conn: 1, code: 1 },
    'wsl:receiver:link': { turn: 1, conn: 1, code: 0 },
    'wsl:receiver:code': { turn: 1, conn: 1, code: 1 },
    'desktop:sender': { turn: 1, conn: 1, code: 1 },
    'desktop:receiver:link': { turn: 1, conn: 1, code: 0 },
    'desktop:receiver:code': { turn: 1, conn: 1, code: 1 },
    'probe:turn': { turn: 1, conn: 0, code: 0 },
    'probe:desktop-code': { turn: 0, conn: 0, code: 1 },
    'browser:reload': { turn: 1, conn: 1, code: 0 },
});

export function legKind(surface, role, input) {
    if (role === 'sender') return `${surface}:sender`;
    if (surface === 'web') return 'web:receiver';
    return `${surface}:receiver:${input === 'code' ? 'code' : 'link'}`;
}

export function costOf(kind) {
    if (kind && typeof kind === 'object') return { ...kind };
    if (COST[kind]) return { ...COST[kind] };
    if (BUCKETS.includes(kind)) return { [kind]: 1 };
    throw new Error(`unknown ledger cost kind ${kind}`);
}

export function addCost(a, b) {
    const out = {};
    for (const k of BUCKETS) out[k] = (a?.[k] || 0) + (b?.[k] || 0);
    return out;
}

/** Sum of both legs of a matrix cell (lib/matrix.mjs row). */
export function cellCost(cell) {
    const s = legKind(cell.sender.surface, 'sender');
    const r = legKind(cell.receiver.surface, 'receiver', cell.receiver.input);
    return addCost(costOf(s), costOf(r));
}

export class Ledger {
    constructor({
        limits = PROD_LIMITS,
        windowMs = WINDOW_MS,
        headroom = HEADROOM,
        minGapMs = MIN_GAP_MS,
        now = Date.now,
        relaxed = false,
        file = null,
    } = {}) {
        this.relaxed = relaxed;
        this.limits = relaxed ? RELAXED_LIMITS : limits;
        this.windowMs = windowMs;
        this.headroom = relaxed ? 1 : headroom;
        this.minGapMs = relaxed ? 0 : minGapMs;
        this.now = now;
        this.file = file;
        this.events = [];
        this.lastStartAt = 0;
        this.penaltyUntil = 0;
        this.symptoms = 0;
        this.waitsMs = [];
        this.retriesUsed = 0;
        // Peak per bucket over any 60 s window of this ledger's life,
        // tracked at spend/commit time: waitMs prunes the events in place,
        // so a peak computed from the surviving events at run end only
        // sees the last window.
        this.peak = { turn: 0, conn: 0, code: 0 };
    }

    /** Fold the window that ends at `at` into the tracked peak. */
    trackPeak(at = this.now()) {
        const w = this.inWindow(at);
        for (const k of BUCKETS) this.peak[k] = Math.max(this.peak[k], w[k]);
    }

    static relaxed(opts = {}) {
        return new Ledger({ ...opts, relaxed: true });
    }

    /**
     * A persisted ledger is data from another process and another clock:
     * an event stamped in the future (a clock that jumped back) would
     * shadow the whole window, a lastStartAt or penaltyUntil in the
     * future would stall waitFor for that long, and a non-integer count
     * would be miscounted by the per-request expansion in waitMs. Each is
     * clamped or dropped here, never trusted.
     */
    static load(json, opts = {}) {
        const l = new Ledger(opts);
        const data = typeof json === 'string' ? JSON.parse(json) : json;
        if (data && typeof data === 'object') {
            const now = l.now();
            const events = Array.isArray(data.events) ? data.events : [];
            l.events = events
                .filter(
                    (e) =>
                        e &&
                        typeof e === 'object' &&
                        Number.isFinite(e.t) &&
                        e.t <= now
                )
                .map((e) => {
                    const out = { t: e.t };
                    for (const k of BUCKETS)
                        if (k in e)
                            out[k] =
                                Number.isInteger(e[k]) && e[k] >= 0 ? e[k] : 0;
                    if (typeof e.kind === 'string') out.kind = e.kind;
                    return out;
                });
            l.lastStartAt = Math.min(
                Math.max(0, Number(data.lastStartAt) || 0),
                now
            );
            l.penaltyUntil = Math.min(
                Math.max(0, Number(data.penaltyUntil) || 0),
                now + l.windowMs
            );
            l.symptoms = Math.max(0, Math.floor(Number(data.symptoms) || 0));
            l.waitsMs = Array.isArray(data.waitsMs)
                ? data.waitsMs.filter((w) => Number.isFinite(w) && w >= 0)
                : [];
            l.retriesUsed = Math.max(
                0,
                Math.floor(Number(data.retriesUsed) || 0)
            );
            // What the production limiter already holds against this IP
            // as the run starts is this run's floor.
            l.trackPeak(now);
        }
        return l;
    }

    /** Load from file when it exists, else a fresh ledger bound to it. */
    static open(file, opts = {}) {
        let data = null;
        try {
            data = readFileSync(file, 'utf8');
        } catch {
            data = null;
        }
        const l = data ? Ledger.load(data, opts) : new Ledger(opts);
        l.file = file;
        return l;
    }

    toJSON() {
        return {
            limits: this.limits,
            headroom: this.headroom,
            windowMs: this.windowMs,
            minGapMs: this.minGapMs,
            events: this.events,
            lastStartAt: this.lastStartAt,
            penaltyUntil: this.penaltyUntil,
            symptoms: this.symptoms,
            waitsMs: this.waitsMs,
            retriesUsed: this.retriesUsed,
        };
    }

    save(file = this.file) {
        if (!file) return;
        writeFileSync(file, JSON.stringify(this, null, 4) + '\n');
    }

    allowed(bucket) {
        return Math.floor(this.limits[bucket] * this.headroom);
    }

    prune(at = this.now()) {
        this.events = this.events.filter((e) => at - e.t < this.windowMs);
    }

    /** Count per bucket inside the current window. */
    inWindow(at = this.now()) {
        const out = { turn: 0, conn: 0, code: 0 };
        for (const e of this.events)
            if (at - e.t < this.windowMs)
                for (const k of BUCKETS) out[k] += e[k] || 0;
        return out;
    }

    /** Milliseconds to wait before `cost` fits under every cap. */
    waitMs(cost, at = this.now()) {
        this.prune(at);
        const c = costOf(cost);
        let wait = Math.max(
            0,
            this.lastStartAt + this.minGapMs - at,
            this.penaltyUntil - at
        );
        for (const b of BUCKETS) {
            const allowed = this.allowed(b);
            const ts = this.events
                .filter((e) => (e[b] || 0) > 0)
                .flatMap((e) => Array(e[b]).fill(e.t))
                .sort((x, y) => x - y);
            const excess = ts.length + (c[b] || 0) - allowed;
            if (excess > 0)
                wait = Math.max(wait, ts[excess - 1] + this.windowMs - at);
        }
        return Math.ceil(wait);
    }

    /** Record `cost` at `at` and mark a leg start. */
    commit(cost, at = this.now()) {
        const c = costOf(cost);
        this.events.push({ t: at, ...c });
        this.lastStartAt = at;
        this.trackPeak(at);
        return c;
    }

    /** Adapters call this right before each production request. */
    spend(kind, at = this.now()) {
        const c = costOf(kind);
        this.events.push({
            t: at,
            ...c,
            kind: typeof kind === 'string' ? kind : 'cost',
        });
        this.trackPeak(at);
        return c;
    }

    /** Sleep until `cost` fits, then mark the start. Returns the wait. */
    async waitFor(cost, { sleep, log } = {}) {
        const wait = this.waitMs(cost);
        if (wait > 0) {
            this.waitsMs.push(wait);
            if (log)
                log(`pacing: waiting ${Math.ceil(wait / 1000)} s for headroom`);
            await (sleep || ((ms) => new Promise((r) => setTimeout(r, ms))))(
                wait
            );
        }
        this.lastStartAt = this.now();
        return wait;
    }

    /** After a 429 symptom: block one full window. */
    penalize(at = this.now()) {
        this.penaltyUntil = at + this.windowMs;
        this.symptoms += 1;
        return this.penaltyUntil;
    }

    clearSymptoms() {
        this.symptoms = 0;
    }

    infraDown() {
        return this.symptoms >= 2;
    }

    /**
     * Peak count per bucket over any rolling window of the ledger's life:
     * the tracked peak, folded with what the surviving events still show
     * (events recorded through means other than spend/commit).
     */
    peakPer60s() {
        const out = { ...this.peak };
        const sorted = [...this.events].sort((a, b) => a.t - b.t);
        for (let i = 0; i < sorted.length; i++) {
            const sum = { turn: 0, conn: 0, code: 0 };
            for (let j = i; j < sorted.length; j++) {
                if (sorted[j].t - sorted[i].t >= this.windowMs) break;
                for (const k of BUCKETS) sum[k] += sorted[j][k] || 0;
            }
            for (const k of BUCKETS) out[k] = Math.max(out[k], sum[k]);
        }
        return out;
    }

    summary() {
        return {
            caps: { ...this.limits },
            softBudgetPct: Math.round(this.headroom * 100),
            peakPer60s: this.peakPer60s(),
            waitsMs: [...this.waitsMs],
            retriesUsed: this.retriesUsed,
            retryCap: 3,
            relaxed: this.relaxed,
        };
    }
}
