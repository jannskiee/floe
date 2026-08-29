// Surface adapter contract shared by lib/web.mjs, lib/cli.mjs, lib/desktop.mjs
// and lib/wsl.mjs. A Leg is one side of one transfer cell. Every adapter
// exports `createLeg(opts)` returning a Leg and `preflight(opts)` returning
// `{ ok, reason, detail }` without starting a transfer.
//
// StartOpts (plain object, built by lib/cell.mjs from a matrix row):
//   cellId       'S-DIR-W2C' style id (lib/matrix.mjs)
//   attempt      1 or 2
//   role         'sender' | 'receiver'
//   infra        { name: 'prod'|'local', server, web, servesTurn, relaxed,
//                  statsOracle: 'sentinel'|'none' }
//   build        { kind: 'shipped'|'head', version, path, launch?:
//                  'store'|'portable'|'wailsdev' }
//   relayOnly    true only on the leg that forces the relay
//   files        sender: absolute fixture paths
//   outDir       receiver: absolute, fresh per attempt
//   input        receiver: 'code' | 'link'
//   pionTrace    CLI relay legs under --pion-trace only
//   evidenceDir  absolute, per leg
//   deadlineAt   epoch ms; adapters must not block past it
//   statsOff     always true on a receiver (lib/cell.mjs asserts it)
//   ledger       lib/pacing.mjs Ledger; adapters call ledger.spend(kind)
//                right before each production request they cause
//
// Only awaitConnected, awaitRoute and awaitDone block. route() is polled
// by the cell runner and must be cheap and must never throw.

export const SURFACES = Object.freeze(['web', 'cli', 'desktop', 'wsl']);

export const CAPABILITIES = Object.freeze({
    web: {
        relayForce: true,
        code: { emits: false, accepts: false },
        route: ['getStats', 'event', 'pill'],
        statsProof: ['route-abort', 'no-bytes-reported-event', 'localStorage'],
    },
    cli: {
        relayForce: false,
        code: { emits: true, accepts: true },
        route: ['pion-trace'],
        statsProof: ['argv+env'],
    },
    desktop: {
        relayForce: true,
        code: { emits: true, accepts: true },
        route: ['pill', 'wails-event'],
        statsProof: ['desktop.json-preflight', 'settings-read'],
    },
    wsl: {
        relayForce: false,
        code: { emits: true, accepts: true },
        route: [],
        statsProof: ['argv+env'],
    },
});

export class PhaseError extends Error {
    constructor(phase, message, extra = {}) {
        super(message);
        this.name = 'PhaseError';
        this.phase = phase;
        Object.assign(this, extra);
    }
}

export class SafetyError extends Error {
    constructor(message, extra = {}) {
        super(message);
        this.name = 'SafetyError';
        Object.assign(this, extra);
    }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Leg {
    constructor(opts) {
        this.opts = opts;
        this.surface = 'unknown';
        this.role = opts.role;
        this.build = opts.build;
        this.cellId = opts.cellId;
        this.attempt = opts.attempt;
        this.notes = [];
    }

    /** Start the surface in its role. Resolves once the leg is ready to hand
     *  out a code or link (sender) or has joined the room (receiver). */
    async start() {
        throw new PhaseError('start', `${this.surface}: start not implemented`);
    }

    /** Three-word code, or null when the surface has none (web). */
    async code() {
        return null;
    }

    /** https?://...#room=<uuid> */
    async link() {
        throw new PhaseError('link', `${this.surface}: link not implemented`);
    }

    /** Resolves when the data path is up on this side. */
    async awaitConnected(timeoutMs) {
        throw new PhaseError(
            'connect',
            `${this.surface}: awaitConnected not implemented (${timeoutMs})`
        );
    }

    /** Latest route sample or null: { t, source, local, remote, verdict }.
     *  verdict is 'direct' | 'relay' | 'unknown'. Never throws. */
    route() {
        return null;
    }

    /** First decisive sample, or the 'unknown' sample at timeout. */
    async awaitRoute(timeoutMs) {
        const until = Date.now() + timeoutMs;
        for (;;) {
            const r = this.route();
            if (r && r.verdict !== 'unknown') return r;
            if (Date.now() >= until)
                return (
                    r || { t: Date.now(), source: 'none', verdict: 'unknown' }
                );
            await sleep(250);
        }
    }

    /** { ok, kind: 'transfer'|'refusal', detail, exitCode?, ms }.
     *  Rejects with PhaseError('done', ...) on a phase timeout. */
    async awaitDone(timeoutMs) {
        throw new PhaseError(
            'done',
            `${this.surface}: awaitDone not implemented (${timeoutMs})`
        );
    }

    /** receiver: [{ name, rel, bytes, sha256, path? }]; sender: [] */
    async outputs() {
        return [];
    }

    /** Graceful first, then only processes this run started. */
    async stop(reason) {
        this.notes.push(`stop: ${reason}`);
    }

    /** { transcript?, events?, samples?, captures?, statsProof, notes } */
    evidence() {
        return { statsProof: null, notes: this.notes };
    }
}
