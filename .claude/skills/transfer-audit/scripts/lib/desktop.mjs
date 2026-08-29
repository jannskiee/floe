// Desktop adapter for the transfer-audit skill: one Floe desktop window as
// one leg of a transfer cell, driven through scripts/desktop-uia.ps1 (UIA
// InvokePattern and ValuePattern, PrintWindow captures, WM_CLOSE) or, for
// the HEAD lane, a Playwright page on the `wails dev` server.
//
// Launch modes (opts.build.launch, or 'head' when opts.build.kind is 'head'):
//   store     the Microsoft Store build. Receivers (no files) launch by
//             AUMID through explorer.exe (measured: about 1 s to a window);
//             senders launch the package's own exe BY PATH with the files
//             as argv, because explorer drops the argument form (measured
//             P6, 2026-08-29: no window in 30 s), and a by-path cold start
//             stages the files without taking the foreground. The exe path
//             comes from Get-AppxPackage InstallLocation at run time (the
//             folder name carries the version). Package identity on a
//             by-path launch is INFERRED packaged; probe P6 settles it via
//             the absent `Check for updates` row. The only mode that
//             touches the user's real %APPDATA%\floe\desktop.json: backed up,
//             edited to { server, web, hideIP, reportStats:false,
//             noUpdateCheck:true, migrated:true }, restored byte-identical
//             (sha256 compared) after the app exits. Refused while any
//             floe-desktop.exe exists before the run (PreconditionError,
//             exit 3). Nothing under %APPDATA%\floe is ever deleted.
//   portable  the checksum-verified release exe, spawned with
//   head      APPDATA=<scratch>\appdata and FLOE_NO_UPDATE_CHECK=1 so its
//             desktop.json, WebView2 profile and history never reach the
//             user's tree. Measured (P2, 2026-08-29): the redirected launch
//             created <scratch>\appdata\floe\desktop.json and
//             ...\floe\webview\EBWebView and left the real %APPDATA%\floe
//             untouched (sha, mtime, file count), so the audit values are
//             written into the redirected desktop.json BEFORE launch. The
//             exe prints `[WebView2] Environment created successfully` on
//             stdout, kept in desktop.stdout.txt.
//   wailsdev  Playwright page on http://localhost:34115; the thinnest lane,
//             kept for the HEAD receiver when UIA cannot drive the input.
//
// Presence: PRESENT (default) uses provider-side UIA only. The two actions
// that activate a window, WM_COPYDATA staging (desktop/app.go
// onSecondInstanceLaunch calls WindowUnminimise and WindowShow) and any
// second launch, run only with opts.userAway AND when GetLastInputInfo
// shows no key or pointer input for USER_AWAY_IDLE_S (120 s); the flag is
// a claim, the idle time is the evidence, and a claim without evidence is
// SKIP present. Files are staged on the first launch's argv wherever the
// mode allows it.
//
// Interrupts: every applied desktop.json guard and every launched leg is
// registered (activeGuards, activeLegs). audit.mjs calls shutdown() from
// its signal handler and at the end of the run, stop() restores the guard
// in a finally block, and a process 'exit' hook restores whatever is left,
// so Ctrl+C, a crash, a teardown timeout and the last cell's exit all put
// the user's file back. The run manifest carries { backup, configPath,
// sha256, restored } from the moment the guard applies, so `cleanup` can
// replay the backup through restoreConfig if the process died anyway. The
// app pid is registered with lib/proc.mjs, so finalize's killAllStarted
// sees it.
//
// Every expected string is quoted from desktop/frontend/src/App.tsx,
// TitleBar.tsx, incoming.ts and desktop/app.go; see STRINGS and RE below.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    createReadStream,
    createWriteStream,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { registerPid } from './proc.mjs';
import { Leg, PhaseError, SafetyError, sleep } from './surfaces.mjs';

// ------------------------------------------------------------- constants

export const AUMID = 'JanCarloParedes.FloeDesktop_r1y5w9chaxnzc!FloeDesktop';
export const PACKAGE_NAME = 'JanCarloParedes.FloeDesktop';
export const PACKAGE_FAMILY = 'JanCarloParedes.FloeDesktop_r1y5w9chaxnzc';
export const WINDOWS_APPS = 'C:\\Program Files\\WindowsApps\\';
export const EXE_NAME = 'floe-desktop.exe';
export const WINDOW_CLASS = 'wailsWindow'; // wails v2.12.0 window.go:81
export const WINDOW_TITLE = 'Floe'; // desktop/main.go:86
export const SINGLE_INSTANCE_ID = 'one.floe.desktop'; // desktop/main.go:100
export const WAILSDEV_URL = 'http://localhost:34115';
export const LAUNCH_MODES = Object.freeze([
    'store',
    'portable',
    'head',
    'wailsdev',
]);
export const DESKTOP_TAG = /^desktop-v(\d+)\.(\d+)\.(\d+)$/;

/**
 * Exact UI strings the driver keys on (App.tsx unless noted). Source case;
 * UIA reports the rendered case (tabs and the pill are CSS-uppercased), so
 * compare through sameText or the case-insensitive RE table, never ===.
 */
export const STRINGS = Object.freeze({
    codePlaceholder: 'amber-otter-cloud', // receive view Input
    saveDirPlaceholder: 'Downloads (default)', // receive view and Settings
    textPlaceholder: 'Type or paste text to send', // send-text textarea
    tabSend: 'Send', // modeBtn('send', 'Send')
    tabReceive: 'Receive', // modeBtn('receive', 'Receive')
    receiveButton: 'Receive', // primary button on the receive view
    cancel: 'Cancel',
    settings: 'Settings', // TitleBar.tsx aria-label
    minimize: 'Minimize', // TitleBar.tsx aria-label
    startOver: 'Start over', // TitleBar.tsx aria-label
    closeTitle: 'Close Floe?',
    keepGoing: 'Keep going',
    closeAnyway: 'Close anyway',
    checkForUpdates: 'Check for updates', // Settings row, hidden when packaged
    waitingForReceiver: 'Waiting for the receiver...',
    peerConnected: 'Peer connected. Sending...', // desktop/app.go
    connecting: 'Connecting... keep this window open.',
    enterCode: 'Please enter a code or link.',
    canceled: 'Canceled.',
    busyFooter: 'Keep this window open. Closing it cancels the transfer.',
    relayCap: 'relay connections are capped', // errors.ts PASSTHROUGH
    settingUp: 'Setting up...',
});

// UIA Names carry the rendered CSS case (measured 2026-08-29: tabs SEND and
// RECEIVE, pill READY, eyebrows CODE OR LINK), so every regex is
// case-insensitive and the exact-case STRINGS above are only ever compared
// through sameText, never ===.
export const RE = Object.freeze({
    code: /^[a-z]+(-[a-z]+){2,3}$/i,
    link: /https?:\/\/\S*#room=/i,
    sendButton: /^Send \d+ items?$/i,
    sent: /^Sent \d+ items?$/i,
    savedTo: /^Saved to (.+)$/i,
    incoming: /^Incoming: /i,
    pill: /^(Ready|Active|Direct|Relay)$/i,
    status: /^(Connecting\.\.\. keep this window open\.|Please enter a code or link\.|Canceled\.|Error: .*)$/i,
    error: /^Error: /i,
    progress: /^(\[\d+\/\d+\] )?.+ - \d+%  \(/i,
    busyFooter: /^Keep this window open\. Closing it cancels the transfer\.$/i,
    peerConnected: /^Peer connected\. Sending\.\.\.$/i,
    checkForUpdates: /^Check for updates$/i,
    protocolRow: /^Version (\d+)$/i,
});

export const sameText = (a, b) =>
    String(a ?? '')
        .trim()
        .toLowerCase() ===
    String(b ?? '')
        .trim()
        .toLowerCase();

export const FIND_WINDOW_MS = 30_000;
export const TREE_MS = 20_000;
export const STAGE_MS = 20_000;
export const CODE_MS = 30_000;
export const STATUS_MS = 10_000;
export const CANCEL_MS = 10_000;
export const EXIT_MS = 15_000;
export const SAMPLE_MS = 500;
/**
 * A 12 MiB loopback transfer finishes about 0.4 s after connect (measured
 * 2026-08-28: avg 29 MB/s) and the pill shows DIRECT or RELAY only while
 * busy, so after the connected mark the pill is read every 100 ms for the
 * first 5 s and every 500 ms after that.
 */
export const FAST_SAMPLE_MS = 100;
export const FAST_SAMPLE_WINDOW_MS = 5_000;
export const MAX_SAMPLES = 400;
/**
 * The sender's completion fallback: once a decisive route sample (DIRECT or
 * RELAY) is on record, the pill has read READY for this long since it, the
 * busy footer is gone and no error status shows, the transfer is taken as
 * complete even when the `Sent {n} {item}` line never matched (the
 * 2026-08-28 shipped run: the line was on screen for 105 s and the
 * instrument timed out on it). The receiver's hash check still guards
 * integrity; this only stops a blind instrument from failing a finished
 * transfer.
 */
export const READY_AFTER_DECISIVE_MS = 1_500;
export const COMPLETION_PILL_READY = 'pill-ready-after-decisive';
/**
 * --user-away is a claim; GetLastInputInfo is the evidence. WM_COPYDATA
 * staging activates the window, so it runs only when no key or pointer
 * input arrived for this long.
 */
export const USER_AWAY_IDLE_S = 120;

// --------------------------------------------------------------- errors

/** A machine precondition (not a product verdict): audit exit 3. */
export class PreconditionError extends Error {
    constructor(message, extra = {}) {
        super(message);
        this.name = 'PreconditionError';
        this.exitCode = 3;
        Object.assign(this, extra);
    }
}

// ------------------------------------------------------- pure functions

export function parseTag(tag) {
    const m = DESKTOP_TAG.exec(tag || '');
    if (!m) return null;
    const [major, minor, patch] = m.slice(1).map(Number);
    return { tag, version: `${major}.${minor}.${patch}`, major, minor, patch };
}

/** desktop-v0.2.8 -> 1.2.8.0 (pack.ps1: the Store refuses a 0 first octet). */
export function identityVersion(tag) {
    const t = parseTag(tag);
    return t ? `${t.major + 1}.${t.minor}.${t.patch}.0` : null;
}

/** 1.2.8.0 -> desktop-v0.2.8; null for a shape pack.ps1 never produces. */
export function tagForIdentity(identity) {
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(identity || ''));
    if (!m) return null;
    const [a, b, c, d] = m.slice(1).map(Number);
    if (a < 1 || d !== 0) return null;
    return `desktop-v${a - 1}.${b}.${c}`;
}

export function versionForIdentity(identity) {
    const tag = tagForIdentity(identity);
    return tag ? tag.slice('desktop-v'.length) : null;
}

/** App.tsx: `Send${n ? ` ${n} ${n === 1 ? 'item' : 'items'}` : ''}` */
export function sendButtonName(n) {
    if (!n) return 'Send';
    return `Send ${n} ${n === 1 ? 'item' : 'items'}`;
}

export function sha256(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

export function sha256File(file) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(file)
            .on('data', (chunk) => hash.update(chunk))
            .on('error', reject)
            .on('end', () => resolve(hash.digest('hex')));
    });
}

/** %APPDATA%\floe\desktop.json (desktop/config.go configPath). */
export function defaultConfigPath(env = process.env) {
    if (!env.APPDATA) return null;
    return path.join(env.APPDATA, 'floe', 'desktop.json');
}

/**
 * The edited desktop.json: the user's record with the audit's five keys on
 * top. reportStats:false only counts when migrated:true (App.tsx GetSettings
 * effect re-imports localStorage otherwise); noUpdateCheck:true keeps the
 * GitHub check off; server/web point the app at the infra under test.
 */
export function editDesktopJson(
    original,
    { server = '', web = '', hideIP = false } = {}
) {
    const text = original == null ? '' : String(original).trim();
    const cfg = text ? JSON.parse(text) : {};
    return (
        JSON.stringify({
            ...cfg,
            server,
            web,
            hideIP: Boolean(hideIP),
            reportStats: false,
            noUpdateCheck: true,
            migrated: true,
        }) + '\n'
    );
}

/** tasklist /FO CSV /NH rows -> [{ image, pid }]. */
export function parseTasklist(csv) {
    const rows = [];
    for (const line of String(csv || '').split(/\r?\n/)) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m) rows.push({ image: m[1].toLowerCase(), pid: Number(m[2]) });
    }
    return rows;
}

function runText(file, args) {
    return new Promise((resolve) => {
        execFile(
            file,
            args,
            { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
            (err, stdout) => resolve(err ? '' : stdout)
        );
    });
}

/** All floe-desktop.exe processes; injectable for tests. */
export async function listDesktopProcesses(lister = defaultLister) {
    const rows = await lister();
    return rows.filter((r) => r.image === EXE_NAME);
}

async function defaultLister() {
    if (process.platform !== 'win32') return [];
    const out = await runText('tasklist', [
        '/FI',
        `IMAGENAME eq ${EXE_NAME}`,
        '/FO',
        'CSV',
        '/NH',
    ]);
    return parseTasklist(out);
}

export async function processAlive(pid, lister = defaultLister) {
    if (!pid) return false;
    const rows = await lister();
    return rows.some((r) => r.pid === pid);
}

/** The receiver's target the way lib/cli.mjs receiverTarget picks it. */
export function receiverTarget(opts) {
    if (opts.target) return opts.target;
    if (opts.input === 'code') return opts.code ?? null;
    return opts.link ?? opts.code ?? null;
}

export function resolveMode(opts = {}) {
    const build = opts.build || {};
    if (build.launch && LAUNCH_MODES.includes(build.launch))
        return build.launch;
    if (build.kind === 'head') return 'head';
    return 'portable';
}

export function redirectedAppData(scratch) {
    return path.join(scratch, 'appdata');
}

/**
 * Pure launch plan: { mode, command, args, env, cwd, appData, configPath,
 * filesStaged, url, identity }. store without files runs explorer.exe on
 * the AUMID (measured); store with files spawns storeExe (the package's
 * floe-desktop.exe under WindowsApps, resolved by the caller) with the files
 * as argv and the inherited environment (measured: stages without taking
 * the foreground; identity INFERRED packaged). portable/head spawn the exe
 * with the files as argv and APPDATA redirected; every PION_LOG_* is
 * stripped unless pionTrace.
 */
export function planLaunch({
    mode,
    exe,
    storeExe = null,
    files = [],
    scratch,
    env = process.env,
    pionTrace = false,
}) {
    if (!LAUNCH_MODES.includes(mode))
        throw new PhaseError('start', `desktop: unknown launch mode ${mode}`);
    if (mode === 'wailsdev') {
        return {
            mode,
            command: null,
            args: [],
            env: null,
            cwd: null,
            appData: env.APPDATA ?? null,
            configPath: defaultConfigPath(env),
            filesStaged: false,
            url: WAILSDEV_URL,
        };
    }
    if (mode === 'store') {
        if (files.length === 0) {
            return {
                mode,
                command: 'explorer.exe',
                args: [`shell:AppsFolder\\${AUMID}`],
                env: null,
                cwd: null,
                appData: env.APPDATA ?? null,
                configPath: defaultConfigPath(env),
                filesStaged: false,
                url: null,
                identity: 'aumid',
            };
        }
        if (!storeExe)
            throw new PhaseError(
                'start',
                'desktop store: files need the package exe path (Get-AppxPackage InstallLocation)'
            );
        if (!storeExe.startsWith(WINDOWS_APPS))
            throw new PhaseError(
                'start',
                `desktop store: ${storeExe} is not under ${WINDOWS_APPS}`
            );
        return {
            mode,
            command: storeExe,
            args: files.map(String),
            env: null,
            cwd: path.dirname(storeExe),
            appData: env.APPDATA ?? null,
            configPath: defaultConfigPath(env),
            filesStaged: true,
            url: null,
            identity: 'inferred-packaged',
        };
    }
    if (!exe)
        throw new PhaseError(
            'start',
            `desktop ${mode}: opts.build.path (the exe) is required`
        );
    if (!scratch)
        throw new PhaseError(
            'start',
            `desktop ${mode}: a scratch dir is required for the APPDATA redirect`
        );
    const appData = redirectedAppData(scratch);
    const child = {};
    for (const [key, value] of Object.entries(env)) {
        if (key.toUpperCase().startsWith('PION_LOG_')) continue;
        child[key] = value;
    }
    child.APPDATA = appData;
    child.FLOE_NO_UPDATE_CHECK = '1';
    if (pionTrace) child.PION_LOG_TRACE = 'ice';
    return {
        mode,
        command: exe,
        args: files.map(String),
        env: child,
        cwd: path.dirname(exe),
        appData,
        configPath: path.join(appData, 'floe', 'desktop.json'),
        filesStaged: true,
        url: null,
    };
}

/** Write <appData>\floe\desktop.json for a redirected launch; returns the path. */
export function seedRedirectedConfig(appData, edit = {}) {
    const file = path.join(appData, 'floe', 'desktop.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, editDesktopJson('{}', edit));
    return file;
}

/** The statsProof block for a receiver from the config file it launched with. */
export function statsProofFor(configPath) {
    let cfg = null;
    let hash = null;
    try {
        const raw = readFileSync(configPath);
        hash = sha256(raw);
        cfg = JSON.parse(raw.toString('utf8'));
    } catch {
        // Missing or unreadable: the proof below says so.
    }
    return {
        kind: 'desktop.json-preflight',
        configPath,
        sha256: hash,
        reportStats: cfg ? cfg.reportStats : null,
        migrated: cfg ? cfg.migrated : null,
        ok: Boolean(cfg && cfg.reportStats === false && cfg.migrated === true),
    };
}

/** 'direct' | 'relay' | 'unknown' from the pill text. */
export function pillVerdict(text) {
    const t = String(text || '')
        .trim()
        .toLowerCase();
    if (t === 'direct') return 'direct';
    if (t === 'relay') return 'relay';
    return 'unknown';
}

/**
 * Classify a status line: { kind: 'connecting'|'enter-code'|'canceled'|
 * 'refusal'|'error'|'other', text }.
 */
export function classifyStatus(text) {
    const t = String(text || '');
    if (sameText(t, STRINGS.connecting)) return { kind: 'connecting', text: t };
    if (sameText(t, STRINGS.enterCode)) return { kind: 'enter-code', text: t };
    if (sameText(t, STRINGS.canceled)) return { kind: 'canceled', text: t };
    if (RE.error.test(t)) {
        return {
            kind: t.toLowerCase().includes(STRINGS.relayCap)
                ? 'refusal'
                : 'error',
            text: t,
        };
    }
    return { kind: 'other', text: t };
}

// ------------------------------------------------ desktop.json guard

/**
 * Backup, edit and restore the real desktop.json around a Store-mode run.
 * apply() refuses when any floe-desktop.exe exists (not ours) or the file is
 * missing (never create or delete under %APPDATA%\floe). restore() writes
 * the backup bytes back and compares sha256; a mismatch is a SafetyError.
 */
export class DesktopConfigGuard {
    constructor({
        configPath,
        edit = {},
        evidenceDir = null,
        processes = listDesktopProcesses,
        fsImpl = null,
    }) {
        this.configPath = configPath;
        this.edit = edit;
        this.evidenceDir = evidenceDir;
        this.processes = processes;
        this.fs = fsImpl ?? {
            readFileSync,
            writeFileSync,
            existsSync,
            mkdirSync,
        };
        this.backup = null;
        this.backupPath = null;
        this.sha = null;
        this.editedSha = null;
        this.restoredSha = null;
        this.applied = false;
        this.restored = false;
    }

    async apply() {
        if (this.applied) return this;
        if (!this.configPath)
            throw new PreconditionError(
                'desktop.json path unknown (no APPDATA)'
            );
        const running = await this.processes();
        if (running.length) {
            throw new PreconditionError(
                `${EXE_NAME} already running (pid ${running.map((r) => r.pid).join(', ')}): not started by this run, refusing to edit desktop.json`,
                { pids: running.map((r) => r.pid) }
            );
        }
        if (!this.fs.existsSync(this.configPath)) {
            throw new PreconditionError(
                `desktop.json missing at ${this.configPath}; the guard never creates it`
            );
        }
        this.backup = this.fs.readFileSync(this.configPath);
        this.sha = sha256(this.backup);
        if (this.evidenceDir) {
            this.fs.mkdirSync(this.evidenceDir, { recursive: true });
            this.backupPath = path.join(this.evidenceDir, 'desktop.json.bak');
            this.fs.writeFileSync(this.backupPath, this.backup);
        }
        const edited = editDesktopJson(this.backup, this.edit);
        this.editedSha = sha256(edited);
        this.fs.writeFileSync(this.configPath, edited);
        this.applied = true;
        activeGuards.add(this);
        return this;
    }

    restore() {
        if (!this.applied || this.restored) return this.state();
        this.fs.writeFileSync(this.configPath, this.backup);
        this.restoredSha = sha256(this.fs.readFileSync(this.configPath));
        this.restored = true;
        activeGuards.delete(this);
        if (this.restoredSha !== this.sha) {
            throw new SafetyError(
                `desktop.json restore mismatch: want ${this.sha}, got ${this.restoredSha}; backup at ${this.backupPath ?? '(memory)'}`,
                {
                    want: this.sha,
                    got: this.restoredSha,
                    backupPath: this.backupPath,
                    configPath: this.configPath,
                }
            );
        }
        return this.state();
    }

    state() {
        return {
            configPath: this.configPath,
            backupPath: this.backupPath,
            backupSha: this.sha,
            editedSha: this.editedSha,
            restoredSha: this.restoredSha,
            applied: this.applied,
            restored: this.restored,
            match: this.restored ? this.restoredSha === this.sha : null,
        };
    }
}

/**
 * Every applied guard and every launched leg, so an interrupt can put the
 * user's desktop.json back and close the app whatever the cell was doing:
 * audit.mjs calls shutdown() from its signal handler and from finalize,
 * and the process 'exit' hook below is the last resort (a crash, a
 * process.exit from a teardown timeout) and needs no event loop.
 */
export const activeGuards = new Set();
export const activeLegs = new Set();

process.on('exit', () => {
    for (const guard of [...activeGuards]) {
        try {
            guard.restore();
        } catch {
            // The backup path is in the run manifest; `cleanup` replays it.
        }
    }
});

/**
 * Stop every launched leg (cancel, restore the save dir, WM_CLOSE) and put
 * every applied desktop.json back. Idempotent; never throws. audit.mjs
 * calls it on every adapter it used, on Ctrl+C before process.exit and at
 * the end of a run.
 */
export async function shutdown({ log = null, manifest = null } = {}) {
    const note = typeof log === 'function' ? log : () => {};
    let stopped = 0;
    for (const leg of [...activeLegs]) {
        try {
            await leg.stop('shutdown');
            stopped += 1;
        } catch (err) {
            note(`desktop shutdown: ${leg.role}: ${err.message}`);
        }
    }
    let restored = 0;
    for (const guard of [...activeGuards]) {
        try {
            guard.restore();
            restored += 1;
        } catch (err) {
            note(`desktop shutdown: config restore: ${err.message}`);
        }
        if (
            manifest &&
            manifest.desktop &&
            manifest.desktop.configPath === guard.configPath
        )
            manifest.desktop.restored = guard.state().match;
    }
    return { stopped, restored };
}

/** Closure form of the guard: apply, run body, always restore. */
export async function withDesktopConfig(configPath, edit, body, options = {}) {
    const guard = new DesktopConfigGuard({ configPath, edit, ...options });
    await guard.apply();
    let result;
    try {
        result = await body(guard);
    } finally {
        guard.restore();
    }
    return { result, sha256: guard.sha, state: guard.state() };
}

// ------------------------------------------------------------- drivers

/**
 * UIA driver: one helper client plus the window handle. Every method maps
 * to one helper command; see desktop-uia.ps1.
 */
export class UiaDriver {
    constructor(client, hwnd, { log = null } = {}) {
        this.client = client;
        this.hwnd = hwnd;
        this.log = log;
    }
    click(name, opts = {}) {
        return this.client.retry(
            'click',
            { hwnd: this.hwnd, name, ...opts },
            { attempts: 2 }
        );
    }
    setValue(placeholder, value, opts = {}) {
        return this.client.request('set-value', {
            hwnd: this.hwnd,
            placeholder,
            value,
            ...opts,
        });
    }
    getValue(placeholder, opts = {}) {
        return this.client.request('get-value', {
            hwnd: this.hwnd,
            placeholder,
            ...opts,
        });
    }
    async readText(re, opts = {}) {
        const r = await this.client.readText(this.hwnd, re, opts);
        return r.texts;
    }
    async capture(file) {
        return this.client.capture(this.hwnd, file);
    }
    waitTree(opts = {}) {
        return this.client.waitTree(this.hwnd, opts);
    }
    show() {
        return this.client.show(this.hwnd);
    }
    listMonitors() {
        return this.client.listMonitors();
    }
    moveWindow(monitor) {
        return this.client.moveWindow(this.hwnd, monitor);
    }
    closeWindow() {
        return this.client.closeWindow(this.hwnd);
    }
    foregroundCheck() {
        return this.client.foregroundCheck(this.hwnd);
    }
    async alive() {
        try {
            await this.client.request(
                'foreground-check',
                { hwnd: this.hwnd },
                { timeoutMs: 5000 }
            );
            return true;
        } catch (err) {
            return !(err && err.reason === 'not-a-window');
        }
    }
    async stage(paths, cwd) {
        return this.client.stage(paths, { cwd, uniqueId: SINGLE_INSTANCE_ID });
    }
}

/**
 * Playwright driver for the wails dev server (HEAD lane). Thin on purpose:
 * lib/web.mjs (getBrowser) is imported lazily and the page is driven with
 * role and placeholder locators. INFERRED: Wails v2 exposes the bound Go
 * methods at window.go.main.App and events at window.runtime.EventsOn.
 */
export class PlaywrightDriver {
    constructor(page, context, { log = null } = {}) {
        this.page = page;
        this.context = context;
        this.log = log;
        this.routeEvent = null;
    }
    static async open(opts = {}) {
        const web = await import('./web.mjs');
        if (typeof web.getBrowser !== 'function') {
            throw new PhaseError(
                'start',
                'desktop wailsdev: lib/web.mjs exports no getBrowser'
            );
        }
        const browser = await web.getBrowser(opts);
        const context = await browser.newContext();
        // Desktop sentinel is '0', not 'false' (App.tsx reportStats seed).
        await context.addInitScript(() => {
            try {
                localStorage.setItem('floe:report-stats', '0');
            } catch {
                // Storage blocked: GetSettings still governs the toggle.
            }
        });
        const page = await context.newPage();
        await page.goto(opts.url ?? WAILSDEV_URL, { waitUntil: 'load' });
        const driver = new PlaywrightDriver(page, context, opts);
        await page.evaluate(() => {
            window.__floeRoute = null;
            const rt = window.runtime;
            if (rt && typeof rt.EventsOn === 'function') {
                rt.EventsOn('recv:route', (r) => (window.__floeRoute = r));
                rt.EventsOn('send:route', (r) => (window.__floeRoute = r));
            }
        });
        return driver;
    }
    async settings() {
        return this.page.evaluate(async () => {
            const app = window.go && window.go.main && window.go.main.App;
            if (!app || typeof app.GetSettings !== 'function') return null;
            return app.GetSettings();
        });
    }
    async click(name, { index = 0, after } = {}) {
        let loc = this.page.getByRole('button', { name, exact: true });
        if (after === STRINGS.codePlaceholder) {
            // The primary Receive button sits below the code input.
            loc = this.page
                .locator(
                    'input[placeholder="amber-otter-cloud"] ~ *, div:has(> input[placeholder="amber-otter-cloud"]) ~ *'
                )
                .getByRole('button', { name, exact: true });
            index = 0;
        }
        await loc.nth(index).click();
        return { via: 'playwright', index };
    }
    async setValue(placeholder, value, { scope } = {}) {
        const loc = this._edit(placeholder, scope);
        const before = await loc.inputValue();
        await loc.fill(value);
        return {
            before,
            after: await loc.inputValue(),
            matchedBy: 'placeholder',
        };
    }
    async getValue(placeholder, { scope } = {}) {
        const loc = this._edit(placeholder, scope);
        return { value: await loc.inputValue(), matchedBy: 'placeholder' };
    }
    _edit(placeholder, scope) {
        const all = this.page.locator(
            `input[placeholder="${placeholder}"], textarea[placeholder="${placeholder}"]`
        );
        if (scope === 'receive' && placeholder === STRINGS.saveDirPlaceholder) {
            // The receive view's field follows the code input; Settings' does not.
            return this.page
                .locator('input[placeholder="amber-otter-cloud"]')
                .locator(
                    'xpath=following::input[@placeholder="Downloads (default)"][1]'
                );
        }
        return all.first();
    }
    /** join is accepted and moot here: textContent already joins the leaves. */
    async readText(re, { controlType = 'Text', join = false } = {}) {
        void join;
        const texts = await this.page.evaluate(
            (selector) => {
                return [...document.querySelectorAll(selector)]
                    .map((e) => (e.textContent || '').trim())
                    .filter(Boolean);
            },
            controlType === 'Button' ? 'button' : 'p, span, code, h2, div'
        );
        const rx = re instanceof RegExp ? re : new RegExp(String(re), 'i');
        return texts.filter((t) => rx.test(t));
    }
    async capture(file) {
        await this.page.screenshot({ path: file });
        return { path: file };
    }
    async waitTree() {
        await this.page
            .getByRole('button', { name: STRINGS.settings })
            .waitFor({ timeout: TREE_MS });
        return { ready: true };
    }
    async show() {
        return { wasIconic: false, iconic: false };
    }
    async closeWindow() {
        await this.context.close();
        return { posted: true };
    }
    async foregroundCheck() {
        return { foreground: true, idleSeconds: -1 };
    }
    async alive() {
        return !this.page.isClosed();
    }
    async routeFromEvent() {
        try {
            return await this.page.evaluate(() => window.__floeRoute);
        } catch {
            return null;
        }
    }
}

// ----------------------------------------------------------- launching

/**
 * Spawn per the plan. Resolves { child, pid }; the explorer.exe AUMID form
 * resolves { child: null, pid: null } because explorer, not us, is the
 * parent and the window search that follows is the real handshake.
 */
export function launchProcess(plan, { evidenceDir = null } = {}) {
    if (plan.mode === 'wailsdev')
        return Promise.resolve({ child: null, pid: null });
    if (plan.command === 'explorer.exe') {
        return new Promise((resolve) => {
            const child = execFile(
                plan.command,
                plan.args,
                { windowsHide: true },
                () => {}
            );
            child.on('error', () => {});
            // explorer.exe and Start-Process return before the app is up;
            // the window search that follows is the real handshake.
            setTimeout(
                () =>
                    resolve({
                        child: null,
                        pid: null,
                        launcherPid: child.pid ?? null,
                    }),
                200
            );
        });
    }
    const child = spawn(plan.command, plan.args, {
        cwd: plan.cwd,
        env: plan.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false,
        shell: false,
    });
    child.on('error', () => {});
    if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true });
        child.stdout.pipe(
            createWriteStream(path.join(evidenceDir, 'desktop.stdout.txt'))
        );
        child.stderr.pipe(
            createWriteStream(path.join(evidenceDir, 'desktop.stderr.txt'))
        );
    } else {
        child.stdout.resume();
        child.stderr.resume();
    }
    return Promise.resolve({ child, pid: child.pid ?? null });
}

function taskkill(pid) {
    return runText('taskkill', ['/PID', String(pid), '/T', '/F']);
}

/**
 * Close a window we launched: WM_CLOSE, wait, WM_CLOSE again, wait, then
 * taskkill only when pid is ours (recorded at launch) and its image is still
 * floe-desktop.exe. Returns { closed, how }.
 */
export async function closeAndWait(
    driver,
    pid,
    { lister = defaultLister, exitMs = EXIT_MS, log = null } = {}
) {
    const note = (s) => log && log(s);
    const gone = async () =>
        pid ? !(await processAlive(pid, lister)) : !(await driver.alive());
    for (let round = 1; round <= 2; round++) {
        try {
            await driver.closeWindow();
        } catch (err) {
            if (err && err.reason === 'not-a-window')
                return { closed: true, how: 'already-closed' };
            note(`close round ${round}: ${err.message}`);
        }
        const until = Date.now() + exitMs;
        while (Date.now() < until) {
            if (await gone()) return { closed: true, how: `wm-close-${round}` };
            await sleep(500);
        }
    }
    if (pid) {
        const rows = await lister();
        const row = rows.find((r) => r.pid === pid);
        if (row && row.image === EXE_NAME) {
            await taskkill(pid);
            note(`taskkill pid ${pid} after two WM_CLOSE rounds`);
            await sleep(1000);
            return { closed: await gone(), how: 'taskkill' };
        }
    }
    return { closed: false, how: 'still-running' };
}

// -------------------------------------------------------------- the leg

export class DesktopLeg extends Leg {
    constructor(opts) {
        super(opts);
        this.surface = 'desktop';
        this.mode = resolveMode(opts);
        this.exe = (opts.build && opts.build.path) || null;
        this.scratch =
            opts.scratch ??
            opts.out ??
            (opts.evidenceDir ? path.dirname(opts.evidenceDir) : null);
        this.evidenceDir = opts.evidenceDir ?? null;
        this.userAway = Boolean(opts.userAway);
        this.client = opts.uia ?? null;
        this.ownClient = false;
        this.lister = opts.lister ?? defaultLister;
        this.driver = null;
        this.plan = null;
        this.hwnd = null;
        // secondary by default: keep the audit off the screen being used.
        this.monitor = opts.monitor ?? 'secondary';
        this.pid = null;
        this.exePath = null;
        this.child = null;
        this.guard = null;
        this.saveDir = { original: null, changed: false, restored: null };
        this.launchProof = null;
        this.samples = [];
        // The latest DIRECT or RELAY sample; route() reports it even after
        // the pill has gone back to READY or the samples ring has moved on.
        this.decisive = null;
        // How the leg decided it was done: 'line' (the completion text
        // matched), COMPLETION_PILL_READY (the sender fallback), or the
        // non-transfer kind. Reported in evidence().
        this.completion = null;
        this.captures = [];
        this.texts = [];
        this.marks = {};
        this.settingsRead = null;
        // Test seams: the process launcher and the wailsdev page opener.
        this.launcher = opts.launcher ?? launchProcess;
        this.openDriver = opts.openDriver ?? PlaywrightDriver.open;
        this._code = null;
        this._link = null;
        this._sampler = null;
        this._done = null;
        this._stopped = false;
        this._stopPromise = null;
    }

    note(line) {
        this.notes.push(line);
        if (this.client && typeof this.client.log === 'function')
            this.client.log(`desktop ${this.role}: ${line}`);
    }

    budget(ms) {
        const { deadlineAt } = this.opts;
        if (!deadlineAt) return ms;
        return Math.max(1000, Math.min(ms, deadlineAt - Date.now()));
    }

    edit() {
        const infra = this.opts.infra || {};
        return {
            server: infra.server ?? '',
            web: infra.web ?? '',
            hideIP: Boolean(this.opts.relayOnly),
        };
    }

    async uia() {
        if (this.client) return this.client;
        const { UiaClient } = await import('./uia.mjs');
        const logPath = this.evidenceDir
            ? path.join(this.evidenceDir, 'uia.log')
            : null;
        if (this.evidenceDir) mkdirSync(this.evidenceDir, { recursive: true });
        // -Root makes the helper refuse a capture path outside the scratch
        // tree, so a bad path here can never land a PNG elsewhere.
        this.client = new UiaClient({ logPath, root: this.scratch ?? null });
        await this.client.open();
        this.ownClient = true;
        return this.client;
    }

    /** Hand a pid the app runs under to lib/proc.mjs so finalize can see it. */
    registerPid(pid) {
        if (!pid) return;
        registerPid(pid, {
            image: EXE_NAME,
            label: `${this.opts.cellId ?? 'desktop'}:${this.role}`,
            argv: this.plan ? [this.plan.command, ...this.plan.args] : [],
        });
    }

    async capture(tag) {
        if (!this.driver || !this.evidenceDir) return null;
        const file = path.join(this.evidenceDir, `${this.role}-${tag}.png`);
        try {
            const r = await this.driver.capture(file);
            this.captures.push({
                tag,
                t: Date.now(),
                path: file,
                w: r.w,
                h: r.h,
            });
            return file;
        } catch (err) {
            this.note(`capture ${tag} failed: ${err.message}`);
            return null;
        }
    }

    async snapshotTexts(tag) {
        if (!this.driver) return [];
        try {
            const texts = await this.driver.readText(/./, {
                controlType: 'any',
                max: 200,
            });
            this.texts.push({ tag, t: Date.now(), texts });
            return texts;
        } catch (err) {
            this.note(`text snapshot ${tag} failed: ${err.message}`);
            return [];
        }
    }

    /** Launch per mode, find the window, wait for the tree; sets this.driver. */
    async launch(files = []) {
        const { opts } = this;
        let storeExe = opts.storeExe ?? null;
        if (this.mode === 'store' && files.length && !storeExe) {
            const pkg = await storePackage();
            if (!pkg.present || !pkg.exe)
                throw new PreconditionError(
                    'desktop store: Get-AppxPackage found no Floe package'
                );
            storeExe = pkg.exe;
            this.note(`store exe ${storeExe} (identity ${pkg.version})`);
        }
        this.plan = planLaunch({
            mode: this.mode,
            exe: this.exe,
            storeExe,
            files,
            scratch: this.scratch,
            pionTrace: Boolean(opts.pionTrace),
        });
        // From here on shutdown() owns this leg until stop() runs.
        activeLegs.add(this);
        if (this.mode === 'wailsdev') {
            this.driver = await this.openDriver({
                ...opts,
                log: (l) => this.note(l),
            });
            await this.driver.waitTree();
            this.settingsRead = await this.driver.settings();
            this.assertWailsdevConfig(this.settingsRead);
            return this.driver;
        }
        if (this.mode === 'store') {
            this.guard = new DesktopConfigGuard({
                configPath: this.plan.configPath,
                edit: this.edit(),
                evidenceDir: this.evidenceDir,
                processes: () => listDesktopProcesses(this.lister),
            });
            await this.guard.apply();
            // The run manifest learns where the backup is, on disk at once,
            // so `cleanup` can put desktop.json back even if this process
            // dies mid-cell.
            this.recordGuard();
        } else {
            seedRedirectedConfig(this.plan.appData, this.edit());
        }
        // Read the proof now, before any restore, so evidence() reports the
        // config the app actually launched with.
        this.launchProof = statsProofFor(this.plan.configPath);
        const client = await this.uia();
        const launched = await this.launcher(this.plan, {
            evidenceDir: this.evidenceDir,
        });
        this.child = launched.child;
        this.pid = launched.pid;
        // Registered before the window search: a launch that never shows a
        // window is still ours to kill at finalize.
        this.registerPid(this.pid);
        const win = await client.findWindow({
            class: WINDOW_CLASS,
            title: WINDOW_TITLE,
            pid: this.pid ?? undefined,
            timeoutMs: this.budget(FIND_WINDOW_MS),
        });
        this.hwnd = win.hwnd;
        this.pid = win.pid;
        this.exePath = win.exe;
        // The AUMID launch (explorer.exe) only learns its pid here.
        this.registerPid(this.pid);
        this.marks.window = Date.now();
        this.driver = new UiaDriver(client, this.hwnd, {
            log: (l) => this.note(l),
        });
        if (
            this.mode === 'store' &&
            !(win.exe || '').startsWith(WINDOWS_APPS)
        ) {
            this.note(
                `store launch resolved to ${win.exe}, not under ${WINDOWS_APPS}`
            );
        }
        if (win.minimized) await this.driver.show();
        // The desktop window is the only thing an audit puts on screen (the
        // browser is headless, the CLI has no window), so it goes where the
        // operator asked before any cell drives it. SWP_NOACTIVATE, so the
        // move never takes focus; a failure here is a note, never a failed
        // transfer.
        if (this.monitor && this.monitor !== 'off') {
            try {
                const m = await this.driver.moveWindow(this.monitor);
                this.note(
                    `window on ${m.monitor}${m.primary ? ' (primary)' : ''} of ${m.count}, asked for ${m.requested}${m.stoleFocus ? ' STOLE FOCUS' : ''}`
                );
                if (m.stoleFocus)
                    this.note(
                        'move-window took the foreground; that is a helper bug, not a product one'
                    );
            } catch (e) {
                this.note(`move-window: ${e.message}`);
            }
        }
        await this.driver.waitTree({
            name: STRINGS.settings,
            timeoutMs: this.budget(TREE_MS),
        });
        this.marks.tree = Date.now();
        return this.driver;
    }

    spend(kind) {
        const { ledger } = this.opts;
        if (ledger && typeof ledger.spend === 'function') ledger.spend(kind);
    }

    /** manifest.desktop = { backup, configPath, sha256, restored }, written now. */
    recordGuard() {
        const shared = this.opts.shared || {};
        if (!shared.manifest || !this.guard) return;
        shared.manifest.desktop = {
            backup: this.guard.backupPath,
            configPath: this.guard.configPath,
            sha256: this.guard.sha,
            restored: this.guard.restored ? this.guard.state().match : null,
        };
        if (typeof shared.writeManifest === 'function') {
            try {
                shared.writeManifest();
            } catch (err) {
                this.note(`manifest write: ${err.message}`);
            }
        }
    }

    /**
     * The wailsdev lane cannot seed or guard the config the dev server's
     * app reads (App.tsx ignores the localStorage seed once migrated is
     * true, and app.go posts to the configured server when reportStats is
     * true), so a receiver is driven only when GetSettings already shows
     * the audit values; a sender only needs the server under test.
     */
    assertWailsdevConfig(settings) {
        const s = settings || {};
        const want = this.edit();
        const serverOk = s.server === want.server;
        const ok =
            this.role === 'receiver'
                ? s.reportStats === false && s.migrated === true && serverOk
                : serverOk;
        if (ok) return;
        throw new PreconditionError(
            `desktop wailsdev: GetSettings is reportStats=${s.reportStats} migrated=${s.migrated} server=${s.server}; want ${this.role === 'receiver' ? 'reportStats=false migrated=true ' : ''}server=${want.server}; refusing to drive a ${this.role} that may report or reach the wrong server`,
            { reason: 'wailsdev-config' }
        );
    }

    async start() {
        const { opts } = this;
        try {
            if (this.role === 'sender') await this.startSender();
            else if (this.role === 'receiver') await this.startReceiver();
            else
                throw new PhaseError(
                    'start',
                    `desktop: unknown role ${this.role}`
                );
        } catch (err) {
            await this.capture('start-failure');
            if (
                err instanceof PhaseError ||
                err instanceof PreconditionError ||
                err instanceof SafetyError
            )
                throw err;
            throw new PhaseError(
                'start',
                `desktop ${this.role}: ${err.message}`,
                { cause: err }
            );
        }
        this.startSampler();
        this.marks.started = Date.now();
        void opts;
        return this;
    }

    async startSender() {
        const files = (this.opts.files || []).map(String);
        if (!files.length)
            throw new PhaseError(
                'start',
                'desktop sender: opts.files is empty'
            );
        const want = sendButtonName(files.length);
        await this.launch(files);
        let staged = await this.waitForButton(want, this.budget(STAGE_MS));
        if (!staged && this.mode === 'store') {
            if (!this.userAway) {
                throw new PhaseError(
                    'start',
                    `desktop sender: the Store launch did not stage ${files.length} files and staging a running app activates it`,
                    {
                        verdict: 'SKIP',
                        reason: 'present',
                    }
                );
            }
            // --user-away is a claim; GetLastInputInfo is the evidence.
            const fg = await this.driver.foregroundCheck();
            const idle = Number(fg && fg.idleSeconds);
            if (!(idle >= USER_AWAY_IDLE_S)) {
                throw new PhaseError(
                    'start',
                    `desktop sender: --user-away but input idle only ${fg && fg.idleSeconds} s (< ${USER_AWAY_IDLE_S}); staging would activate the window`,
                    { verdict: 'SKIP', reason: 'present' }
                );
            }
            this.note(`staging via WM_COPYDATA (user away, idle ${idle} s)`);
            await this.driver.stage(files, path.dirname(files[0]));
            staged = await this.waitForButton(want, this.budget(STAGE_MS));
        }
        if (!staged)
            throw new PhaseError(
                'start',
                `desktop sender: no button named "${want}" appeared`
            );
        // desktop/app.go runSend: TURN credentials, /ws, code registration.
        this.spend('turn');
        this.spend('conn');
        this.spend('code');
        await this.driver.click(want, { controlType: 'Button' });
        this.marks.clicked = Date.now();
        const until = Date.now() + this.budget(CODE_MS);
        while (Date.now() < until) {
            const codes = await this.driver.readText(RE.code, {
                controlType: 'Text',
            });
            const links = await this.driver.readText(RE.link, {
                controlType: 'any',
            });
            const code = codes.find(
                (c) => !sameText(c, STRINGS.codePlaceholder)
            );
            if (links.length) {
                this._link = links[0];
                this._code = code ? code.toLowerCase() : null;
                this.marks.link = Date.now();
                await this.capture('link');
                return;
            }
            const status = await this.readStatus();
            if (
                status &&
                (status.kind === 'error' || status.kind === 'refusal')
            ) {
                throw new PhaseError('start', `desktop sender: ${status.text}`);
            }
            await sleep(500);
        }
        throw new PhaseError(
            'start',
            'desktop sender: no share link within the start timeout'
        );
    }

    async waitForButton(name, timeoutMs) {
        const until = Date.now() + timeoutMs;
        while (Date.now() < until) {
            const names = await this.driver.readText(RE.sendButton, {
                controlType: 'Button',
            });
            if (names.some((n) => sameText(n, name))) return true;
            await sleep(500);
        }
        return false;
    }

    async startReceiver() {
        const { opts } = this;
        const target = receiverTarget(opts);
        if (!target)
            throw new PhaseError('start', 'desktop receiver: no code or link');
        if (!opts.outDir)
            throw new PhaseError(
                'start',
                'desktop receiver: opts.outDir is required'
            );
        await this.launch([]);
        await this.driver.click(STRINGS.tabReceive, { index: 0 });
        const orig = await this.driver.getValue(STRINGS.saveDirPlaceholder, {
            scope: 'receive',
        });
        this.saveDir.original = orig.value ?? '';
        const setCode = await this.driver.setValue(
            STRINGS.codePlaceholder,
            target
        );
        if (setCode.after !== target) {
            throw new PhaseError(
                'start',
                `desktop receiver: SetValue left "${setCode.after}" in the code field`,
                {
                    verdict: 'SKIP',
                    reason: 'uia-setvalue',
                    matchedBy: setCode.matchedBy,
                }
            );
        }
        const setDir = await this.driver.setValue(
            STRINGS.saveDirPlaceholder,
            opts.outDir,
            { scope: 'receive' }
        );
        this.saveDir.changed = true;
        if (setDir.after !== opts.outDir) {
            throw new PhaseError(
                'start',
                `desktop receiver: SetValue left "${setDir.after}" in the save-dir field`,
                {
                    verdict: 'SKIP',
                    reason: 'desktop-savedir',
                }
            );
        }
        // desktop/app.go receiveByCode: code.Resolve (code only), ice.Fetch, /ws.
        this.spend('turn');
        this.spend('conn');
        if (opts.input === 'code') this.spend('code');
        await this.driver.click(STRINGS.receiveButton, {
            after: STRINGS.codePlaceholder,
        });
        this.marks.clicked = Date.now();
        const until = Date.now() + this.budget(STATUS_MS);
        while (Date.now() < until) {
            const status = await this.readStatus();
            if (status) {
                if (status.kind === 'connecting') {
                    this.marks.joined = Date.now();
                    await this.capture('joined');
                    return;
                }
                if (status.kind === 'enter-code') {
                    throw new PhaseError(
                        'start',
                        'desktop receiver: the app says "Please enter a code or link." so SetValue never reached React',
                        {
                            verdict: 'SKIP',
                            reason: 'uia-setvalue',
                        }
                    );
                }
                if (status.kind === 'error' || status.kind === 'refusal') {
                    throw new PhaseError(
                        'start',
                        `desktop receiver: ${status.text}`
                    );
                }
            }
            await sleep(250);
        }
        throw new PhaseError(
            'start',
            'desktop receiver: no status change after clicking Receive'
        );
    }

    /**
     * The current status line, classified, or null. Every completion,
     * status and incoming read joins sibling Text leaves: Chromium exposes
     * each DOM text node on its own, so `Sent {n} {item}` is three Text
     * elements and `Saved to {dir}` two, and an anchored regex never
     * matched either (the 2026-08-28 shipped run timed out on both desktop
     * cells with the line on screen). Only the pill read stays single-node.
     */
    async readStatus() {
        const lines = await this.driver.readText(RE.status, {
            controlType: 'Text',
            join: true,
        });
        if (!lines.length) return null;
        return classifyStatus(lines[0]);
    }

    async code() {
        return this._code;
    }

    async link() {
        if (this.role === 'receiver') return receiverTarget(this.opts);
        return this._link;
    }

    async awaitConnected(timeoutMs) {
        const until = Date.now() + this.budget(timeoutMs);
        while (Date.now() < until) {
            let hit = null;
            if (this.role === 'sender') {
                const lines = await this.driver.readText(RE.peerConnected, {
                    controlType: 'Text',
                    join: true,
                });
                if (lines.length) hit = lines[0];
            } else {
                const incoming = await this.driver.readText(RE.incoming, {
                    controlType: 'Text',
                    join: true,
                });
                if (incoming.length) hit = incoming[0];
                else {
                    const pill = await this.driver.readText(RE.pill, {
                        controlType: 'Text',
                    });
                    const decisive = pill.find(
                        (p) => pillVerdict(p) !== 'unknown'
                    );
                    if (decisive) hit = `pill ${decisive}`;
                    else {
                        const prog = await this.driver.readText(RE.progress, {
                            controlType: 'Text',
                            join: true,
                        });
                        if (prog.length) hit = prog[0];
                    }
                }
            }
            if (!hit) {
                // A fast transfer can finish between two 500 ms polls (the
                // 2026-08-29 WSL sender moved 12 MiB in 0.3 s): the completion
                // text then proves the connection happened, and the done
                // phase finds the same text at once.
                const doneRe = this.role === 'sender' ? RE.sent : RE.savedTo;
                const done = await this.driver.readText(doneRe, {
                    controlType: 'Text',
                    join: true,
                });
                if (done.length)
                    hit = `completed before a connect sample: ${done[0]}`;
            }
            if (hit) {
                this.marks.connected = Date.now();
                // The fast pill cadence starts now, not on the next 500 ms tick.
                this.kickSampler();
                await this.capture('connected');
                return { t: this.marks.connected, line: hit };
            }
            const status = await this.readStatus();
            if (
                status &&
                (status.kind === 'error' ||
                    status.kind === 'refusal' ||
                    status.kind === 'canceled')
            ) {
                throw new PhaseError(
                    'connect',
                    `desktop ${this.role}: ${status.text}`,
                    { status }
                );
            }
            await sleep(500);
        }
        throw new PhaseError(
            'connect',
            `desktop ${this.role}: not connected within ${timeoutMs} ms`
        );
    }

    /**
     * Poll the pill: SAMPLE_MS while idle, FAST_SAMPLE_MS for the first
     * FAST_SAMPLE_WINDOW_MS after the connected mark (the only window in
     * which a fast transfer shows DIRECT or RELAY; the 2026-08-28 D2C
     * sender read ACTIVE then READY at 500 ms and never saw DIRECT). One
     * chain of setTimeouts, so a kick never doubles the cadence.
     */
    startSampler() {
        if (this._sampler || !this.driver) return;
        const s = { timer: null, busy: false, stopped: false, kick: null };
        this._sampler = s;
        const schedule = (ms) => {
            if (s.stopped) return;
            clearTimeout(s.timer);
            s.timer = setTimeout(tick, ms);
            if (typeof s.timer.unref === 'function') s.timer.unref();
        };
        const tick = async () => {
            if (s.stopped || s.busy || this._stopped) return;
            s.busy = true;
            try {
                await this.sampleOnce();
            } catch {
                // A slow tree read; the next tick tries again.
            } finally {
                s.busy = false;
            }
            schedule(this.sampleInterval());
        };
        s.kick = () => {
            // A read in flight reschedules itself at the new cadence.
            if (!s.busy) schedule(0);
        };
        schedule(this.sampleInterval());
    }

    /** Sample now rather than on the next tick (the connected mark). */
    kickSampler() {
        if (this._sampler && this._sampler.kick) this._sampler.kick();
    }

    sampleInterval() {
        const since = this.marks.connected
            ? Date.now() - this.marks.connected
            : Infinity;
        return since < FAST_SAMPLE_WINDOW_MS ? FAST_SAMPLE_MS : SAMPLE_MS;
    }

    /** One pill read into samples; the first decisive one is the route mark. */
    async sampleOnce() {
        const pill = await this.driver.readText(RE.pill, {
            controlType: 'Text',
        });
        const text = pill[0] ?? null;
        const verdict = pillVerdict(text);
        const sample = {
            t: Date.now(),
            source: 'pill',
            local: null,
            remote: null,
            verdict,
            text,
        };
        if (this.mode === 'wailsdev' && verdict === 'unknown') {
            const ev = await this.driver.routeFromEvent();
            if (ev === 'direct' || ev === 'relay') {
                sample.source = 'wails-event';
                sample.verdict = ev;
            }
        }
        this.samples.push(sample);
        if (this.samples.length > MAX_SAMPLES) this.samples.shift();
        if (sample.verdict !== 'unknown') {
            this.decisive = sample;
            if (!this.marks.route) {
                this.marks.route = sample.t;
                void this.capture('route');
            }
        }
        return sample;
    }

    stopSampler() {
        if (this._sampler) {
            this._sampler.stopped = true;
            clearTimeout(this._sampler.timer);
        }
        this._sampler = null;
    }

    /**
     * The latest decisive sample when there was one, else the latest
     * sample: a completion that lands while the pill last read DIRECT or
     * RELAY keeps that verdict, and READY afterwards never overwrites it.
     */
    route() {
        try {
            if (this.decisive) return this.decisive;
            return this.samples.length
                ? this.samples[this.samples.length - 1]
                : null;
        } catch {
            return null;
        }
    }

    /**
     * How long the pill has read READY without a break since the decisive
     * route sample, in ms; 0 without a decisive sample, without a READY
     * sample after it, or when a later sample read anything else. The
     * samples come from the background sampler (startSampler), so the
     * figure moves at its cadence.
     */
    readyAfterDecisiveMs() {
        if (!this.decisive) return 0;
        let since = null;
        for (const s of this.samples) {
            if (s.t <= this.decisive.t) continue;
            if (/^ready$/i.test(String(s.text ?? '').trim())) {
                if (since === null) since = s.t;
            } else since = null;
        }
        return since === null ? 0 : Date.now() - since;
    }

    /**
     * Sender side: the `Sent {n} {item}` line is the primary oracle and is
     * read first on every turn; the pill fallback (READY_AFTER_DECISIVE_MS)
     * runs only after the status read found no error, so an error or a
     * cancel always wins over it.
     */
    async awaitDone(timeoutMs) {
        const t0 = this.marks.clicked ?? Date.now();
        const until = Date.now() + this.budget(timeoutMs);
        while (Date.now() < until) {
            if (this.role === 'sender') {
                const sent = await this.driver.readText(RE.sent, {
                    controlType: 'Text',
                    join: true,
                });
                if (sent.length) {
                    this.completion = 'line';
                    return this.finish({
                        ok: true,
                        kind: 'transfer',
                        detail: { line: sent[0] },
                        ms: Date.now() - t0,
                    });
                }
            } else {
                const saved = await this.driver.readText(RE.savedTo, {
                    controlType: 'Text',
                    join: true,
                });
                if (saved.length) {
                    const dir = RE.savedTo.exec(saved[0])[1];
                    this.completion = 'line';
                    return this.finish({
                        ok: true,
                        kind: 'transfer',
                        detail: { line: saved[0], dir },
                        ms: Date.now() - t0,
                    });
                }
            }
            const status = await this.readStatus();
            if (status) {
                if (status.kind === 'refusal') {
                    return this.finish({
                        ok: true,
                        kind: 'refusal',
                        detail: {
                            class: 'relay-cap-refusal',
                            side: 'self',
                            error: status.text,
                        },
                        ms: Date.now() - t0,
                    });
                }
                if (status.kind === 'error') {
                    return this.finish({
                        ok: false,
                        kind: 'error',
                        detail: { error: status.text },
                        ms: Date.now() - t0,
                    });
                }
                if (status.kind === 'canceled') {
                    return this.finish({
                        ok: false,
                        kind: 'canceled',
                        detail: { error: status.text },
                        ms: Date.now() - t0,
                    });
                }
            }
            if (this.role === 'sender') {
                // The status read above matches `^Error: .*$`, so reaching
                // this line means no error status is shown.
                const readyMs = this.readyAfterDecisiveMs();
                if (
                    readyMs >= READY_AFTER_DECISIVE_MS &&
                    !(await this.busy())
                ) {
                    this.completion = COMPLETION_PILL_READY;
                    this.note(
                        `completion: ${COMPLETION_PILL_READY}: no "Sent n items" line matched, but the pill has read READY for ${readyMs} ms since ${this.decisive.text} at ${new Date(this.decisive.t).toISOString()}, the busy footer is gone and no error status shows; the receiver's hash check still guards integrity`
                    );
                    return this.finish({
                        ok: true,
                        kind: 'transfer',
                        detail: {
                            outcome: COMPLETION_PILL_READY,
                            readyMs,
                            route: this.decisive.verdict,
                        },
                        ms: Date.now() - t0,
                    });
                }
            }
            await sleep(1000);
        }
        await this.capture('done-timeout');
        throw new PhaseError(
            'done',
            `desktop ${this.role}: no completion text within ${timeoutMs} ms`
        );
    }

    async finish(result) {
        this._done = result;
        if (!this.completion) this.completion = result.kind;
        this.marks.done = Date.now();
        await this.capture(result.ok ? 'done' : 'failure');
        await this.snapshotTexts('done');
        return result;
    }

    async outputs() {
        if (this.role !== 'receiver') return [];
        const dir = this.opts.outDir;
        if (!dir || !existsSync(dir)) return [];
        const files = [];
        const parts = [];
        const walk = (d) => {
            for (const entry of readdirSync(d, { withFileTypes: true })) {
                const full = path.join(d, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.isFile()) {
                    const rel = path
                        .relative(dir, full)
                        .split(path.sep)
                        .join('/');
                    if (full.endsWith('.part')) parts.push(rel);
                    else
                        files.push({
                            name: entry.name,
                            rel,
                            path: full,
                            bytes: statSync(full).size,
                        });
                }
            }
        };
        walk(dir);
        if (parts.length) {
            throw new PhaseError(
                'verify',
                `desktop receiver: staging files left in ${dir}: ${parts.join(', ')}`,
                { parts }
            );
        }
        files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
        for (const f of files) f.sha256 = await sha256File(f.path);
        return files;
    }

    async busy() {
        try {
            const footer = await this.driver.readText(RE.busyFooter, {
                controlType: 'any',
                join: true,
            });
            return footer.length > 0;
        } catch {
            return false;
        }
    }

    async restoreSaveDir() {
        if (!this.saveDir.changed || !this.driver) return;
        try {
            const r = await this.driver.setValue(
                STRINGS.saveDirPlaceholder,
                this.saveDir.original ?? '',
                { scope: 'receive' }
            );
            this.saveDir.restored = r.after === (this.saveDir.original ?? '');
            this.note(
                `save dir restored to "${this.saveDir.original}" (ok=${this.saveDir.restored})`
            );
        } catch (err) {
            this.saveDir.restored = false;
            this.note(`save dir restore failed: ${err.message}`);
        }
    }

    /**
     * Cancel if busy (through the UI's own button, which satisfies the
     * CancelTransfer ordering contract), restore the remembered save dir,
     * capture, WM_CLOSE, wait; taskkill only our pid after two failed
     * rounds. "Close anyway" is never clicked here (cleanup only).
     */
    stop(reason) {
        // One stop per leg: the cell's teardown and shutdown() can both ask,
        // and both get the same promise (an async wrapper would mint a new
        // one per call).
        if (!this._stopPromise) this._stopPromise = this._stop(reason);
        return this._stopPromise;
    }

    async _stop(reason) {
        await super.stop(reason);
        this._stopped = true;
        this.stopSampler();
        let closeResult = null;
        let restoreError = null;
        try {
            if (this.driver) {
                try {
                    if (await this.busy()) {
                        await this.driver.click(STRINGS.cancel, {
                            controlType: 'Button',
                        });
                        const until = Date.now() + CANCEL_MS;
                        while (Date.now() < until) {
                            const s = await this.readStatus();
                            if (s && s.kind === 'canceled') break;
                            if (!(await this.busy())) break;
                            await sleep(500);
                        }
                    }
                } catch (err) {
                    this.note(`cancel: ${err.message}`);
                }
                await this.restoreSaveDir();
                await this.capture('stop');
                closeResult = await closeAndWait(this.driver, this.pid, {
                    lister: this.lister,
                    log: (l) => this.note(l),
                });
                this.note(`close: ${JSON.stringify(closeResult)}`);
            }
        } finally {
            // The user's desktop.json goes back whatever happened above: a
            // helper that died mid-close must not leave the edit behind.
            if (this.guard) {
                try {
                    this.guard.restore();
                } catch (err) {
                    restoreError = err;
                    this.note(`config restore: ${err.message}`);
                }
                this.recordGuard();
            }
            activeLegs.delete(this);
            if (this.ownClient && this.client) {
                await this.client.close();
                this.client = null;
                this.ownClient = false;
            }
        }
        // A restore mismatch is a SafetyError (exit 4); it is thrown after
        // the helper is closed so the mismatch never leaks a process.
        if (restoreError) throw restoreError;
        return closeResult;
    }

    evidence() {
        const plan = this.plan
            ? {
                  mode: this.plan.mode,
                  command: this.plan.command,
                  args: this.plan.args,
                  appData: this.plan.appData,
                  configPath: this.plan.configPath,
                  filesStaged: this.plan.filesStaged,
                  identity: this.plan.identity ?? null,
                  url: this.plan.url,
                  env: this.plan.env
                      ? {
                            APPDATA: this.plan.env.APPDATA ?? null,
                            FLOE_NO_UPDATE_CHECK:
                                this.plan.env.FLOE_NO_UPDATE_CHECK ?? null,
                            PION_LOG_TRACE:
                                this.plan.env.PION_LOG_TRACE ?? null,
                        }
                      : null,
              }
            : null;
        let statsProof = null;
        if (this.role === 'receiver') {
            if (this.mode === 'wailsdev') {
                statsProof = {
                    kind: 'settings-read',
                    reportStats: this.settingsRead
                        ? this.settingsRead.reportStats
                        : null,
                    migrated: this.settingsRead
                        ? this.settingsRead.migrated
                        : null,
                    ok: Boolean(
                        this.settingsRead &&
                        this.settingsRead.reportStats === false
                    ),
                };
            } else if (this.plan) {
                // The launch-time snapshot plus the guard's hashes: the cell
                // runner reads reportStats/migrated at verify and the restore
                // result at teardown (lib/cell.mjs statsProofCheck).
                const state = this.guard ? this.guard.state() : null;
                statsProof = {
                    ...(this.launchProof ??
                        statsProofFor(this.plan.configPath)),
                    sha256Before: state ? state.backupSha : null,
                    sha256After: state ? state.restoredSha : null,
                    restoredIdentical: state ? state.match : null,
                };
            } else {
                statsProof = {
                    kind: 'desktop.json-preflight',
                    reportStats: null,
                    migrated: null,
                    ok: false,
                    configPath: null,
                    sha256Before: null,
                    sha256After: null,
                    restoredIdentical: null,
                };
            }
        }
        return {
            surface: 'desktop',
            role: this.role,
            mode: this.mode,
            version: (this.opts.build && this.opts.build.version) ?? null,
            launch: plan,
            hwnd: this.hwnd,
            pid: this.pid,
            exe: this.exePath,
            packaged: this.exePath
                ? this.exePath.startsWith(WINDOWS_APPS)
                : null,
            marks: this.marks,
            captures: this.captures,
            samples: this.samples,
            decisive: this.decisive,
            completion: this.completion,
            texts: this.texts,
            code: this._code,
            link: this._link,
            saveDir: this.saveDir,
            config: this.guard ? this.guard.state() : null,
            done: this._done,
            statsProof,
            notes: this.notes,
        };
    }
}

export function createLeg(opts) {
    return new DesktopLeg(opts);
}

// ------------------------------------------------------------- preflight

function httpHead(url, timeoutMs = 3000) {
    return new Promise((resolve) => {
        const req = http.get(url, { timeout: timeoutMs }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
        });
        req.on('timeout', () => {
            req.destroy();
            resolve(0);
        });
        req.on('error', () => resolve(0));
    });
}

/** Get-AppxPackage read of the Store build: { present, version, tag, location }. */
export async function storePackage() {
    if (process.platform !== 'win32') return { present: false };
    const out = await runText('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-AppxPackage -Name '${PACKAGE_NAME}' | Select-Object -First 1 | ForEach-Object { $_.Version.ToString() + '|' + $_.InstallLocation }`,
    ]);
    const line = out.trim().split(/\r?\n/).find(Boolean);
    if (!line) return { present: false };
    const [version, location] = line.split('|');
    return {
        present: true,
        version,
        tag: tagForIdentity(version),
        location: location ?? null,
        exe: location ? path.join(location, EXE_NAME) : null,
    };
}

/**
 * { ok, reason, detail } without starting a transfer. Reasons: windows-only,
 * uia-helper, desktop-running, desktop-json-missing, store-missing,
 * desktop-exe-missing, wailsdev-down.
 */
export async function preflight(opts = {}) {
    const mode = resolveMode(opts);
    const detail = { mode };
    if (process.platform !== 'win32')
        return { ok: false, reason: 'windows-only', detail };
    if (mode === 'wailsdev') {
        const status = await httpHead(WAILSDEV_URL);
        detail.status = status;
        if (!status) return { ok: false, reason: 'wailsdev-down', detail };
        return { ok: true, reason: null, detail };
    }
    try {
        const { UiaClient } = await import('./uia.mjs');
        const client = new UiaClient();
        await client.open();
        try {
            detail.helper = await client.ping();
            if (mode !== 'store' && opts.build && opts.build.path) {
                detail.exeVersion = await client.exeVersion(opts.build.path);
            }
        } finally {
            await client.close();
        }
    } catch (err) {
        return {
            ok: false,
            reason: 'uia-helper',
            detail: { ...detail, error: err.message },
        };
    }
    const running = await listDesktopProcesses(opts.lister ?? defaultLister);
    detail.running = running;
    if (running.length) return { ok: false, reason: 'desktop-running', detail };
    if (mode === 'store') {
        detail.store = await storePackage();
        if (!detail.store.present)
            return { ok: false, reason: 'store-missing', detail };
        detail.configPath = defaultConfigPath();
        if (!detail.configPath || !existsSync(detail.configPath))
            return { ok: false, reason: 'desktop-json-missing', detail };
        return { ok: true, reason: null, detail };
    }
    const exe = opts.build && opts.build.path;
    detail.exe = exe ?? null;
    if (!exe || !existsSync(exe))
        return { ok: false, reason: 'desktop-exe-missing', detail };
    return { ok: true, reason: null, detail };
}

// ---------------------------------------------------------------- probes

/**
 * cleanup: put desktop.json back from the backup a run recorded in its
 * manifest ({ backup, configPath, sha256 }). Refuses while any
 * floe-desktop.exe runs (the app rewrites the file on exit) and writes
 * nothing when the file already matches the backup. With a fence the
 * target must be the fence's own desktop.json (the guard exception), so a
 * manifest edited to name another file is a SafetyError, never a write.
 */
export async function restoreConfig(
    record,
    { lister = defaultLister, fence = null } = {}
) {
    if (!record || !record.backup)
        return { ok: true, written: false, detail: 'no backup recorded' };
    const configPath = record.configPath || defaultConfigPath();
    if (!existsSync(record.backup))
        return {
            ok: false,
            written: false,
            detail: `backup missing at ${record.backup}`,
        };
    const running = await listDesktopProcesses(lister);
    if (running.length)
        return {
            ok: false,
            written: false,
            detail: `${EXE_NAME} running (pid ${running.map((r) => r.pid).join(', ')}); not restoring while the app can rewrite the file`,
        };
    const backup = readFileSync(record.backup);
    const want = sha256(backup);
    if (record.sha256 && record.sha256 !== want)
        return {
            ok: false,
            written: false,
            detail: `backup sha256 ${want.slice(0, 8)} differs from the recorded ${String(record.sha256).slice(0, 8)}; restore by hand`,
        };
    const current = existsSync(configPath)
        ? sha256(readFileSync(configPath))
        : null;
    if (current === want)
        return {
            ok: true,
            written: false,
            detail: `desktop.json already matches the backup (sha256 ${want.slice(0, 8)})`,
        };
    if (fence) fence.assertWritable(configPath, { viaGuard: true });
    writeFileSync(configPath, backup);
    const got = sha256(readFileSync(configPath));
    return {
        ok: got === want,
        written: true,
        detail: `desktop.json restored from ${record.backup}: want ${want.slice(0, 8)}, got ${got.slice(0, 8)}`,
    };
}

/** Trim a leg's evidence to what probe.json needs. */
function probeEvidence(ev) {
    if (!ev) return null;
    return {
        hwnd: ev.hwnd ?? null,
        pid: ev.pid ?? null,
        exe: ev.exe ?? null,
        packaged: ev.packaged ?? null,
        launch: ev.launch
            ? {
                  mode: ev.launch.mode,
                  command: ev.launch.command,
                  appData: ev.launch.appData,
                  configPath: ev.launch.configPath,
              }
            : null,
        config: ev.config ?? null,
        saveDir: ev.saveDir ?? null,
        captures: (ev.captures || []).map((c) => c.path),
        notes: ev.notes ?? [],
    };
}

/**
 * Pure: the aggregate lib/matrix.mjs gates on, from the per-probe results.
 * receiverDrivable is P1, saveDirSettable P9, senderDrivable P6; a probe
 * that errored or was skipped leaves its flag null (unknown), never false.
 * available is whether any probe got a window. present is the declared
 * presence (not --user-away); focusNeeded is false because UIA drives the
 * app through provider-side Invoke and SetValue calls.
 */
export function aggregateProbes(
    results,
    { userAway = false, mode = null } = {}
) {
    const by = Object.fromEntries(results.map((r) => [r.probe, r]));
    const known = (r) => r && r.verdict !== 'error' && r.verdict !== 'skipped';
    const p1 = by.P1;
    const p6 = by.P6;
    const p9 = by.P9;
    const launched = results.some((r) => r.evidence && r.evidence.hwnd);
    const receiverDrivable = known(p1) ? p1.verdict === 'drivable' : null;
    const saveDirSettable = known(p9)
        ? Boolean(
              p9.detail &&
              p9.detail.settable === true &&
              /^restored/.test(p9.verdict)
          )
        : null;
    const senderDrivable = known(p6)
        ? p6.verdict === 'packaged-argv-ok'
            ? true
            : p6.verdict === 'packaged'
              ? null
              : false
        : null;
    return {
        available: results.length ? launched : null,
        receiverDrivable,
        saveDirSettable,
        senderDrivable,
        present: !userAway,
        focusNeeded: false,
        mode,
        detail: results.length
            ? results.map((r) => `${r.probe} ${r.verdict}`).join('; ')
            : 'no probe ran',
        saveDirOriginal: p9 && p9.detail ? (p9.detail.original ?? null) : null,
        probes: by,
    };
}

/**
 * Every probe in PROBE_NAMES, sequentially, on one UIA helper, returning
 * aggregateProbes(). opts: mode (store | portable | head | wailsdev),
 * build, portableExe (the extracted portable exe for P2, since P2 cannot
 * redirect APPDATA on the Store build), out (evidence and the P6 argv
 * fixture live under <out>/probe), userAway, log.
 */
async function probeAll(opts) {
    const t0 = Date.now();
    const mode = opts.mode ?? resolveMode(opts);
    const userAway = Boolean(opts.userAway);
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    if (mode === 'wailsdev') {
        return {
            ...aggregateProbes([], { userAway, mode }),
            available: null,
            detail: 'wailsdev is driven through Playwright; the UIA probes do not apply',
            ms: Date.now() - t0,
        };
    }
    const probeDir = opts.out ? path.join(opts.out, 'probe') : null;
    if (probeDir) mkdirSync(probeDir, { recursive: true });
    const portableExe =
        opts.portableExe ??
        (mode !== 'store' && opts.build && opts.build.path
            ? opts.build.path
            : null);
    const skipped = (name, detail) => ({
        probe: name,
        verdict: 'skipped',
        detail,
        ms: 0,
    });
    const results = [];
    let client = null;
    try {
        if (!opts.uia) {
            const { UiaClient } = await import('./uia.mjs');
            client = new UiaClient({
                logPath: probeDir ? path.join(probeDir, 'uia.log') : null,
                root: opts.out ?? null,
            });
            await client.open();
        }
        const uia = opts.uia ?? client;
        for (const name of PROBE_NAMES) {
            let per;
            if (name === 'P2' && !portableExe) {
                per = skipped(
                    'P2',
                    mode === 'store'
                        ? 'no portable exe staged (store build): pass --desktop portable or stage the release zip under --bin-dir'
                        : 'no desktop exe to launch'
                );
            } else if (name === 'P6' && mode !== 'store') {
                per = skipped(
                    'P6',
                    `store only (${mode} builds take argv at spawn)`
                );
            } else if (name === 'P6' && !probeDir) {
                per = skipped('P6', 'no --out to stage the argv fixture in');
            } else {
                const perOpts = { ...opts, probe: name, mode, uia };
                if (name === 'P2') {
                    perOpts.mode = mode === 'head' ? 'head' : 'portable';
                    perOpts.build = {
                        ...(opts.build || {}),
                        path: portableExe,
                        launch: perOpts.mode,
                    };
                }
                if (name === 'P6') {
                    const dir = path.join(probeDir, 'p6');
                    mkdirSync(dir, { recursive: true });
                    const file = path.join(dir, 'p6-argv.txt');
                    writeFileSync(
                        file,
                        'transfer-audit probe P6: argv staging fixture\n'
                    );
                    perOpts.files = [file];
                }
                log(`probe ${name} starting (${perOpts.mode})`);
                per = await probe(perOpts);
                log(
                    `probe ${name}: ${per.verdict}${typeof per.detail === 'string' ? ` (${per.detail})` : ''}`
                );
            }
            results.push(per);
        }
    } catch (err) {
        // Only UiaClient.open() can land here (probe() never throws): every
        // probe that did not run reports that reason.
        for (const name of PROBE_NAMES)
            if (!results.some((r) => r.probe === name))
                results.push({
                    probe: name,
                    verdict: 'error',
                    detail: `UIA helper: ${err.message}`,
                    reason: err.reason ?? null,
                    ms: 0,
                });
    } finally {
        if (client) await client.close().catch(() => {});
    }
    const trimmed = results.map((r) => ({
        ...r,
        evidence: probeEvidence(r.evidence),
    }));
    return {
        ...aggregateProbes(trimmed, { userAway, mode }),
        ms: Date.now() - t0,
    };
}

/**
 * Step-0 probes run by the main session: P1 SetValue drives React, P2 the
 * APPDATA redirect isolates a launch, P6 Store launch with argv and the
 * packaged identity oracle, P8 SW_SHOWNOACTIVATE un-minimizes without
 * activation, P9 save-dir read-back and restore. With opts.probe one of
 * PROBE_NAMES the result is that probe's { probe, verdict, detail, notes,
 * evidence, ms }; without opts.probe every probe runs in turn and the
 * result is the aggregate audit.mjs gates cells on (aggregateProbes). Never
 * throws past this function; every window it opened is closed with WM_CLOSE
 * (taskkill only for a pid it spawned).
 */
export async function probe(opts = {}) {
    if (opts.probe === undefined || opts.probe === null || opts.probe === '')
        return probeAll(opts);
    const which = String(opts.probe).toUpperCase();
    const fn = PROBES[which];
    if (!fn) {
        return {
            probe: which || null,
            verdict: 'unknown-probe',
            detail: `probe wants one of ${Object.keys(PROBES).join(', ')}`,
        };
    }
    const t0 = Date.now();
    try {
        const out = await fn(opts);
        // Probes hand evidence back lazily so it is read after their
        // finally block closed the window and restored desktop.json.
        if (typeof out.evidence === 'function') out.evidence = out.evidence();
        return { probe: which, ...out, ms: Date.now() - t0 };
    } catch (err) {
        return {
            probe: which,
            verdict: 'error',
            detail: err.message,
            reason: err.reason ?? null,
            error: { name: err.name, stack: err.stack },
            ms: Date.now() - t0,
        };
    }
}

/** Launch for a probe: a DesktopLeg used only for launch/stop plumbing. */
async function probeLeg(opts, files = []) {
    const mode = opts.mode ?? resolveMode(opts);
    const evidenceDir =
        opts.evidenceDir ??
        (opts.out
            ? path.join(
                  opts.out,
                  'probe',
                  String(opts.probe || 'p').toLowerCase()
              )
            : null);
    const leg = new DesktopLeg({
        ...opts,
        role: opts.role ?? 'receiver',
        build: {
            ...(opts.build || {}),
            launch: mode === 'head' ? 'head' : mode,
        },
        evidenceDir,
        infra: opts.infra ?? {
            server: 'http://127.0.0.1:9',
            web: 'http://127.0.0.1:9',
        },
    });
    await leg.launch(files);
    return leg;
}

async function closeLeg(leg, notes) {
    if (!leg) return;
    try {
        const r = await leg.stop('probe done');
        notes.push(`close: ${JSON.stringify(r)}`);
    } catch (err) {
        notes.push(`close error: ${err.message}`);
    }
}

const PROBES = {
    async P1(opts) {
        const notes = [];
        let leg = null;
        const detail = {};
        try {
            leg = await probeLeg(opts);
            const d = leg.driver;
            await d.click(STRINGS.tabReceive, { index: 0 });
            const set = await d.setValue(
                STRINGS.codePlaceholder,
                'zzz-zzz-zzz'
            );
            detail.set = set;
            await d.click(STRINGS.tabSend, { index: 0 });
            await sleep(300);
            await d.click(STRINGS.tabReceive, { index: 0 });
            await sleep(300);
            const back = await d.getValue(STRINGS.codePlaceholder);
            detail.afterTabFlip = back.value;
            await d.click(STRINGS.receiveButton, {
                after: STRINGS.codePlaceholder,
            });
            let status = null;
            const until = Date.now() + STATUS_MS;
            while (Date.now() < until) {
                status = await leg.readStatus();
                if (status && status.kind !== 'other') break;
                await sleep(250);
            }
            detail.status = status;
            await leg.capture('p1');
            try {
                await d.click(STRINGS.cancel, { controlType: 'Button' });
            } catch (err) {
                notes.push(`cancel: ${err.message}`);
            }
            const survived = back.value === 'zzz-zzz-zzz';
            // The app acted on the value either way: "Connecting..." on a
            // reachable server, or the server error on the unroutable one
            // the probe config points at. Only "Please enter a code or
            // link." means React never saw the SetValue.
            const acted = Boolean(
                status &&
                (status.kind === 'connecting' || status.kind === 'error')
            );
            const verdict =
                survived && acted
                    ? 'drivable'
                    : status && status.kind === 'enter-code'
                      ? 'not-drivable'
                      : survived
                        ? 'partial'
                        : 'not-drivable';
            return { verdict, detail, notes, evidence: () => leg.evidence() };
        } finally {
            await closeLeg(leg, notes);
        }
    },

    async P2(opts) {
        const notes = [];
        const detail = {};
        const real = defaultConfigPath();
        const realDir = real ? path.dirname(real) : null;
        const before =
            real && existsSync(real)
                ? {
                      sha: sha256(readFileSync(real)),
                      mtimeMs: statSync(real).mtimeMs,
                  }
                : null;
        const entriesBefore =
            realDir && existsSync(realDir) ? readdirSync(realDir).sort() : [];
        let leg = null;
        try {
            leg = await probeLeg({
                ...opts,
                mode: opts.mode === 'head' ? 'head' : 'portable',
            });
            await sleep(opts.settleMs ?? 5000);
            const appData = leg.plan.appData;
            detail.appData = appData;
            detail.scratchConfig = existsSync(
                path.join(appData, 'floe', 'desktop.json')
            );
            detail.scratchWebview = existsSync(
                path.join(appData, 'floe', 'webview', 'EBWebView')
            );
            const after =
                real && existsSync(real)
                    ? {
                          sha: sha256(readFileSync(real)),
                          mtimeMs: statSync(real).mtimeMs,
                      }
                    : null;
            const entriesAfter =
                realDir && existsSync(realDir)
                    ? readdirSync(realDir).sort()
                    : [];
            detail.real = {
                path: real,
                before,
                after,
                unchanged: JSON.stringify(before) === JSON.stringify(after),
            };
            detail.newEntries = entriesAfter.filter(
                (e) => !entriesBefore.includes(e)
            );
            const untouched =
                detail.real.unchanged && detail.newEntries.length === 0;
            let verdict = 'not-redirected';
            if (detail.scratchConfig && detail.scratchWebview && untouched)
                verdict = 'isolated';
            else if (detail.scratchConfig && untouched) verdict = 'config-only';
            else if (detail.scratchConfig && !detail.scratchWebview)
                verdict = 'config-only-webview-leaked';
            return { verdict, detail, notes, evidence: () => leg.evidence() };
        } finally {
            await closeLeg(leg, notes);
        }
    },

    async P6(opts) {
        const notes = [];
        const detail = {};
        const files = (opts.files || []).map(String);
        let leg = null;
        try {
            leg = await probeLeg(
                { ...opts, mode: 'store', role: 'sender' },
                files
            );
            const d = leg.driver;
            detail.exe = leg.exePath;
            detail.underWindowsApps = Boolean(
                leg.exePath && leg.exePath.startsWith(WINDOWS_APPS)
            );
            detail.argvHonored = files.length
                ? await leg.waitForButton(sendButtonName(files.length), 10_000)
                : null;
            await d.click(STRINGS.settings, { controlType: 'Button' });
            await sleep(500);
            const rows = await d.readText(RE.checkForUpdates, {
                controlType: 'any',
            });
            detail.checkForUpdatesRow = rows.length > 0;
            detail.packaged = rows.length === 0;
            await leg.capture('p6-settings');
            await d.click(STRINGS.settings, { controlType: 'Button' });
            const verdict = detail.packaged
                ? detail.argvHonored
                    ? 'packaged-argv-ok'
                    : detail.argvHonored === null
                      ? 'packaged'
                      : 'packaged-argv-dropped'
                : 'unpackaged';
            return { verdict, detail, notes, evidence: () => leg.evidence() };
        } finally {
            await closeLeg(leg, notes);
        }
    },

    async P8(opts) {
        const notes = [];
        const detail = {};
        let leg = null;
        try {
            leg = await probeLeg(opts);
            const d = leg.driver;
            const fgBefore = await d.foregroundCheck();
            detail.foregroundBefore = fgBefore;
            if (
                !(
                    await leg.client.findWindow({
                        pid: leg.pid,
                        timeoutMs: 1000,
                    })
                ).minimized
            ) {
                // Minimize through the app's own titlebar button (UIA Invoke).
                await d.click(STRINGS.minimize, { controlType: 'Button' });
                await sleep(500);
            }
            const minimized = (
                await leg.client.findWindow({ pid: leg.pid, timeoutMs: 1000 })
            ).minimized;
            detail.minimized = minimized;
            const shown = await d.show();
            detail.show = shown;
            await sleep(300);
            const fgAfter = await d.foregroundCheck();
            detail.foregroundAfter = fgAfter;
            detail.unminimized = !shown.iconic;
            detail.activated =
                Boolean(fgAfter.foreground) && !fgBefore.foreground;
            await leg.capture('p8');
            const verdict = !minimized
                ? 'could-not-minimize'
                : detail.unminimized && !detail.activated
                  ? 'no-activation'
                  : detail.unminimized
                    ? 'activated'
                    : 'still-minimized';
            return { verdict, detail, notes, evidence: () => leg.evidence() };
        } finally {
            await closeLeg(leg, notes);
        }
    },

    async P9(opts) {
        const notes = [];
        const detail = {};
        let leg = null;
        const probeValue =
            opts.value ?? path.join(opts.out ?? process.cwd(), 'p9-save-dir');
        try {
            leg = await probeLeg(opts);
            const d = leg.driver;
            await d.click(STRINGS.tabReceive, { index: 0 });
            const original =
                (
                    await d.getValue(STRINGS.saveDirPlaceholder, {
                        scope: 'receive',
                    })
                ).value ?? '';
            detail.original = original;
            detail.value = probeValue;
            const set = await d.setValue(
                STRINGS.saveDirPlaceholder,
                probeValue,
                { scope: 'receive' }
            );
            detail.set = set.after;
            detail.settable = set.after === probeValue;
            const back = await d.setValue(
                STRINGS.saveDirPlaceholder,
                original,
                { scope: 'receive' }
            );
            detail.restoredInSession = back.after === original;
            await leg.capture('p9');
            await closeLeg(leg, notes);
            leg = null;
            if (opts.relaunch !== false) {
                leg = await probeLeg(opts);
                await leg.driver.click(STRINGS.tabReceive, { index: 0 });
                const again =
                    (
                        await leg.driver.getValue(STRINGS.saveDirPlaceholder, {
                            scope: 'receive',
                        })
                    ).value ?? '';
                detail.afterRelaunch = again;
                detail.restoredAcrossRelaunch = again === original;
            }
            const verdict =
                detail.restoredAcrossRelaunch === true
                    ? 'restored-across-relaunch'
                    : detail.restoredInSession
                      ? 'restored-in-session'
                      : 'not-restored';
            return {
                verdict,
                detail,
                notes,
                evidence: () => (leg ? leg.evidence() : null),
            };
        } finally {
            await closeLeg(leg, notes);
        }
    },
};

export const PROBE_NAMES = Object.freeze(Object.keys(PROBES));
