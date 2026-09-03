/**
 * Process wrapper for the CLI legs of the transfer-audit skill: spawn a floe
 * binary from an argv array with no shell, keep a timestamped transcript,
 * split its output into lines the way a terminal shows them, wait for marker
 * lines or the exit, and kill only what this run started.
 *
 * Why the splitter treats a bare \r as a line break: the progress bar
 * (cli/engine/transfer/format.go newProgressBar) redraws in place with \r
 * and only ends the line at 100 percent, so a \n-only splitter would hold
 * the whole bar as one pending fragment until the file finished and every
 * "first progress line" wait would miss. Each redraw becomes its own line
 * here; the transcript file keeps the raw chunks.
 *
 * Why killTree refuses three times: a pid is only a number. The registry
 * says whether this run spawned it and whether it has already exited (an
 * exited entry is never killed, because the number may belong to a stranger
 * by now), tasklist (ps elsewhere) says whether the image behind it is still
 * the binary that was spawned, and the process creation time (Win32_Process
 * CreationDate through PowerShell, `ps -o lstart=` elsewhere) says whether
 * it is the same incarnation, because a pid can be recycled by a same-image
 * process between the spawn and the kill. The image check is copied from
 * floe-run.mjs, which guards its own children the same way. A refusal is a
 * SafetyError so the run can report it as a tripped invariant rather than a
 * failed cell.
 *
 * There is no graceful stop on Windows: taskkill /T /F is the only signal a
 * console-less child receives, so a killed receiver does not run the CLI's
 * Ctrl+C cleanup (main.go AbandonPartials) and may leave a .part file. The
 * CLI adapter reports that through outputs(), which is the point of the
 * killrcv cell.
 *
 * EXIT_MAP and STDERR_CLASSES quote cli/cmd/floe/main.go and the engine's
 * error strings at f14a8d7; each regex names its source line. The shipped
 * 1.10.5 carries the same strings (verified against the binary on PATH).
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PhaseError, SafetyError } from './surfaces.mjs';

const WIN = process.platform === 'win32';
const TAIL_CHARS = 500;
const PS_ARGS = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
];

/**
 * pid -> { image, label, argv, t0, creation, exited }: the only pids
 * killTree will touch. `creation` is filled in asynchronously after the
 * spawn (null until the lookup answers); `exited` is the exit record once
 * the process is gone, and killAllStarted prunes those entries.
 */
export const started = new Map();

/** Argv (no shell) that prints a process creation stamp, or nothing. */
function creationCommand(pid) {
    if (WIN)
        return [
            'powershell.exe',
            [
                ...PS_ARGS,
                `Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${Number(pid)}' | ForEach-Object { $_.CreationDate.ToUniversalTime().ToString('o') }`,
            ],
        ];
    return ['ps', ['-o', 'lstart=', '-p', String(pid)]];
}

function validPid(pid) {
    return Number.isInteger(pid) && pid > 0;
}

/**
 * The creation stamp of a live process (an ISO instant on Windows, the
 * `ps` lstart text elsewhere), or null when the pid is gone or the lookup
 * fails. Synchronous: only killTree and cleanup call it, right before a
 * kill.
 */
export function creationTime(pid) {
    if (!validPid(pid)) return null;
    const [cmd, args] = creationCommand(pid);
    const out = run(cmd, args).trim();
    return out || null;
}

/** creationTime without blocking; spawnFloe and registerPid use it. */
export function creationTimeAsync(pid) {
    return new Promise((resolve) => {
        if (!validPid(pid)) return resolve(null);
        const [cmd, args] = creationCommand(pid);
        execFile(
            cmd,
            args,
            { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
            (err, stdout) =>
                resolve(err ? null : String(stdout || '').trim() || null)
        );
    });
}

/**
 * Register a pid this run caused to exist but did not spawn through
 * spawnFloe (the desktop app, whose window pid comes from find-window).
 * Idempotent for a live entry. `creation` is looked up in the background
 * unless the caller passes one (null included, which skips the lookup).
 */
export function registerPid(
    pid,
    { image, label = 'process', argv = [], t0 = Date.now(), creation } = {}
) {
    if (!validPid(pid) || !image) return null;
    const live = started.get(pid);
    if (live && !live.exited) return live;
    const entry = {
        image: String(image).toLowerCase(),
        label,
        argv,
        t0,
        creation: creation === undefined ? null : creation,
        exited: null,
    };
    started.set(pid, entry);
    if (creation === undefined) fillCreation(pid, entry);
    return entry;
}

function fillCreation(pid, entry) {
    creationTimeAsync(pid).then(
        (c) => {
            if (started.get(pid) === entry && entry.creation === null)
                entry.creation = c;
        },
        () => {}
    );
}

// main.go runUpdate: a cobra error exits 1; main.go runUpdate: Ctrl+C prints
// "  Canceled." on stderr and exits 130.
export const EXIT_MAP = Object.freeze({ 0: 'ok', 1: 'error', 130: 'canceled' });

// [class, regex] in match order; the first hit wins. The first eleven are the
// architecture design's list with each string checked against the source;
// the design's "expected receiver role, got sender" does not exist (the
// receiver's wrong-role message is "this code is no longer active",
// main.go runReceive), so role-race matches the sender's message at main.go runSend.
// The last four are the retry-eligible infra signatures the report design
// names (section 10), added so a cell runner can key on them.
export const STDERR_CLASSES = Object.freeze([
    // cli/engine/transfer/relay.go ErrRelayOverLimit behind cobra's "Error: " prefix.
    [
        'relay-cap-refusal',
        /^Error: transfer blocked: relay connections are capped at 2 GB \(selected /m,
    ],
    // cli/engine/transfer/receiver.go ReceiveFilesWithOptions
    [
        'stall-before-metadata',
        /connected, but no data arrived from the sender within/,
    ],
    // receiver.go ReceiveFilesWithOptions
    ['stall-mid-file', /transfer stalled: no data for/],
    // main.go runSend
    ['role-race', /expected sender role, got "receiver"/],
    // cli/engine/code/client.go Resolve
    ['code-expired', /not found or expired/],
    // main.go runReceive
    ['code-spent', /this code is no longer active/],
    // main.go runSend and runReceive
    ['room-full', /room is full/],
    // receiver.go ReceiveFilesWithOptions
    ['peer-refused', /connection closed before any file arrived/],
    // cli/engine/transfer/sender.go sendFile
    ['ack-timeout', /timed out waiting for ack/],
    // cli/engine/peer/connection.go SetupAsSender
    [
        'connect-timeout',
        /timed out (establishing a connection|waiting for the peer to answer|waiting for the peer's offer)/,
    ],
    // cli/engine/transfer/protocol.go compatErrorMessage
    ['incompatible', /Cannot transfer: /],
    // main.go runSend and runReceive
    ['ice-fetch-failed', /failed to fetch ICE credentials/],
    // main.go runSend and runReceive
    ['signaling-connect-failed', /failed to connect to signaling server/],
    // cli/engine/code/client.go Resolve
    ['code-unreachable', /could not reach signaling server/],
    // main.go runSend
    ['peer-left-early', /peer disconnected before connecting/],
]);

/** Pure: { code, kind, class }. kind is 'killed' for a null code. */
export function classifyExit(code, stderr = '') {
    const kind =
        code === null || code === undefined
            ? 'killed'
            : EXIT_MAP[code] || 'unknown';
    let cls = null;
    for (const [name, re] of STDERR_CLASSES) {
        if (re.test(stderr)) {
            cls = name;
            break;
        }
    }
    return { code: code ?? null, kind, class: cls };
}

/** The first "Error: ..." line on stderr, or the last non-empty line. */
export function firstErrorLine(stderr = '') {
    const lines = stderr.split(/\r?\n/).filter((l) => l.trim());
    return lines.find((l) => /^Error: /.test(l)) || lines.at(-1) || null;
}

/** The last 500 chars of stderr and stdout, the helpers.ts tail() shape. */
export function tail(h) {
    const clip = (s) => s.trim().slice(-TAIL_CHARS);
    let out = '';
    if (h.stderr.trim()) out += `\nstderr: ${clip(h.stderr)}`;
    if (h.stdout.trim()) out += `\nstdout: ${clip(h.stdout)}`;
    return out;
}

function run(cmd, args) {
    try {
        return execFileSync(cmd, args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
            timeout: 30_000,
        });
    } catch {
        return '';
    }
}

/** The executable name behind a pid (lowercase on Windows), or null. */
export function processImage(pid) {
    if (WIN) {
        const out = run('tasklist', [
            '/FI',
            `PID eq ${pid}`,
            '/FO',
            'CSV',
            '/NH',
        ]);
        const match = out.match(/^"([^"]+)"/m);
        return match ? match[1].toLowerCase() : null;
    }
    return run('ps', ['-p', String(pid), '-o', 'comm=']).trim() || null;
}

// What tasklist will report for a binary path. spawn() on Windows resolves a
// bare name through PATH and PATHEXT, so "floe" becomes floe.exe.
export function imageOf(bin) {
    const name = basename(bin).toLowerCase();
    return WIN && !name.includes('.') ? `${name}.exe` : name;
}

function pushLine(h, entry) {
    h.lines.push(entry);
    for (const w of h.waiters) if (w.re && w.re.test(entry.line)) w.hit(entry);
}

function settle(h) {
    for (const w of [...h.waiters]) w.exited(h.exit);
}

/**
 * Spawn one CLI process. Returns a handle:
 *   { proc, pid, argv, t0, lines, stdout, stderr, lastOutputAt, exit,
 *     transcriptPath, waitLine, waitExit, stalledFor, stalled }
 * lines: [{ t, stream: 'out'|'err', line }] split on \r\n, \r or \n.
 * exit: null until the process ends, then { code, signal, error, t }.
 */
export function spawnFloe({
    bin,
    args = [],
    env = process.env,
    cwd,
    label = 'floe',
    evidenceDir,
    stallMs = 60_000,
    // wsl.exe hands the raw command line to the distro's login shell, so
    // the WSL leg pre-quotes one command string and asks for it verbatim.
    verbatim = false,
}) {
    if (!bin) throw new PhaseError('spawn', 'spawnFloe: bin is required');
    if (!evidenceDir)
        throw new PhaseError('spawn', 'spawnFloe: evidenceDir is required');
    mkdirSync(evidenceDir, { recursive: true });
    const t0 = Date.now();
    const transcriptPath = join(evidenceDir, `${label}.transcript.txt`);
    const transcript = createWriteStream(transcriptPath);
    const proc = spawn(bin, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        windowsVerbatimArguments: Boolean(verbatim),
    });
    const h = {
        proc,
        pid: proc.pid ?? null,
        argv: [bin, ...args],
        label,
        t0,
        lines: [],
        stdout: '',
        stderr: '',
        lastOutputAt: t0,
        exit: null,
        transcriptPath,
        stallMs,
        waiters: new Set(),
    };
    const meta = proc.pid
        ? registerPid(proc.pid, {
              image: imageOf(bin),
              label,
              argv: h.argv,
              t0,
          })
        : null;
    const markExited = () => {
        if (meta && started.get(proc.pid) === meta) meta.exited = h.exit;
    };

    const pending = { out: '', err: '' };
    const feed = (stream) => (chunk) => {
        const text = chunk.toString('utf8');
        const now = Date.now();
        h.lastOutputAt = now;
        if (stream === 'out') h.stdout += text;
        else h.stderr += text;
        // helpers.ts captureTranscript format: raw chunk after the stamp.
        transcript.write(`[+${now - t0}ms ${stream}] ${text}`);
        pending[stream] += text;
        const parts = pending[stream].split(/\r\n|\r|\n/);
        pending[stream] = parts.pop();
        for (const line of parts) pushLine(h, { t: now, stream, line });
    };
    const flush = () => {
        for (const stream of ['out', 'err']) {
            if (!pending[stream]) continue;
            pushLine(h, { t: Date.now(), stream, line: pending[stream] });
            pending[stream] = '';
        }
    };
    proc.stdout.on('data', feed('out'));
    proc.stderr.on('data', feed('err'));
    proc.on('error', (err) => {
        flush();
        if (!h.exit) {
            h.exit = {
                code: null,
                signal: null,
                error: String((err && err.message) || err),
                t: Date.now(),
            };
        }
        markExited();
        transcript.end();
        settle(h);
    });
    proc.on('close', (code, signal) => {
        flush();
        if (!h.exit) h.exit = { code, signal, error: null, t: Date.now() };
        markExited();
        transcript.end();
        settle(h);
    });

    const exitedError = (re) => {
        const why = h.exit.error ? `, ${h.exit.error}` : '';
        return new PhaseError(
            'exited',
            `${label}: exited (code ${h.exit.code}${why}) before a line matching ${re}${tail(h)}`,
            { exit: h.exit }
        );
    };

    /**
     * Resolve with the first line entry matching re (already buffered lines
     * count). Rejects PhaseError('timeout') after timeoutMs and
     * PhaseError('exited') when the process ends first; with
     * exitIsError: false an early exit resolves null instead.
     */
    h.waitLine = (re, timeoutMs, { exitIsError = true } = {}) =>
        new Promise((resolve, reject) => {
            const hit = h.lines.find((l) => re.test(l.line));
            if (hit) return resolve(hit);
            if (h.exit) {
                if (exitIsError) return reject(exitedError(re));
                return resolve(null);
            }
            const w = { re };
            const done = () => {
                clearTimeout(timer);
                h.waiters.delete(w);
            };
            const timer = setTimeout(() => {
                done();
                reject(
                    new PhaseError(
                        'timeout',
                        `${label}: no line matching ${re} in ${timeoutMs} ms${tail(h)}`,
                        { timeoutMs }
                    )
                );
            }, timeoutMs);
            w.hit = (entry) => {
                done();
                resolve(entry);
            };
            w.exited = () => {
                done();
                if (exitIsError) reject(exitedError(re));
                else resolve(null);
            };
            h.waiters.add(w);
        });

    /** Resolve with the exit record, or null after timeoutMs. Never kills. */
    h.waitExit = (timeoutMs) =>
        new Promise((resolve) => {
            if (h.exit) return resolve(h.exit);
            const w = { re: null, hit: () => {} };
            const timer = setTimeout(() => {
                h.waiters.delete(w);
                resolve(null);
            }, timeoutMs);
            w.exited = (exit) => {
                clearTimeout(timer);
                h.waiters.delete(w);
                resolve(exit);
            };
            h.waiters.add(w);
        });

    h.stalledFor = () => Date.now() - h.lastOutputAt;
    h.stalled = () => h.exit === null && h.stalledFor() > stallMs;
    return h;
}

/**
 * Kill a process tree this run started. Throws SafetyError for a pid the
 * registry does not know, whose image no longer matches, or whose creation
 * time differs from the one recorded at spawn; returns { killed: false }
 * when the registry already saw it exit or the pid is gone.
 */
export function killTree(
    pid,
    { exec = execFileSync, image: imageOfPid = processImage } = {}
) {
    const meta = started.get(pid);
    if (!meta) {
        throw new SafetyError(
            `refusing to kill pid ${pid}: not started by this run`,
            { pid }
        );
    }
    if (meta.exited) return { killed: false, reason: 'exited before the kill' };
    const image = imageOfPid(pid);
    if (!image) return { killed: false, reason: 'already gone' };
    if (image !== meta.image) {
        throw new SafetyError(
            `refusing to kill pid ${pid}: image ${image} is not the ${meta.image} this run started (${meta.label})`,
            { pid, image, expected: meta.image }
        );
    }
    if (meta.creation) {
        const now = creationTime(pid);
        if (now && now !== meta.creation) {
            throw new SafetyError(
                `refusing to kill pid ${pid}: created at ${now}, not the ${meta.creation} this run recorded (${meta.label}); the pid was recycled`,
                { pid, image, creation: now, expected: meta.creation }
            );
        }
    }
    if (WIN) {
        try {
            exec('taskkill', ['/PID', String(pid), '/T', '/F'], {
                stdio: 'ignore',
                windowsHide: true,
            });
        } catch (e) {
            // taskkill exits 128 ("The process ... not found") for a pid
            // that ended between the image check and the kill; the victim
            // is dead either way. Anything else stays an error.
            if (!imageOfPid(pid))
                return { killed: false, reason: 'exited during the kill' };
            throw e;
        }
    } else {
        try {
            process.kill(pid, 'SIGINT');
        } catch {
            // Gone between the image check and the signal.
        }
        setTimeout(() => {
            // Re-check before the hard kill: the pid may have been recycled
            // in the five seconds since SIGINT.
            if (meta.exited || imageOfPid(pid) !== meta.image) return;
            try {
                process.kill(pid, 'SIGKILL');
            } catch {
                // Exited on SIGINT, which is the hoped-for path.
            }
        }, 5000).unref();
    }
    return { killed: true, image };
}

/**
 * killTree over every registered pid that is still alive; entries the
 * registry already saw exit are pruned, not killed. Never throws.
 */
export function killAllStarted() {
    const results = [];
    for (const [pid, meta] of [...started]) {
        if (meta.exited) {
            started.delete(pid);
            continue;
        }
        try {
            results.push({ pid, ...killTree(pid) });
        } catch (err) {
            results.push({ pid, killed: false, refused: err.message });
        }
    }
    return results;
}

/**
 * Run onTeardown(signal) once on SIGINT, SIGTERM or SIGHUP, then exit 130.
 * Returns a function that removes the handlers.
 */
export function installSignalTeardown(onTeardown, { exitCode = 130 } = {}) {
    const installed = [];
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        const fn = async () => {
            try {
                await onTeardown(sig);
            } catch {
                // Teardown is best effort; the exit code says interrupted.
            }
            process.exit(exitCode);
        };
        process.once(sig, fn);
        installed.push([sig, fn]);
    }
    return () => {
        for (const [sig, fn] of installed) process.removeListener(sig, fn);
    };
}
