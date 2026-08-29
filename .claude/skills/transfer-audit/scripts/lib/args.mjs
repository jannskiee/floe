// Argument parsing for audit.mjs. Pure apart from the injected `fs` probe:
// every usage error is thrown as UsageError and the entry point turns it
// into exit 2 with the message on stderr and nothing on stdout.
import os from 'node:os';
import path from 'node:path';

export class UsageError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UsageError';
        this.exitCode = 2;
    }
}

export const SUBCOMMANDS = Object.freeze([
    'run',
    'probe',
    'versions',
    'cleanup',
]);
export const PROFILES = Object.freeze(['shipped', 'head']);
export const DESKTOP_MODES = Object.freeze([
    'auto',
    'store',
    'portable',
    'wailsdev',
    'none',
]);
export const DEFAULT_PAUSE_MAX_MIN = 10;
const SHA = /^[0-9a-f]{7,40}$/i;

// flag -> { value: takes a value, cmds: subcommands that accept it }.
const ALL = SUBCOMMANDS;
export const FLAGS = Object.freeze({
    '--json': { value: false, cmds: ALL },
    '--root': { value: true, cmds: ALL },
    '--out': { value: true, cmds: ALL },
    '--client-dir': { value: true, cmds: ALL },
    '--profile': { value: true, cmds: ['run', 'probe', 'versions'] },
    '--quick': { value: false, cmds: ['run'] },
    '--deep': { value: false, cmds: ['run'] },
    '--cells': { value: true, cmds: ['run'] },
    '--desktop': { value: true, cmds: ['run', 'probe', 'versions', 'cleanup'] },
    '--bin-dir': { value: true, cmds: ['run', 'probe', 'versions', 'cleanup'] },
    '--pin': { value: false, cmds: ['run', 'versions'] },
    '--strict': { value: false, cmds: ['run'] },
    '--pion-trace': { value: false, cmds: ['run'] },
    '--user-away': { value: false, cmds: ['run', 'probe'] },
    '--pause-max': { value: true, cmds: ['run', 'probe'] },
    '--web-sha': { value: true, cmds: ['run', 'probe', 'versions'] },
    '--web-sha-file': { value: true, cmds: ['run', 'probe', 'versions'] },
    '--server-sha': { value: true, cmds: ['run', 'probe', 'versions'] },
    '--keep': { value: false, cmds: ['run', 'cleanup'] },
    '--keep-data': { value: false, cmds: ['run'] },
    '--monitor': { value: true, cmds: ['run', 'probe'] },
    '--dry-run': { value: false, cmds: ['run'] },
    '--relaxed': { value: false, cmds: ['run', 'probe'] },
    '--run': { value: true, cmds: ['cleanup'] },
    '--last': { value: false, cmds: ['cleanup'] },
});

export const USAGE = `usage: node audit.mjs <run | probe | versions | cleanup> [flags]
       node audit.mjs --self-test

run       [--profile shipped|head] [--quick | --deep] [--cells <id-or-glob,...>]
          [--desktop auto|store|portable|wailsdev|none] [--bin-dir <dir>] [--pin]
          [--strict] [--pion-trace] [--user-away] [--pause-max <min>]
          [--web-sha <sha> | --web-sha-file <json>] [--server-sha <sha>]
          [--keep] [--keep-data] [--monitor secondary|primary|off|<n>]
          [--dry-run] [--relaxed]
probe     [--profile ...] [--desktop ...] [--bin-dir <dir>] [--user-away]
          [--pause-max <min>] [--web-sha ...] [--server-sha <sha>] [--relaxed]
versions  [--web-sha <sha> | --web-sha-file <json>] [--server-sha <sha>]
          [--desktop ...] [--bin-dir <dir>] [--pin]
cleanup   [--run <id> | --last] [--keep] [--desktop ...] [--bin-dir <dir>]
common    [--root <dir>] [--client-dir <dir>] [--out <dir>] [--json]
          (accepted on every subcommand, so one flag set can be reused)

Exit: 0 clean; 1 any FAIL (or FLAKY under --strict); 2 usage; 3 precondition
or mid-run infra abort; 4 safety invariant tripped; 5 partial (SKIP, FLAKY
or harness ERROR, no FAIL); 6 version drift only; 130 interrupted.
versions exits 0 or 6, probe 0 or 3, cleanup 0 or 1.`;

export function defaultOut() {
    return path.join(os.tmpdir(), 'lta-runs');
}

export function parseCellPatterns(text) {
    const list = String(text)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (!list.length) throw new UsageError('--cells needs at least one id');
    for (const p of list) {
        if (!/^[A-Za-z0-9*?_-]+$/.test(p))
            throw new UsageError(
                `--cells pattern ${JSON.stringify(p)} may only use letters, digits, - _ * ?`
            );
    }
    return list;
}

/**
 * parseArgs(argv, { defaultRoot, fs }) -> { cmd, opts }.
 * cmd is one of the subcommands, 'self-test' or 'help'. `fs` needs
 * existsSync and statSync (injected so tests can fake a checkout).
 */
export function parseArgs(argv, { defaultRoot, fs } = {}) {
    if (argv.includes('--self-test')) return { cmd: 'self-test', opts: {} };
    if (!argv.length || argv[0] === '--help' || argv[0] === '-h')
        return { cmd: 'help', opts: {} };
    const cmd = argv[0];
    if (!SUBCOMMANDS.includes(cmd)) {
        if (cmd.startsWith('--'))
            throw new UsageError(
                `a subcommand comes first (${SUBCOMMANDS.join(' | ')}), got ${cmd}`
            );
        throw new UsageError(
            `unknown subcommand ${cmd} (want ${SUBCOMMANDS.join(' | ')})`
        );
    }
    const opts = {
        json: false,
        root: defaultRoot || null,
        clientDir: null,
        out: defaultOut(),
        profile: 'shipped',
        // Whether --profile was given; the first line of run and probe says
        // "shipped (default)" when it was not, because the default drives
        // production floe.one and api.floe.one.
        profileGiven: false,
        quick: false,
        deep: false,
        subset: 'default',
        cells: null,
        desktop: 'auto',
        binDir: null,
        pin: false,
        strict: false,
        pionTrace: false,
        userAway: false,
        pauseMaxMin: DEFAULT_PAUSE_MAX_MIN,
        webSha: null,
        webShaFile: null,
        serverSha: null,
        keep: false,
        keepData: false,
        monitor: 'secondary',
        dryRun: false,
        relaxed: false,
        run: null,
        last: false,
    };
    const seen = new Set();
    for (let i = 1; i < argv.length; i++) {
        const flag = argv[i];
        const spec = FLAGS[flag];
        if (!spec)
            throw new UsageError(
                `unknown flag ${flag} (see node audit.mjs --help)`
            );
        if (!spec.cmds.includes(cmd))
            throw new UsageError(`${flag} does not apply to ${cmd}`);
        if (seen.has(flag)) throw new UsageError(`${flag} given twice`);
        seen.add(flag);
        let value = true;
        if (spec.value) {
            value = argv[++i];
            if (value === undefined || value.startsWith('--'))
                throw new UsageError(`${flag} needs a value`);
        }
        switch (flag) {
            case '--json':
                opts.json = true;
                break;
            case '--root':
                opts.root = value;
                break;
            case '--out':
                opts.out = value;
                break;
            case '--client-dir':
                opts.clientDir = value;
                break;
            case '--profile':
                if (!PROFILES.includes(value))
                    throw new UsageError(
                        `--profile wants ${PROFILES.join(' or ')}, got ${value}`
                    );
                opts.profile = value;
                break;
            case '--quick':
                opts.quick = true;
                break;
            case '--deep':
                opts.deep = true;
                break;
            case '--cells':
                opts.cells = parseCellPatterns(value);
                break;
            case '--desktop':
                if (!DESKTOP_MODES.includes(value))
                    throw new UsageError(
                        `--desktop wants ${DESKTOP_MODES.join(' | ')}, got ${value}`
                    );
                opts.desktop = value;
                break;
            case '--bin-dir':
                opts.binDir = value;
                break;
            case '--pin':
                opts.pin = true;
                break;
            case '--strict':
                opts.strict = true;
                break;
            case '--pion-trace':
                opts.pionTrace = true;
                break;
            case '--user-away':
                opts.userAway = true;
                break;
            case '--pause-max': {
                const n = Number(value);
                if (!Number.isFinite(n) || n <= 0 || n > 240)
                    throw new UsageError(
                        `--pause-max wants minutes between 1 and 240, got ${value}`
                    );
                opts.pauseMaxMin = n;
                break;
            }
            case '--web-sha':
                if (!SHA.test(value))
                    throw new UsageError(
                        `--web-sha wants a 7 to 40 hex sha, got ${value}`
                    );
                opts.webSha = value.toLowerCase();
                break;
            case '--web-sha-file':
                opts.webShaFile = value;
                break;
            case '--server-sha':
                if (!SHA.test(value))
                    throw new UsageError(
                        `--server-sha wants a 7 to 40 hex sha, got ${value}`
                    );
                opts.serverSha = value.toLowerCase();
                break;
            case '--keep':
                opts.keep = true;
                break;
            case '--keep-data':
                opts.keepData = true;
                break;
            case '--monitor':
                if (!/^(secondary|primary|off|[1-9][0-9]*)$/.test(value))
                    throw new UsageError(
                        `--monitor wants secondary, primary, off or a 1-based index, got ${value}`
                    );
                opts.monitor = value;
                break;
            case '--dry-run':
                opts.dryRun = true;
                break;
            case '--relaxed':
                opts.relaxed = true;
                break;
            case '--run':
                if (!/^[A-Za-z0-9_-]+$/.test(value))
                    throw new UsageError(`--run wants a run id, got ${value}`);
                opts.run = value;
                break;
            case '--last':
                // The newest run under --out is the default anyway; the
                // flag says so out loud in a transcript.
                opts.last = true;
                break;
            default:
                throw new UsageError(`unhandled flag ${flag}`);
        }
    }
    opts.profileGiven = seen.has('--profile');
    if (opts.quick && opts.deep)
        throw new UsageError('--quick and --deep are exclusive');
    opts.subset = opts.quick ? 'quick' : opts.deep ? 'deep' : 'default';
    if (opts.webSha && opts.webShaFile)
        throw new UsageError('--web-sha and --web-sha-file are exclusive');
    if (opts.run && opts.last)
        throw new UsageError('--run and --last are exclusive');
    if (opts.relaxed && opts.profile !== 'head')
        throw new UsageError(
            '--relaxed only applies to --profile head (production limiters are never relaxed)'
        );
    if (!opts.root) throw new UsageError('no --root and no default root');
    opts.root = path.resolve(opts.root);
    opts.out = path.resolve(opts.out);
    opts.clientDir = path.resolve(
        opts.clientDir || path.join(opts.root, 'client')
    );
    if (opts.binDir) opts.binDir = path.resolve(opts.binDir);
    if (opts.webShaFile) opts.webShaFile = path.resolve(opts.webShaFile);
    if (fs) {
        if (!fs.existsSync(path.join(opts.root, 'CLAUDE.md')))
            throw new UsageError(
                `--root ${opts.root} does not look like a Floe checkout (no CLAUDE.md)`
            );
        if (
            (cmd === 'run' || cmd === 'probe') &&
            !fs.existsSync(path.join(opts.clientDir, 'package.json'))
        )
            throw new UsageError(
                `--client-dir ${opts.clientDir} has no package.json`
            );
        const st = fs.statSync(opts.out, { throwIfNoEntry: false });
        if (st && !st.isDirectory())
            throw new UsageError(
                `--out ${opts.out} is a file, not a directory`
            );
        if (opts.webShaFile && !fs.existsSync(opts.webShaFile))
            throw new UsageError(
                `--web-sha-file ${opts.webShaFile} does not exist`
            );
    }
    return { cmd, opts };
}
