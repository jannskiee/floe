// Launch a process that holds no foreground rights (FU-26, from the FU-02
// addendum). Every process the audit spawns descends from the operator's
// terminal, and while that terminal is the foreground window Windows lets a
// process it started take the foreground with its first window: a test exe
// launched that way pulled the foreground off the owner's terminal twice
// (2026-09-30 23:20). Win32_Process.Create makes the WMI provider host the
// parent instead, so the new process has no foreground rights to use, and
// its first window is shown SW_SHOWNOACTIVATE besides.
//
// The launch runs in a hidden powershell.exe (-EncodedCommand), and the
// spec (the command line, the folder, the environment) rides an environment
// variable of that one process, base64 JSON, never a command line or a log
// line. What a detached launch gives up: stdin, stdout and stderr pipes (the
// new process is not our child) and an exit event; the pid is what the
// caller tracks.

import { execFile } from 'node:child_process';

/** ShowWindow values for Win32_ProcessStartup (winuser.h). */
export const SW = Object.freeze({
    HIDE: 0,
    SHOWNORMAL: 1,
    SHOWNOACTIVATE: 4,
});

/** Win32_Process.Create's documented return values. */
export const CREATE_RESULTS = Object.freeze({
    0: 'success',
    2: 'access denied',
    3: 'insufficient privilege',
    8: 'unknown failure',
    9: 'path not found',
    21: 'invalid parameter',
});

export const SPEC_VAR = 'FLOE_DETACHED_SPEC';
const LAUNCH_TIMEOUT_MS = 30_000;

/**
 * One argument quoted the way CommandLineToArgvW and the MSVC runtime read
 * it back: bare when it has no space, tab or quote; otherwise in quotes,
 * with a backslash run doubled before a quote and at the end.
 */
export function quoteArg(arg) {
    const s = String(arg);
    if (s !== '' && !/[\s"]/.test(s)) return s;
    let out = '"';
    let slashes = 0;
    for (const ch of s) {
        if (ch === '\\') {
            slashes += 1;
            continue;
        }
        if (ch === '"') {
            out += '\\'.repeat(slashes * 2 + 1) + '"';
        } else {
            out += '\\'.repeat(slashes) + ch;
        }
        slashes = 0;
    }
    return out + '\\'.repeat(slashes * 2) + '"';
}

/** The whole command line for CreateProcess: the program, then its args. */
export function commandLine(command, args = []) {
    return [command, ...args].map(quoteArg).join(' ');
}

/**
 * An environment object as Win32_ProcessStartup.EnvironmentVariables wants
 * it: NAME=value strings. Names that are empty or start with "=" (the
 * per-drive current folders) and values that are null or undefined are
 * left out.
 */
export function envList(env) {
    const out = [];
    for (const [k, v] of Object.entries(env)) {
        if (!k || k.startsWith('=') || v === undefined || v === null) continue;
        out.push(`${k}=${v}`);
    }
    return out;
}

/**
 * The spec the PowerShell side reads. env null means the new process gets
 * the user's own default environment (what WMI builds for the caller), not
 * this process's. An env object REPLACES the whole environment (measured,
 * FU-26: two variables in, a process with exactly two and no PATH or
 * SystemRoot), so a caller passes every variable it wants the process to
 * have, as planLaunch's env for a redirected launch already is.
 * rawCommandLine is used verbatim instead of command and args: cmd.exe does
 * not read its /c string by the CommandLineToArgvW rules (logWrapped).
 */
export function detachedSpec({
    command,
    args = [],
    rawCommandLine = null,
    cwd = null,
    env = null,
    show = SW.SHOWNOACTIVATE,
}) {
    if (!command && !rawCommandLine) throw new Error('detached launch: a command is required');
    if (!Object.values(SW).includes(show))
        throw new Error(`detached launch: show ${show} is not one of ${Object.values(SW).join(', ')}`);
    return {
        commandLine: rawCommandLine ?? commandLine(command, args),
        cwd: cwd ? String(cwd) : null,
        env: env ? envList(env) : null,
        show,
    };
}

// cmd.exe reads & | < > ^ % and quotes itself, so a logged launch refuses
// any token that carries one rather than escape it.
const CMD_META = /[&|<>^%"\r\n]/;

/**
 * A console command (wails dev) that keeps its output: a hidden cmd.exe runs
 * it and appends its stdout and stderr to logFile. Returns the
 * rawCommandLine and SW.HIDE for detachedSpec; the console is created
 * hidden, and the command's own children share it.
 */
export function logWrapped(command, args, logFile) {
    for (const t of [command, ...args, logFile]) {
        if (CMD_META.test(String(t)))
            throw new Error(`detached launch: ${JSON.stringify(String(t))} has a character cmd.exe would read (& | < > ^ % or a quote)`);
    }
    const tok = (t) => (t === '' || /[\s()]/.test(t) ? `"${t}"` : t);
    const inner = `${[command, ...args].map(String).map(tok).join(' ')} >> "${logFile}" 2>&1`;
    return { rawCommandLine: `cmd.exe /d /s /c "${inner}"`, show: SW.HIDE };
}

/** The PowerShell side: reads the spec from SPEC_VAR, prints one JSON line. */
export const DETACHED_PS = [
    "$ErrorActionPreference = 'Stop'",
    `$raw = $env:${SPEC_VAR}`,
    "if (-not $raw) { throw 'the detached launch spec is empty' }",
    '$spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($raw)) | ConvertFrom-Json',
    "$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()",
    '$startup.ShowWindow = [uint16]$spec.show',
    'if ($null -ne $spec.env) { $startup.EnvironmentVariables = [string[]]@($spec.env) }',
    '$cwd = $null',
    'if ($spec.cwd) { $cwd = [string]$spec.cwd }',
    "$r = ([wmiclass]'Win32_Process').Create([string]$spec.commandLine, $cwd, $startup)",
    "[Console]::Out.Write(('{{\"returnValue\":{0},\"pid\":{1}}}' -f [int]$r.ReturnValue, [int]$r.ProcessId))",
].join('\n');

/** The powershell.exe arguments: no profile, the script encoded. */
export function detachedArgs() {
    return [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(DETACHED_PS, 'utf16le').toString('base64'),
    ];
}

/** { returnValue, pid } from the PowerShell side's stdout, or null. */
export function parseDetachedOutput(text) {
    const m = /\{"returnValue":(-?\d+),"pid":(\d+)\}/.exec(String(text || ''));
    return m ? { returnValue: Number(m[1]), pid: Number(m[2]) } : null;
}

/**
 * Start the spec's process without foreground rights. Resolves { pid }; a
 * refused create or an unreadable answer rejects with the reason, never the
 * spec. execFileImpl is injectable so tests never start anything.
 */
export function launchDetached(
    options,
    { execFileImpl = execFile, timeoutMs = LAUNCH_TIMEOUT_MS, baseEnv = process.env } = {}
) {
    const spec = detachedSpec(options);
    const encoded = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
    return new Promise((resolve, reject) => {
        const child = execFileImpl(
            'powershell.exe',
            detachedArgs(),
            {
                encoding: 'utf8',
                windowsHide: true,
                timeout: timeoutMs,
                env: { ...baseEnv, [SPEC_VAR]: encoded },
            },
            (err, stdout) => {
                const out = parseDetachedOutput(stdout);
                if (!out) {
                    const why = err ? err.message.split('\n')[0] : 'no answer';
                    reject(new Error(`detached launch: Win32_Process.Create gave no answer (${why})`));
                    return;
                }
                if (out.returnValue !== 0) {
                    const name = CREATE_RESULTS[out.returnValue] ?? 'unlisted';
                    reject(
                        new Error(`detached launch: Win32_Process.Create returned ${out.returnValue} (${name})`)
                    );
                    return;
                }
                resolve({ pid: out.pid });
            }
        );
        if (child && typeof child.on === 'function') child.on('error', () => {});
    });
}
