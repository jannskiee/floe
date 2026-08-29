// Node side of the transfer-audit desktop helper protocol. UiaClient spawns
// scripts/desktop-uia.ps1 -Serve (PowerShell 5.1, Windows UI Automation) and
// exchanges one JSON object per line with it: requests carry an id and a cmd,
// responses echo the id with ok:true plus the command's fields, or ok:false
// with a reason and a detail. The helper answers strictly in order, so the
// client keeps a pending map keyed by id, times each command out on its own
// clock, and treats a response for an unknown id (a late answer to a request
// that already timed out) as a log line rather than an error.
//
// Nothing here launches Floe. lib/desktop.mjs owns the launch; this module
// only knows how to talk to the helper. The script path is resolved relative
// to this file (scripts/lib/uia.mjs -> scripts/desktop-uia.ps1) so the skill
// directory can be renamed or moved without touching either side.
//
// Every command is provider-side UIA or a focus-free Win32 call; see the
// header of desktop-uia.ps1 for the command table, reasons and INFERRED items.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** scripts/desktop-uia.ps1, next to lib/. */
export const SCRIPT_PATH = path.resolve(HERE, '..', 'desktop-uia.ps1');

export const POWERSHELL = 'powershell.exe';

/**
 * Argv for the helper; -Serve is the JSON line mode. With a root the
 * helper refuses any capture path outside that directory.
 */
export function powershellArgs(script = SCRIPT_PATH, { root = null } = {}) {
    const args = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-Serve',
    ];
    if (root) args.push('-Root', String(root));
    return args;
}

/** Every command the helper understands (mirrors $COMMANDS in the .ps1). */
export const COMMANDS = Object.freeze([
    'ping',
    'find-window',
    'wait-tree',
    'snapshot',
    'click',
    'set-value',
    'get-value',
    'read-text',
    'capture',
    'show',
    'close',
    'foreground-check',
    'list-monitors',
    'move-window',
    'exe-version',
    'stage',
    'quit',
]);

// Node-side timeouts. Commands that take a timeoutMs of their own get that
// plus SLACK_MS, so the helper's own not-found or timeout answer wins the
// race and the client never abandons a command the helper is about to end.
export const SLACK_MS = 5_000;
export const HELPER_TIMEOUT_DEFAULTS = Object.freeze({
    'find-window': 30_000,
    'wait-tree': 20_000,
    click: 5_000,
    'set-value': 5_000,
    'get-value': 5_000,
});
export const FIXED_TIMEOUTS = Object.freeze({
    ping: 10_000,
    snapshot: 30_000,
    'read-text': 20_000,
    capture: 20_000,
    show: 5_000,
    close: 5_000,
    'foreground-check': 5_000,
    'exe-version': 10_000,
    stage: 10_000,
    quit: 5_000,
});
/** Reasons worth a second try: transient tree states and slow first reads. */
export const RETRYABLE = Object.freeze([
    'not-found',
    'timeout',
    'exception',
    'printwindow-failed',
]);
/** Add-Type compiles the P/Invoke surface on the first run; allow for it. */
export const READY_TIMEOUT_MS = 30_000;

export class UiaError extends Error {
    constructor(reason, detail = '', extra = {}) {
        super(detail ? `${reason}: ${detail}` : reason);
        this.name = 'UiaError';
        this.reason = reason;
        this.detail = detail;
        Object.assign(this, extra);
    }
}

/** Node-side timeout for a command given its params. */
export function timeoutFor(cmd, params = {}, overrides = {}) {
    if (overrides[cmd]) return overrides[cmd];
    if (cmd in HELPER_TIMEOUT_DEFAULTS) {
        const asked = Number(params.timeoutMs);
        // A non-numeric timeoutMs would make setTimeout fire after 1 ms.
        const helper =
            Number.isFinite(asked) && asked >= 0
                ? asked
                : HELPER_TIMEOUT_DEFAULTS[cmd];
        return helper + SLACK_MS;
    }
    return FIXED_TIMEOUTS[cmd] ?? 15_000;
}

/** One request line (no newline). id and cmd win over params of the same name. */
export function frameRequest(id, cmd, params = {}) {
    const body = {};
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined) continue;
        body[key] = value;
    }
    return JSON.stringify({ ...body, id, cmd });
}

/**
 * Parse one response line. Returns null for blank lines and
 * { parseError, raw } for lines that are not JSON (the helper never prints
 * those, but PowerShell can when Add-Type fails before -Serve starts).
 */
export function parseResponseLine(line) {
    const text = String(line).replace(/\r$/, '').trim();
    if (!text) return null;
    try {
        const obj = JSON.parse(text);
        if (!obj || typeof obj !== 'object')
            return { parseError: 'not an object', raw: text };
        return obj;
    } catch (err) {
        return { parseError: err.message, raw: text };
    }
}

/** Turn a RegExp or string into the helper's { regex, ignoreCase } pair. */
export function regexParams(re) {
    if (re instanceof RegExp)
        return { regex: re.source, ignoreCase: re.flags.includes('i') };
    return { regex: String(re), ignoreCase: true };
}

export class UiaClient {
    /**
     * opts.script    path to desktop-uia.ps1 (default SCRIPT_PATH)
     * opts.command   executable (default powershell.exe); tests pass node
     * opts.args      argv override (default powershellArgs(script))
     * opts.logPath   append every line both ways here (uia.log in evidence)
     * opts.log       function(line) for the same stream
     * opts.timeouts  { [cmd]: ms } Node-side overrides
     * opts.root      directory every capture path must sit under (-Root)
     */
    constructor(opts = {}) {
        this.script = opts.script ?? SCRIPT_PATH;
        this.command = opts.command ?? POWERSHELL;
        this.root = opts.root ?? null;
        this.args =
            opts.args ?? powershellArgs(this.script, { root: this.root });
        this.logPath = opts.logPath ?? null;
        this.logFn = typeof opts.log === 'function' ? opts.log : null;
        this.timeouts = opts.timeouts ?? {};
        this.proc = null;
        this.pid = null;
        this.pending = new Map();
        this.nextId = 1;
        this.exit = null;
        this.ready = null;
        this.stderr = '';
        this.late = [];
        this._buf = '';
    }

    get alive() {
        return Boolean(this.proc) && this.exit === null;
    }

    log(line) {
        const stamped = `[${new Date().toISOString()}] ${line}`;
        if (this.logFn) this.logFn(stamped);
        if (this.logPath) {
            try {
                appendFileSync(this.logPath, stamped + '\n');
            } catch {
                // Evidence dir gone; the run still has the in-memory stream.
            }
        }
    }

    /** Spawn the helper and wait for its ready notice. */
    async open() {
        if (this.proc) return this;
        if (this.command === POWERSHELL && !existsSync(this.script)) {
            throw new UiaError('script-missing', this.script);
        }
        const proc = spawn(this.command, this.args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            shell: false,
        });
        this.proc = proc;
        this.pid = proc.pid ?? null;
        this.log(
            `spawn ${this.command} ${this.args.join(' ')} pid=${this.pid}`
        );
        proc.stdout.setEncoding('utf8');
        proc.stderr.setEncoding('utf8');
        proc.stdout.on('data', (chunk) => this._onStdout(chunk));
        proc.stderr.on('data', (chunk) => {
            this.stderr += chunk;
            this.log(`stderr ${chunk.trimEnd()}`);
        });
        const readyPromise = new Promise((resolve, reject) => {
            this.ready = { resolve, reject };
        });
        proc.on('error', (err) =>
            this._onExit({ code: null, signal: null, error: err.message })
        );
        proc.on('close', (code, signal) =>
            this._onExit({ code, signal, error: null })
        );
        let timer;
        try {
            await Promise.race([
                readyPromise,
                new Promise((_, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new UiaError(
                                    'ready-timeout',
                                    `no ready line in ${READY_TIMEOUT_MS} ms${this.stderr ? `; stderr: ${this.stderr.trim()}` : ''}`
                                )
                            ),
                        READY_TIMEOUT_MS
                    );
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
        return this;
    }

    _onStdout(chunk) {
        this._buf += chunk;
        const parts = this._buf.split('\n');
        this._buf = parts.pop();
        for (const raw of parts) {
            const msg = parseResponseLine(raw);
            if (msg === null) continue;
            this.log(`recv ${raw.trimEnd()}`);
            if (msg.parseError) continue;
            if (msg.id === null || msg.id === undefined) {
                if (msg.ready && this.ready) {
                    this.ready.resolve(msg);
                    this.ready = null;
                }
                continue;
            }
            const entry = this.pending.get(msg.id);
            if (!entry) {
                this.late.push(msg);
                continue;
            }
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            if (msg.ok) entry.resolve(msg);
            else
                entry.reject(
                    new UiaError(msg.reason ?? 'error', msg.detail ?? '', {
                        cmd: entry.cmd,
                        params: entry.params,
                        ms: msg.ms,
                    })
                );
        }
    }

    _onExit(exit) {
        if (this.exit) return;
        this.exit = { ...exit, t: Date.now() };
        this.log(
            `exit code=${exit.code} signal=${exit.signal} error=${exit.error}`
        );
        if (this.ready) {
            this.ready.reject(
                new UiaError(
                    'helper-exited',
                    `code ${exit.code}${exit.error ? `, ${exit.error}` : ''}${this.stderr ? `; stderr: ${this.stderr.trim()}` : ''}`
                )
            );
            this.ready = null;
        }
        for (const [id, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(
                new UiaError(
                    'helper-exited',
                    `while waiting for ${entry.cmd} (id ${id})`,
                    {
                        cmd: entry.cmd,
                        exit: this.exit,
                    }
                )
            );
        }
        this.pending.clear();
    }

    /** Send one command; resolves with the response object (ok:true). */
    request(cmd, params = {}, { timeoutMs } = {}) {
        // Fakes may define extra commands; the real helper may not.
        if (this.command === POWERSHELL && !COMMANDS.includes(cmd)) {
            return Promise.reject(new UiaError('unknown-cmd', cmd));
        }
        if (!this.alive) {
            return Promise.reject(
                new UiaError(
                    'not-open',
                    this.proc ? 'helper has exited' : 'call open() first'
                )
            );
        }
        const id = this.nextId++;
        const line = frameRequest(id, cmd, params);
        const limit = timeoutMs ?? timeoutFor(cmd, params, this.timeouts);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(
                    new UiaError(
                        'timeout',
                        `${cmd} (id ${id}) took longer than ${limit} ms`,
                        {
                            cmd,
                            params,
                            timeoutMs: limit,
                        }
                    )
                );
            }, limit);
            this.pending.set(id, { cmd, params, resolve, reject, timer });
            this.log(`send ${line}`);
            this.proc.stdin.write(line + '\n', (err) => {
                if (!err) return;
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new UiaError('write-failed', err.message, { cmd }));
            });
        });
    }

    /**
     * request() with retries on RETRYABLE reasons (or opts.retryOn). A
     * deterministic refusal (ambiguous, read-only, disabled, no-pattern,
     * bad-request) is never retried.
     */
    async retry(cmd, params = {}, opts = {}) {
        const attempts = Math.max(1, opts.attempts ?? 3);
        const delayMs = opts.delayMs ?? 500;
        const retryOn = opts.retryOn ?? RETRYABLE;
        let last;
        for (let i = 1; i <= attempts; i++) {
            try {
                return await this.request(cmd, params, {
                    timeoutMs: opts.timeoutMs,
                });
            } catch (err) {
                last = err;
                const reason = err && err.reason;
                if (!retryOn.includes(reason) || i === attempts || !this.alive)
                    throw err;
                this.log(
                    `retry ${cmd} attempt ${i}/${attempts} after ${reason}`
                );
                await new Promise((r) => setTimeout(r, delayMs));
            }
        }
        throw last;
    }

    /** Health check: resolves { pong, pid, ps } or throws. */
    async ping() {
        const r = await this.request('ping');
        if (!r.pong) throw new UiaError('bad-pong', JSON.stringify(r));
        return r;
    }

    /**
     * Ask the helper to quit, wait for it, then kill our own helper pid if
     * it is still there. Safe to call twice.
     */
    async close({ graceMs = 3_000 } = {}) {
        if (!this.proc) return null;
        if (this.alive) {
            try {
                await this.request('quit', {}, { timeoutMs: graceMs });
            } catch {
                // Exited before answering, or wedged; handled below.
            }
            try {
                this.proc.stdin.end();
            } catch {
                // Already closed.
            }
            await new Promise((resolve) => {
                if (this.exit) return resolve();
                const timer = setTimeout(resolve, graceMs);
                this.proc.once('close', () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
            if (!this.exit) {
                this.log(`kill helper pid ${this.pid} (no exit after quit)`);
                try {
                    this.proc.kill();
                } catch {
                    // Gone in between.
                }
                // The exit record is the return value; wait for the close
                // event the kill produces, bounded by the same grace.
                await new Promise((resolve) => {
                    if (this.exit) return resolve();
                    const timer = setTimeout(resolve, graceMs);
                    this.proc.once('close', () => {
                        clearTimeout(timer);
                        resolve();
                    });
                });
            }
        }
        return this.exit;
    }

    // ------------------------------------------------------- typed helpers

    /** { hwnd, pid, exe, rect, minimized, visible, count } */
    findWindow({ class: cls, title, pid, timeoutMs } = {}) {
        return this.request('find-window', {
            class: cls,
            title,
            pid,
            timeoutMs,
        });
    }

    /** { ready, nodes, waitedMs } */
    waitTree(hwnd, { name, controlType, timeoutMs } = {}) {
        return this.request('wait-tree', {
            hwnd,
            name,
            controlType,
            timeoutMs,
        });
    }

    /** { count, truncated, items[] } */
    snapshot(hwnd, { max } = {}) {
        return this.request('snapshot', { hwnd, max });
    }

    /** { via, type, index, count, runtimeId } */
    click(hwnd, name, { controlType, index, after, timeoutMs } = {}) {
        return this.request('click', {
            hwnd,
            name,
            controlType,
            index,
            after,
            timeoutMs,
        });
    }

    /** { before, after, matchedBy, runtimeId } */
    setValue(hwnd, placeholder, value, { scope, settleMs, timeoutMs } = {}) {
        return this.request('set-value', {
            hwnd,
            placeholder,
            value,
            scope,
            settleMs,
            timeoutMs,
        });
    }

    /** { value, matchedBy, runtimeId, enabled, readOnly } */
    getValue(hwnd, placeholder, { scope, timeoutMs } = {}) {
        return this.request('get-value', {
            hwnd,
            placeholder,
            scope,
            timeoutMs,
        });
    }

    /**
     * { texts[], count, joined, nodes, rects }; re is a RegExp or a .NET
     * regex string. join:true also matches each run of Text nodes that
     * render on one text line joined into one string (Chromium exposes
     * every DOM text node on its own, so `Sent {n} {item}` is three or four
     * nodes and their UIA parents need not agree; MEASURED 8 and INFERRED 9
     * in the helper header: the run is geometric, from the cached
     * BoundingRectangle, with the raw-view parent as the fallback for a
     * node without a rect). A run is tried as its raw concatenation, its
     * whitespace-normalized form and its space-joined trimmed leaves. The
     * flag is sent only when set; the helper defaults it to false.
     */
    readText(hwnd, re, { controlType, max, join } = {}) {
        return this.request('read-text', {
            hwnd,
            ...regexParams(re),
            controlType,
            max,
            join: join ? true : undefined,
        });
    }

    /** { path, w, h, restored }: PrintWindow of the window rect to a PNG. */
    capture(hwnd, filePath) {
        return this.request('capture', { hwnd, path: filePath });
    }

    /** SW_SHOWNOACTIVATE only: { wasIconic, iconic, rect } */
    show(hwnd) {
        return this.request('show', { hwnd, mode: 4 });
    }

    /** { monitors: [{ index, device, primary, x, y, w, h }], count } */
    listMonitors() {
        return this.request('list-monitors', {});
    }

    /**
     * Move a window onto a monitor without activating it (SWP_NOACTIVATE).
     * `monitor` is 'secondary' (the default, and the primary when there is
     * only one screen), 'primary', or a 1-based index.
     * { moved, monitor, primary, requested, count, rect, stoleFocus }
     */
    moveWindow(hwnd, monitor = 'secondary') {
        return this.request('move-window', { hwnd, monitor: String(monitor) });
    }

    /** PostMessage WM_CLOSE: { posted } */
    closeWindow(hwnd) {
        return this.request('close', { hwnd });
    }

    /** { foreground, foregroundHwnd, idleSeconds } */
    foregroundCheck(hwnd) {
        return this.request('foreground-check', { hwnd });
    }

    /** { path, productVersion, fileVersion, productName } via VerQueryValue. */
    exeVersion(filePath) {
        return this.request('exe-version', { path: filePath });
    }

    /**
     * WM_COPYDATA second-instance forward. Activates the app window, so
     * lib/desktop.mjs only calls it under --user-away.
     */
    stage(paths, { cwd, uniqueId } = {}) {
        return this.request('stage', { paths, cwd, uniqueId });
    }
}

/** Convenience: open a client, run fn(client), always close. */
export async function withUia(fn, opts = {}) {
    const client = new UiaClient(opts);
    await client.open();
    try {
        return await fn(client);
    } finally {
        await client.close();
    }
}
