// Cell catalogue and gating. cellPlan() is pure: it turns a profile, a
// subset, the probe results and the capability table into the rows the
// runner executes, with every gate applied (NA = impossible with the shipped
// product, SKIP = a precondition on this machine or run is unmet). Ids are
// <S|H>-<DIR|REL>-<snd>2<rcv>[-variant] with W web, C CLI, D desktop, L CLI
// inside WSL2. Every receiver leg carries statsOff: true; matrix.test.mjs
// asserts it, and lib/cell.mjs refuses a leg without it.
import { UsageError } from './args.mjs';
import { CAPABILITIES } from './surfaces.mjs';
import {
    BOUNDARY_SIZES,
    CAP_BYTES,
    SIZE_LADDER,
    DESKTOP_DIR_BYTES,
    DIR_BYTES,
    KILL_AT_BYTES,
    KILL_BYTES,
    REL_BYTES,
    THROUGHPUT_BYTES,
} from './fixtures.mjs';
import { cellCost } from './pacing.mjs';

export const LETTER = Object.freeze({
    web: 'W',
    cli: 'C',
    desktop: 'D',
    wsl: 'L',
});
export const SURFACE_OF = Object.freeze({
    W: 'web',
    C: 'cli',
    D: 'desktop',
    L: 'wsl',
});

export const QUICK_IDS = Object.freeze([
    'S-DIR-W2W',
    'S-DIR-C2W',
    'S-DIR-W2C',
    'S-REL-W2C',
    'S-DIR-D2C',
    'S-DIR-C2D',
]);

// The forced-mismatch cells (P0-27). They are head-profile only, and they are
// NOT in DEFAULT_IDS or DEEP_IDS: a run reaches them through --cells, and the
// runner needs a sender that can lie (a web context with installHashbad, or the
// floe-e2ehost send mode) before they can pass. Listing them here keeps
// matrix.md and cellPlan agreeing about what the ids mean.
export const HASH_IDS = Object.freeze([
    'H-DIR-C2C-hashbad',
    'H-DIR-C2C-hashmal',
    'H-DIR-W2C-hashbad',
    'H-DIR-C2W-hashbad',
    'H-DIR-C2D-hashbad',
]);

// The request link cells (S1-REL-03a, spec 09 2.7.2). The visitor is a web
// page on /r (W) and the host is the desktop (D), so every one is a W2D
// cell except TA-17, which is the six quick cells run while the desktop
// holds an open link. Like HASH_IDS they are outside DEFAULT_IDS and
// DEEP_IDS: a run reaches them through --cells, and each SKIPs
// `server-no-request-1` until probe P10 finds request-1 in the server's
// /health features. TA-14 (reqcaddy) and TA-16 (the CLI visitor) are not
// planned yet (Phase F prep, and deferred with B6).
export const REQUEST_VARIANTS = Object.freeze([
    'req', // TA-10, TA-11 and the head twins: one visitor, Accept, delivered
    'reqhideip', // TA-12: relay forced by the host's Hide my IP
    'reqblip', // TA-13: the host's /ws cut while the link waits (head only)
    'reqdecline', // TA-15: Decline, Keep waiting, a second visitor delivers
    'reqopen', // TA-17: a quick cell run with a link open on the desktop
]);
export const REQUEST_OPEN_IDS = Object.freeze(
    QUICK_IDS.map((id) => `${id}-reqopen`)
);
export const REQUEST_IDS = Object.freeze([
    'S-DIR-W2D-req', // TA-10
    'S-REL-W2D-req', // TA-11
    'S-REL-W2D-reqhideip', // TA-12 (optional)
    'H-DIR-W2D-reqblip', // TA-13
    'H-DIR-W2D-reqdecline', // TA-15
    ...REQUEST_OPEN_IDS, // TA-17
    'H-DIR-W2D-req', // head twin of TA-10
    'H-REL-W2D-req', // head twin of TA-11
    ...REQUEST_OPEN_IDS.map((id) => `H-${id.slice(2)}`), // head twins of TA-17
]);
/** The cut TA-13 makes in the host's /ws while the link waits (09 2.7.2). */
export const REQUEST_BLIP_MS = 5_000;
/**
 * The audit clicks Accept or Decline no earlier than this after the prompt
 * was first seen; the frontend's guard is 1 s. lib/desktop.mjs
 * ACCEPT_WAIT_MS is the same number (matrix.test.mjs asserts it).
 */
export const REQUEST_ACCEPT_WAIT_MS = 1_200;
const MiB = 1024 * 1024;

export function requestFlowOf(variant) {
    switch (variant) {
        case 'req':
        case 'reqhideip':
            return 'accept';
        case 'reqblip':
            return 'blip-then-accept';
        case 'reqdecline':
            return 'decline-then-accept';
        case 'reqopen':
            return 'open-link-precondition';
        default:
            return null;
    }
}

/** True for http(s) URLs whose host is loopback; anything else is false. */
export function isLoopbackUrl(url) {
    let u;
    try {
        u = new URL(String(url));
    } catch {
        return false;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

const PAIRS = ['W2W', 'W2C', 'W2D', 'C2W', 'C2C', 'C2D', 'D2W', 'D2C', 'D2D'];
export const DEFAULT_IDS = Object.freeze([
    ...PAIRS.map((p) => `S-DIR-${p}`),
    ...PAIRS.map((p) => `S-REL-${p}`),
]);

export const DEEP_IDS = Object.freeze([
    'S-DIR-C2C-bnd8',
    'S-DIR-W2C-bnd8',
    // The size ladder, on all three engines: the Go CLI, the browser's
    // sender, and the desktop as a multi-file receiver (every other
    // desktop cell moves exactly one file).
    'S-DIR-C2C-sizes',
    'S-DIR-W2C-sizes',
    'S-DIR-C2D-sizes',
    'S-DIR-C2C-fold',
    'S-DIR-C2W-zip',
    'S-REL-C2W-cap3g',
    'S-DIR-C2C-thr500',
    'S-DIR-C2C-killsnd',
    'S-DIR-C2C-killrcv',
    'S-DIR-C2C-link',
    'S-DIR-C2D-link',
    'S-DIR-D2C-link',
    'S-DIR-L2C',
    'S-DIR-L2W',
    'S-DIR-L2D',
]);

export const SKIP_REASONS = Object.freeze({
    'uia-setvalue':
        'desktop receiver not drivable through UIA SetValue (probe P1)',
    'desktop-savedir':
        'desktop save-dir field not settable; never write into real Downloads',
    'local-stun-only': 'local stack serves STUN only',
    'prod-turn-absent': 'production TURN probe found no turn/turns scheme',
    'browser-relay-na':
        'browser relay forcer did not take on this build (probe P3)',
    'disk-space': 'under 4 GiB free on the scratch drive',
    'wsl-stopped': 'WSL Ubuntu-22.04 not present or not startable',
    'wsl-sideload':
        'Linux release CLI could not be side-loaded into WSL (tag, download or sha256sum; see log.txt)',
    'harness-build':
        'the lying harness sender (cli/internal/e2ehost) could not be built or failed preflight (see log.txt)',
    'head-only':
        'a head-profile cell named in a shipped run: the forced-mismatch cells never run against production',
    'infra-down': 'two consecutive infra symptoms against the signaling server',
    'budget-exhausted': 'run-wide retry or byte budget exhausted',
    present: 'user present and the desktop window needs focus',
    'desktop-none': '--desktop none drops desktop cells',
    'desktop-unavailable':
        'no desktop build to drive (probe or preflight failed)',
    'head-desktop-pending': 'HEAD desktop build not available in this run',
    'server-no-request-1':
        'the server under test does not list request-1 in its /health features (probe P10)',
    'request-host-uia-pending':
        'the request link host verbs run on --desktop wailsdev only; the UIA verbs for the Store and portable builds are Phase F prep',
    filtered: 'excluded by --cells',
});

export const NA_REASONS = Object.freeze({
    'single-instance':
        'desktop is single-instance; a second launch forwards argv and exits',
    'no-cli-relay-forcer':
        'no CLI relay forcer until floe send --help lists --relay-only',
});

// Reasons that never count toward exit 5: NA is impossible by
// construction, and a --cells filter is the operator's own choice.
export const UNCOUNTED_SKIPS = new Set(['filtered']);

// hashbad and hashmal: a CLI-shaped sender that lies is the floe-e2ehost send
// mode, which prints a link and never registers a code (P0-27).
const VARIANT_INPUT_LINK = new Set([
    'link',
    'zip',
    'bnd8',
    'fold',
    'hashbad',
    'hashmal',
]);

export function parseCellId(id) {
    const m = /^([SH])-(DIR|REL)-([WCDL])2([WCDL])(?:-([a-z0-9]+))?$/.exec(id);
    if (!m) throw new Error(`bad cell id ${id}`);
    return {
        id,
        profile: m[1],
        path: m[2],
        snd: m[3],
        rcv: m[4],
        variant: m[5] || null,
    };
}

/** Glob match for --cells: `*` any run, `?` one char, case-insensitive. */
export function matchCells(id, patterns) {
    if (!patterns || !patterns.length) return true;
    return patterns.some((p) => {
        const re = new RegExp(
            '^' +
                p
                    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                    .replace(/\*/g, '.*')
                    .replace(/\?/g, '.') +
                '$',
            'i'
        );
        return re.test(id);
    });
}

/**
 * A DIR cell with a desktop side (W2D, C2D, D2W, D2C and the deep L2D)
 * moves DESKTOP_DIR_BYTES, so the route pill stays decisive for longer
 * than one sampler tick; the link variants and every other deep cell keep
 * the sizes their rows promise in references/matrix.md.
 */
function desktopDirCell(parsed) {
    return (
        parsed.path === 'DIR' &&
        !parsed.variant &&
        (parsed.snd === 'D' || parsed.rcv === 'D')
    );
}

export function fixtureSpec(parsed) {
    switch (parsed.variant) {
        // TA-17 moves what its quick cell moves.
        case 'reqopen':
            return fixtureSpec({ ...parsed, variant: null });
        case 'reqdecline':
            return { kind: 'single', bytes: MiB, totalBytes: MiB };
        case 'req':
        case 'reqhideip':
        case 'reqblip': {
            const bytes = parsed.path === 'REL' ? REL_BYTES : DESKTOP_DIR_BYTES;
            return { kind: 'single', bytes, totalBytes: bytes };
        }
        case 'bnd8':
            return {
                kind: 'batch',
                sizes: [...BOUNDARY_SIZES],
                totalBytes: BOUNDARY_SIZES.reduce((a, b) => a + b, 0),
            };
        case 'sizes':
            return {
                kind: 'batch',
                sizes: [...SIZE_LADDER],
                totalBytes: SIZE_LADDER.reduce((a, b) => a + b, 0),
            };
        case 'fold':
        case 'zip':
            return { kind: 'folder', totalBytes: 1024 + 262157 + 1024 * 1024 };
        case 'cap3g':
            return { kind: 'sparse', bytes: CAP_BYTES, totalBytes: CAP_BYTES };
        case 'thr500':
            return {
                kind: 'single',
                bytes: THROUGHPUT_BYTES,
                totalBytes: THROUGHPUT_BYTES,
            };
        case 'killsnd':
        case 'killrcv':
            return {
                kind: 'single',
                bytes: KILL_BYTES,
                totalBytes: KILL_BYTES,
            };
        default: {
            const bytes =
                parsed.path === 'REL'
                    ? REL_BYTES
                    : desktopDirCell(parsed)
                      ? DESKTOP_DIR_BYTES
                      : DIR_BYTES;
            return { kind: 'single', bytes, totalBytes: bytes };
        }
    }
}

export function expectOf(variant) {
    if (variant === 'cap3g') return 'refusal';
    // The receiver refuses a file whose digest does not match what arrived, and
    // a digest it cannot read refuses the same way: both are the hash-mismatch
    // code, so both cells expect a refusal rather than a transfer.
    if (variant === 'hashbad' || variant === 'hashmal') return 'refusal';
    if (variant === 'killsnd') return 'kill-sender';
    if (variant === 'killrcv') return 'kill-receiver';
    return 'transfer';
}

/**
 * How a cell makes its sender lie about a digest, or null when it does not.
 * 'corrupt' changes one hex digit, so the digest is well formed and cannot
 * match; 'malformed' upper-cases it, which the wire format forbids. A web
 * sender gets web.mjs installHashbad; a CLI-shaped sender is the test-only
 * floe-e2ehost send mode with -corrupt-hash or -malformed-hash.
 */
export function hashLieOf(variant) {
    if (variant === 'hashbad') return 'corrupt';
    if (variant === 'hashmal') return 'malformed';
    return null;
}

// Per-phase timeouts from the report design (section 1.7): link/code
// visible C 30 s, W 20 s, D 30 s; connected 45 s direct / 60 s relay,
// 60 / 75 s with a desktop side; first bytes 30 s; complete
// max(60 s, size / 10 MB/s) direct, max(90 s, size / 1 MB/s) relay,
// refusal 30 s; exit 15 s; hard cap = sum + 10 s. Teardown is 30 s, or
// 60 s with a desktop side: DesktopLeg.stop can take CANCEL_MS + two
// EXIT_MS rounds + 1 s (41 s) before its desktop.json restore runs.
export function phaseTimeouts({ path: p, snd, rcv, expect, fixture }) {
    const linkFor = (l) => (l === 'W' ? 20_000 : 30_000);
    const desktop = snd === 'D' || rcv === 'D';
    const relay = p === 'REL';
    const bytes = fixture.totalBytes || 0;
    const connect = relay
        ? desktop
            ? 75_000
            : 60_000
        : desktop
          ? 60_000
          : 45_000;
    const complete =
        expect === 'refusal'
            ? 30_000
            : relay
              ? Math.max(90_000, (bytes / 1e6) * 1000)
              : Math.max(60_000, (bytes / 10e6) * 1000);
    const t = {
        link: linkFor(snd),
        join: linkFor(rcv) + 10_000,
        connect,
        route: 15_000,
        firstBytes: 30_000,
        complete: Math.min(complete, 20 * 60_000),
        exit: 15_000,
        verify: Math.max(120_000, (bytes / 50e6) * 1000),
        teardown: desktop ? 60_000 : 30_000,
    };
    t.hardCap =
        t.link +
        t.join +
        t.connect +
        t.route +
        t.firstBytes +
        t.complete +
        t.exit +
        10_000;
    return t;
}

function buildCell(id, { cliHasRelayOnly }) {
    const parsed = parseCellId(id);
    const { profile, path: p, snd, rcv, variant } = parsed;
    const sender = {
        surface: SURFACE_OF[snd],
        letter: snd,
        role: 'sender',
        relayOnly: false,
        noRelay: false,
        forcer: 'none',
    };
    const receiver = {
        surface: SURFACE_OF[rcv],
        letter: rcv,
        role: 'receiver',
        relayOnly: false,
        noRelay: false,
        forcer: 'none',
        statsOff: true,
        input: 'code',
    };
    const webOnEitherSide = snd === 'W' || rcv === 'W';
    receiver.input =
        webOnEitherSide || (variant && VARIANT_INPUT_LINK.has(variant))
            ? 'link'
            : 'code';
    let forcer = 'none';
    let forcedSide = null;
    let verdict = null;
    let reason = null;
    if (snd === 'D' && rcv === 'D') {
        verdict = 'NA';
        reason = 'single-instance';
    }
    if (p === 'REL' && !verdict) {
        if (snd === 'W') {
            forcer = 'initScript';
            forcedSide = 'sender';
        } else if (rcv === 'W') {
            forcer = 'initScript';
            forcedSide = 'receiver';
        } else if (snd === 'D') {
            forcer = 'hideIP';
            forcedSide = 'sender';
        } else if (rcv === 'D') {
            forcer = 'hideIP';
            forcedSide = 'receiver';
        } else if (cliHasRelayOnly) {
            forcer = 'relayOnlyFlag';
            forcedSide = 'sender';
        } else {
            verdict = 'NA';
            reason = 'no-cli-relay-forcer';
        }
    }
    const flow = requestFlowOf(variant);
    // TA-12: the host's Hide my IP forces the relay; the visitor's context
    // stays unforced, so the host-side relay path is what gets proved.
    if (variant === 'reqhideip' && p === 'REL' && !verdict) {
        forcer = 'hideIP';
        forcedSide = 'receiver';
    }
    // The visitor opens <web>/r/<linkId>#<roomId>; TA-17 keeps its quick
    // cell's own input, since the open link is only a precondition there.
    if (flow && flow !== 'open-link-precondition') receiver.input = 'request-link';
    if (forcedSide === 'sender') {
        sender.relayOnly = true;
        sender.forcer = forcer;
    } else if (forcedSide === 'receiver') {
        receiver.relayOnly = true;
        receiver.forcer = forcer;
    }
    const bothCli =
        (snd === 'C' || snd === 'L') && (rcv === 'C' || rcv === 'L');
    // A CLI-shaped sender that lies is the floe-e2ehost harness, which has no
    // --no-relay: "direct by construction" would claim a flag it never got.
    // Its path is observed instead (the harness route event, D-083), and the
    // real CLI receiver still takes --no-relay.
    const harnessSender = snd === 'C' && Boolean(hashLieOf(variant));
    const byConstruction = p === 'DIR' && bothCli && !harnessSender;
    if (byConstruction) {
        sender.noRelay = true;
        receiver.noRelay = true;
    } else if (p === 'DIR' && bothCli) {
        receiver.noRelay = true;
    }
    const fixture = fixtureSpec(parsed);
    const expect = expectOf(variant);
    const timeouts = phaseTimeouts({ path: p, snd, rcv, expect, fixture });
    const request = flow ? requestSpec(variant, flow) : null;
    if (request && flow !== 'open-link-precondition') {
        // Make link and the prompt: 30 s plus the Accept wait; a blip adds
        // its cut and a reclaim; a decline adds the second visitor.
        timeouts.accept = 30_000 + REQUEST_ACCEPT_WAIT_MS;
        timeouts.hardCap += timeouts.accept;
        if (flow === 'blip-then-accept')
            timeouts.hardCap += REQUEST_BLIP_MS + 60_000;
        if (flow === 'decline-then-accept')
            timeouts.hardCap += timeouts.join + timeouts.connect;
    }
    const cell = {
        id,
        profile,
        infra: profile === 'S' ? 'prod' : 'local',
        path: p,
        variant,
        sender,
        receiver,
        forcer,
        forcedSide,
        byConstruction,
        fixture,
        expect,
        killAtBytes: expect.startsWith('kill') ? KILL_AT_BYTES : null,
        zipDownload: variant === 'zip',
        // null for every cell that does not lie about a digest (P0-27).
        hashLie: hashLieOf(variant),
        // null for every cell that is not a request link cell.
        request,
        timeouts,
        retryable: expect === 'transfer',
        designedSecondAttempt: expect === 'kill-receiver',
        verdict,
        reason,
        note: reason
            ? NA_REASONS[reason] || SKIP_REASONS[reason] || reason
            : null,
        cost: null,
        capabilities: {
            sender: CAPABILITIES[sender.surface],
            receiver: CAPABILITIES[receiver.surface],
        },
    };
    cell.cost = cellCost(cell);
    return cell;
}

/**
 * What a request link cell asks of the runner. Every oracle is from 09
 * 2.7.2; the visitor's stats attempts must be 0 in every one, and the link
 * (with its room fragment) stays inside the run folder.
 */
function requestSpec(variant, flow) {
    if (flow === 'open-link-precondition')
        return {
            flow,
            feature: 'request-1',
            host: 'desktop',
            linkOpen: true,
            loopbackOnly: false,
            oracles: ['quick-cell-oracles', 'link-still-waiting-after'],
        };
    const oracles = [
        'prompt-counts-match-no-relay-warning',
        'sha256-in-drop-subfolder',
        'visitor-arrived-line',
        'visitor-sha-line-only-when-verified-equals-n',
        'desktop-received-n-files',
        'route',
        'desktop-json-proof',
        'visitor-stats-attempts-0',
        'link-used-up-after',
    ];
    if (flow === 'blip-then-accept')
        oracles.push('visitor-not-connected-during-cut', 'host-reconnecting-then-waiting');
    if (flow === 'decline-then-accept')
        oracles.push('visitor-declined-line', 'keep-waiting-reopens', 'second-visitor-delivers');
    // TA-12's over 2 GB prompt line (P6) is not reached from a web visitor:
    // RequestVisitor.tsx probes the route 2 s after its channel opens and
    // blocks a relayed drop over the cap before it sends any metadata, so
    // the host never gets a prompt to read (a spec gap, WP-R2 handback).
    // The cell proves the host-forced relay path and a prompt without P6.
    return {
        flow,
        feature: 'request-1',
        host: 'desktop',
        visitor: 'web',
        visitors: flow === 'decline-then-accept' ? 2 : 1,
        acceptWaitMs: REQUEST_ACCEPT_WAIT_MS,
        blipMs: flow === 'blip-then-accept' ? REQUEST_BLIP_MS : null,
        // TA-13 cuts sockets through a driver-owned proxy in front of the
        // server, which only ever makes sense on this machine (never
        // api.floe.one, OD-33): cellPlan refuses a non-loopback server.
        loopbackOnly: flow === 'blip-then-accept',
        oracles,
    };
}

function skip(cell, reason) {
    if (cell.verdict) return cell;
    cell.verdict = 'SKIP';
    cell.reason = reason;
    cell.note = SKIP_REASONS[reason] || reason;
    return cell;
}

const FOUR_GIB = 4 * 1024 * 1024 * 1024;

/** Apply machine and run gates from the probe record. */
export function gateCell(
    cell,
    { probe = {}, desktopMode = 'auto', profile = 'shipped' } = {}
) {
    if (cell.verdict === 'NA') return cell;
    const p = probe || {};
    // A request cell never runs against a server that is not known to list
    // request-1: an absent or unreadable features field fails closed.
    if (cell.request) {
        const features = p.server?.features;
        if (!Array.isArray(features) || !features.includes(cell.request.feature))
            return skip(cell, 'server-no-request-1');
    }
    // Every request cell has the desktop as its host, TA-17's W2W included.
    const hasDesktop =
        Boolean(cell.request) ||
        cell.sender.surface === 'desktop' ||
        cell.receiver.surface === 'desktop';
    const hasWsl =
        cell.sender.surface === 'wsl' || cell.receiver.surface === 'wsl';
    if (hasDesktop) {
        if (desktopMode === 'none') return skip(cell, 'desktop-none');
        // The host of every request cell is driven through the wailsdev DOM
        // verbs (lib/request.mjs); no other lane can make or answer a link
        // yet, so the cell SKIPs rather than running a lane it cannot drive.
        if (cell.request && desktopMode !== 'wailsdev')
            return skip(cell, 'request-host-uia-pending');
        if (p.desktop?.available === false)
            return skip(cell, 'desktop-unavailable');
        if (profile === 'head' && p.desktop?.headBuild === false)
            return skip(cell, 'head-desktop-pending');
        if (cell.receiver.surface === 'desktop') {
            if (p.desktop?.receiverDrivable === false)
                return skip(cell, 'uia-setvalue');
            if (p.desktop?.saveDirSettable === false)
                return skip(cell, 'desktop-savedir');
        }
        if (p.desktop?.present === true && p.desktop?.focusNeeded === true)
            return skip(cell, 'present');
    }
    if (cell.path === 'REL') {
        const turn = profile === 'head' ? p.turn?.local : p.turn?.prod;
        if (turn && turn.servesTurn === false)
            return skip(
                cell,
                profile === 'head' ? 'local-stun-only' : 'prod-turn-absent'
            );
        if (cell.forcer === 'initScript' && p.browserRelay?.ok === false)
            return skip(cell, 'browser-relay-na');
    }
    if (hasWsl) {
        if (p.wsl?.present === false) return skip(cell, 'wsl-stopped');
        // No firewall gate here: a Block rule on the staged path aborts the
        // whole run as a precondition (audit.mjs), and a missing inbound
        // Allow is not a reason to skip, since an L2 cell's receiver is a
        // Windows program with its own rule and the connection is outbound
        // from this machine either way.
    }
    if (
        ['cap3g', 'thr500', 'killsnd', 'killrcv'].includes(cell.variant) &&
        typeof p.disk?.freeBytes === 'number' &&
        p.disk.freeBytes < FOUR_GIB
    )
        return skip(cell, 'disk-space');
    return cell;
}

/**
 * cellPlan({ profile, subset, probe, caps, cliHasRelayOnly, cells,
 *            desktopMode }) -> cell rows in execution order.
 */
export function cellPlan({
    profile = 'shipped',
    subset = 'default',
    probe = {},
    caps = CAPABILITIES,
    cliHasRelayOnly = false,
    cells = null,
    desktopMode = 'auto',
    server = null,
} = {}) {
    if (!['shipped', 'head'].includes(profile))
        throw new Error(`unknown profile ${profile}`);
    const prefix = profile === 'head' ? 'H-' : 'S-';
    const base =
        subset === 'quick'
            ? QUICK_IDS
            : subset === 'deep'
              ? [...DEFAULT_IDS, ...DEEP_IDS]
              : DEFAULT_IDS;
    const ids = base.map((id) => prefix + id.slice(2));
    // The forced-mismatch cells are never in a default walk: they join the plan
    // only when --cells names one, so a run that did not ask for them cannot
    // fail on a sender that cannot lie yet (P0-27).
    if (cells) {
        for (const id of HASH_IDS) {
            if (matchCells(id, cells) && !ids.includes(id)) ids.push(id);
        }
        // Request cells join the same way. A shipped id joins a shipped
        // run and a head id a head run; a head-only id named in a shipped
        // run joins so that it can SKIP head-only below.
        for (const id of REQUEST_IDS) {
            const own = id.startsWith(prefix) || id.startsWith('H-');
            if (own && matchCells(id, cells) && !ids.includes(id)) ids.push(id);
        }
    }
    const rows = [];
    for (const id of ids) {
        const cell = buildCell(id, { cliHasRelayOnly });
        cell.capabilities = {
            sender: caps[cell.sender.surface],
            receiver: caps[cell.receiver.surface],
        };
        // The operator's --cells filter wins over the machine gates: a cell
        // that was never asked for is `filtered` (uncounted), whatever the
        // probe would have said about it.
        if (cells && !matchCells(id, cells)) skip(cell, 'filtered');
        // A head cell named in a shipped run (only the HASH_IDS can get here)
        // never runs: it would drive production with a sender that lies
        // (P0-27 review F3).
        else if (cell.profile === 'H' && profile !== 'head')
            skip(cell, 'head-only');
        else gateCell(cell, { probe, desktopMode, profile });
        rows.push(cell);
    }
    // TA-13 cuts the host's sockets through a proxy on this machine: a
    // planned blip cell against any server that is not loopback is a usage
    // error before anything is created (never api.floe.one, OD-33). An
    // unknown server is refused as well, so no caller can skip the check.
    for (const cell of rows) {
        if (!cell.request?.loopbackOnly) continue;
        if (cell.verdict === 'SKIP' && ['filtered', 'head-only'].includes(cell.reason))
            continue;
        if (!isLoopbackUrl(server))
            throw new UsageError(
                `${cell.id} runs only against a loopback server (got ${server ?? 'none'}); it cuts sockets through a local proxy and never touches a shared server`
            );
    }
    return rows;
}

export function executable(cell) {
    return !cell.verdict;
}

export function countsForExit(cell) {
    if (cell.verdict === 'NA') return false;
    if (cell.verdict === 'SKIP' && UNCOUNTED_SKIPS.has(cell.reason))
        return false;
    return true;
}

export function describeCell(cell) {
    const snd = `${cell.sender.letter}${cell.sender.relayOnly ? '*' : ''}`;
    const rcv = `${cell.receiver.letter}${cell.receiver.relayOnly ? '*' : ''}`;
    return `${cell.id} ${snd}->${rcv} ${cell.path} ${cell.receiver.input} ${cell.fixture.kind}`;
}
