// Cell catalogue and gating. cellPlan() is pure: it turns a profile, a
// subset, the probe results and the capability table into the rows the
// runner executes, with every gate applied (NA = impossible with the shipped
// product, SKIP = a precondition on this machine or run is unmet). Ids are
// <S|H>-<DIR|REL>-<snd>2<rcv>[-variant] with W web, C CLI, D desktop, L CLI
// inside WSL2. Every receiver leg carries statsOff: true; matrix.test.mjs
// asserts it, and lib/cell.mjs refuses a leg without it.
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
    'infra-down': 'two consecutive infra symptoms against the signaling server',
    'budget-exhausted': 'run-wide retry or byte budget exhausted',
    present: 'user present and the desktop window needs focus',
    'desktop-none': '--desktop none drops desktop cells',
    'desktop-unavailable':
        'no desktop build to drive (probe or preflight failed)',
    'head-desktop-pending': 'HEAD desktop build not available in this run',
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

const VARIANT_INPUT_LINK = new Set(['link', 'zip', 'bnd8', 'fold']);

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
    if (variant === 'killsnd') return 'kill-sender';
    if (variant === 'killrcv') return 'kill-receiver';
    return 'transfer';
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
    if (forcedSide === 'sender') {
        sender.relayOnly = true;
        sender.forcer = forcer;
    } else if (forcedSide === 'receiver') {
        receiver.relayOnly = true;
        receiver.forcer = forcer;
    }
    const bothCli =
        (snd === 'C' || snd === 'L') && (rcv === 'C' || rcv === 'L');
    const byConstruction = p === 'DIR' && bothCli;
    if (byConstruction) {
        sender.noRelay = true;
        receiver.noRelay = true;
    }
    const fixture = fixtureSpec(parsed);
    const expect = expectOf(variant);
    const timeouts = phaseTimeouts({ path: p, snd, rcv, expect, fixture });
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
    const hasDesktop =
        cell.sender.surface === 'desktop' ||
        cell.receiver.surface === 'desktop';
    const hasWsl =
        cell.sender.surface === 'wsl' || cell.receiver.surface === 'wsl';
    if (hasDesktop) {
        if (desktopMode === 'none') return skip(cell, 'desktop-none');
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
        else gateCell(cell, { probe, desktopMode, profile });
        rows.push(cell);
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
