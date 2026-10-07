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
//   portable  the checksum-verified release exe, started with
//   head      APPDATA=<scratch>\appdata and FLOE_NO_UPDATE_CHECK=1 so its
//             desktop.json, WebView2 profile and history never reach the
//             user's tree. Measured (P2, 2026-08-29): the redirected launch
//             created <scratch>\appdata\floe\desktop.json and
//             ...\floe\webview\EBWebView and left the real %APPDATA%\floe
//             untouched (sha, mtime, file count), so the audit values are
//             written into the redirected desktop.json BEFORE launch. The
//             exe prints `[WebView2] Environment created successfully` on
//             stdout, which a detached launch (below) no longer keeps.
//   wailsdev  Playwright page on http://localhost:34115; the thinnest lane,
//             kept for the HEAD receiver when UIA cannot drive the input.
//
// HEAD builds: buildHead() turns lib/release.mjs headDesktopCommands()'s
// plan into the build audit.mjs drives. The wailsdev lane runs no build step
// and only requires the operator's dev server to answer, so it returns no
// exe path (P7 reads n/a); the portable lane runs npm run build then wails
// build and requires the exe's mtime to advance, because `wails build` can
// exit 0 on a silent failure. Neither lane writes outside the plan's build
// dirs, which go through the fence before the first step runs.
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
// Launching (FU-26, from the FU-02 addendum): every exe, and the
// explorer.exe that starts the Store build by AUMID, is started through
// lib/detached.mjs (Win32_Process.Create), so the WMI provider host is its
// parent and it holds no foreground rights even while the operator's
// terminal is the foreground window; its first window shows
// SW_SHOWNOACTIVATE. That gives up the stdout and stderr pipes. A leg never
// starts a second instance: while any floe-desktop.exe or
// floe-desktop-dev.exe (the app wails dev runs) is up, launch() is SKIP
// desktop-running before anything starts, because the single-instance
// lock (SINGLE_INSTANCE_ID) forwards a second launch to the running app,
// which raises its own window (desktop/app.go onSecondInstanceLaunch).
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
// sees it. The per-user Explorer verb an unpackaged launch rewrites is
// snapshotted once per process and put back by stop() and the same exit hook
// (ShellMenuGuard).
//
// Every expected string is quoted from desktop/frontend/src/App.tsx,
// TitleBar.tsx, incoming.ts and desktop/transfer.go; see STRINGS and RE below.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    createReadStream,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { SW, launchDetached } from './detached.mjs';
import { sha256OfFile } from './fixtures.mjs';
import { registerPid, started } from './proc.mjs';
import { Leg, PhaseError, SafetyError, sleep } from './surfaces.mjs';
import { defaultExec } from './versions.mjs';

// ------------------------------------------------------------- constants

export const AUMID = 'JanCarloParedes.FloeDesktop_r1y5w9chaxnzc!FloeDesktop';
export const PACKAGE_NAME = 'JanCarloParedes.FloeDesktop';
export const PACKAGE_FAMILY = 'JanCarloParedes.FloeDesktop_r1y5w9chaxnzc';
export const WINDOWS_APPS = 'C:\\Program Files\\WindowsApps\\';
export const EXE_NAME = 'floe-desktop.exe';
// The app `wails dev` builds and runs; it holds the same single-instance
// lock, so the second-instance refusal counts it too (FU-26).
export const DEV_EXE_NAME = 'floe-desktop-dev.exe';
export const WINDOW_CLASS = 'wailsWindow'; // wails v2.12.0 window.go:81
export const WINDOW_TITLE = 'Floe'; // desktop/main.go, the wails.Run Title option
export const SINGLE_INSTANCE_ID = 'one.floe.desktop'; // desktop/main.go, the wails.Run SingleInstanceLock.UniqueId option
export const WAILSDEV_URL = 'http://localhost:34115';
export const LAUNCH_MODES = Object.freeze([
    'store',
    'portable',
    'head',
    'wailsdev',
]);

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
    codeChoice: 'Code', // Receive > CODE | REQUEST LINK (R1), always shown since H7 (no Settings switch)
    receiveButton: 'Receive', // primary button on the receive view
    cancel: 'Cancel',
    settings: 'Settings', // TitleBar.tsx aria-label
    minimize: 'Minimize', // TitleBar.tsx aria-label
    startOver: 'Start over', // TitleBar.tsx aria-label
    closeTitle: 'Close Floe?',
    // The Close Floe? dialog's pair in every case since D-170 (the released
    // app says Keep going and Close anyway; STRINGS_RELEASED below).
    keepGoing: 'Keep open',
    closeAnyway: 'Close',
    checkForUpdates: 'Check for updates', // Settings row, hidden when packaged
    // The calm copy (D-167, desktop H9 on): no closing periods. A released
    // app before it says what STRINGS_RELEASED holds, and every reader below
    // accepts both, so one audit drives the Store app and HEAD alike.
    waitingForReceiver: 'Waiting for the receiver',
    peerConnected: 'Sending...', // desktop/transfer.go runSend
    connecting: 'Connecting...',
    enterCode: 'Enter a code or link',
    canceled: 'Canceled',
    busyFooter: "Keep this window open until it's done",
    relayCap: 'relay connections are capped', // errors.ts PASSTHROUGH
    settingUp: 'Setting up...',
    hideIpRow: 'Hide my IP address', // Settings > Privacy SettingRow label
});

/** The same lines as a desktop release before the calm copy (D-167) draws them. */
export const STRINGS_RELEASED = Object.freeze({
    waitingForReceiver: 'Waiting for the receiver...',
    peerConnected: 'Peer connected. Sending...',
    connecting: 'Connecting... keep this window open.',
    enterCode: 'Please enter a code or link.',
    canceled: 'Canceled.',
    busyFooter: 'Keep this window open. Closing it cancels the transfer.',
    keepGoing: 'Keep going',
    closeAnyway: 'Close anyway',
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
    // TA-10a only: a link made with Auto-accept on reads AUTO-ACCEPT in the
    // chip while it waits and nothing moves (H4, D-173). An idle word like
    // READY: never a route verdict (pillVerdict reads it as unknown).
    pillAuto: /^(Ready|Active|Direct|Relay|Auto-accept)$/i,
    status: /^(Connecting\.\.\.(?: keep this window open\.)?|(?:Please e|E)nter a code or link\.?|Canceled\.?|Error: .*)$/i,
    error: /^Error: /i,
    progress: /^(\[\d+\/\d+\] )?.+ - \d+%  \(/i,
    busyFooter: /^(?:Keep this window open\. Closing it cancels the transfer\.|Keep this window open until it's done)$/i,
    peerConnected: /^(?:Peer connected\. )?Sending\.\.\.$/i,
    checkForUpdates: /^Check for updates$/i,
    protocolRow: /^Version (\d+)$/i,
    // The Settings switch takes its accessible name from the label that
    // wraps it, which carries the row description too, so this matches a
    // part of that name rather than all of it.
    hideIpRow: /Hide my IP address/i,
    // A request drop's done heading (DN1): RECEIVED 12 FILES, 38.0 GB.
    requestDone: /^RECEIVED (\d+) FILES?, .+$/i,
});

/**
 * The request link host's fixed UI strings, quoted from the frozen copy
 * (work/16-design/cp-3/approved-copy-desktop.md, the row id beside each;
 * desktop/frontend/src/requestCopy.ts and settings.ts carry the same bytes,
 * approvedCopy.test.ts checks them). Every action is a button in
 * RequestLinkView.tsx and the save folder is an input found by its
 * placeholder. Settings has no Request links row since H7 (D-160, S1 to S5
 * cut): the REQUEST LINK choice is always on Receive. `lifetimes` maps each
 * Link ends key the host takes (requestLifetime in desktop/requestlink.go)
 * to its option label, in list order (D-173; R24 to R27 join the table with
 * the H10 records); lifetime24h and lifetime7d stay for existing callers.
 */
export const REQUEST_STRINGS = Object.freeze({
    choice: 'Request link, beta', // R3, the row choice's accessible name
    lifetime24h: 'In 24 hours', // R12, the default
    lifetime7d: 'In 7 days', // R13
    lifetimes: Object.freeze({
        '30m': 'In 30 minutes', // R24
        '1h': 'In 1 hour', // R25
        '8h': 'In 8 hours', // R26
        '24h': 'In 24 hours', // R12, the default
        '3d': 'In 3 days', // R27
        '7d': 'In 7 days', // R13
    }),
    makeLink: 'Make link', // R14
    copyLink: 'Copy link', // W2, shown while the link waits
    closeLink: 'Close link', // W4
    accept: 'Accept', // P9
    decline: 'Decline', // P9
    keepWaiting: 'Keep waiting', // D3
    makeAnother: 'Make another link', // X3, after Close link
    saveToPlaceholder: 'Downloads\\Floe', // R9, the Save to field (D-167)
    cancelDrop: 'Cancel drop', // V4
    // DN3 since H7 (D-161): not a visible line any more but the sr-only text
    // beside the green check after the done heading, so it is still one Text
    // node of its own for UIA and a span of its own for the dev page. Both
    // readers key on these exact words.
    verifiedLine: 'SHA-256 matched',
    // Auto-accept (D-173): the Make link form's switch, a checkbox whose
    // accessible name is its label, and the chip word while such a link
    // waits. Only TA-10a turns it on; every other cell leaves it off.
    autoAcceptSwitch: 'Auto-accept', // R29 (D-174: the inline check under LINK ENDS)
    autoAcceptPill: 'Auto-accept', // H4, CSS-uppercased as AUTO-ACCEPT
});

// The Link ends keys as MakeLink's refusal lists them: "30m, 1h, ... or 7d".
const LIFETIME_KEYS = Object.keys(REQUEST_STRINGS.lifetimes);
const LIFETIME_KEYS_TEXT = `${LIFETIME_KEYS.slice(0, -1).join(', ')} or ${LIFETIME_KEYS.at(-1)}`;

/**
 * The option label of a Link ends key, or null for anything the host would
 * refuse: a key outside the six, any other spelling, or not a string.
 */
function lifetimeLabel(key) {
    return typeof key === 'string' && Object.hasOwn(REQUEST_STRINGS.lifetimes, key)
        ? REQUEST_STRINGS.lifetimes[key]
        : null;
}

/**
 * One button the REQUEST LINK view shows in each lane state, so a page that
 * shows none of them is not on the view: Close link (waiting through
 * declined, W4), Cancel drop (receiving, V4), Make another link (done,
 * stopped and ended, X3 and DN7; DN2 Dismiss is cut, D-169), Make link
 * (ready or error, R14).
 */
const REQUEST_VIEW_MARKS = Object.freeze([
    REQUEST_STRINGS.closeLink,
    REQUEST_STRINGS.cancelDrop,
    REQUEST_STRINGS.makeAnother,
    REQUEST_STRINGS.makeLink,
]);

/**
 * A lane code as the host sent it (a key into requestCopy.ts, never text),
 * or `?` for anything that is not one: it is quoted into messages.
 */
export function safeCode(code) {
    const s = String(code ?? '');
    return /^[a-z0-9-]{1,40}$/.test(s) ? s : '?';
}

/** Two paths name the same folder (Windows compares without case). */
export function samePath(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b)
        return false;
    const norm = (p) =>
        path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
    return norm(a) === norm(b);
}

/**
 * The prompt's buttons ignore input for 1 s after it appears (spec 06 P9,
 * E-44). The audit waits at least ACCEPT_WAIT_MS from the moment it first
 * SAW the prompt, which is never earlier than the moment it mounted, so the
 * click always lands after the guard.
 */
export const ACCEPT_GUARD_MS = 1_000;
export const ACCEPT_WAIT_MS = 1_200;
export const REQUEST_POLL_MS = 50;

/**
 * A request link (spec 06 4.4 Link: web + "/r/" + linkId + "#" + roomId).
 * The room id after `#` is a secret for the life of the link: it goes to
 * the visitor leg and nowhere else (never a log line, audit.md or run.json).
 */
export const REQUEST_LINK_RE =
    /^https?:\/\/[^\s/#]+\/r\/[A-Za-z0-9_-]+#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The link with its room fragment removed, for any line a person reads. */
export function redactRequestLink(link) {
    const s = String(link ?? '');
    const i = s.indexOf('#');
    return i < 0 ? s : `${s.slice(0, i)}#<room>`;
}

export const sameText = (a, b) =>
    String(a ?? '')
        .trim()
        .toLowerCase() ===
    String(b ?? '')
        .trim()
        .toLowerCase();

/**
 * The fixed copy the UIA lane reads the host's lane state from, where no
 * bound GetRequestLink call exists (S1-REL-03a step 5, FU-26). Quoted from
 * desktop/frontend/src/requestCopy.ts (the frozen cp-3 desktop table, row
 * ids beside each); a code maps back from its fixed sentence only, never
 * from anything a visitor chose (OD-04: the prompt carries numbers only).
 */
export const REQUEST_COPY = Object.freeze({
    // E1, E2, E4 to E7: errorLine(code).
    errors: Object.freeze({
        disabled: 'Request links are off on this server',
        limited: "This network reached today's link limit",
        unknown: "Couldn't make a link",
        'no-relay': "Hide my IP needs a relay this server doesn't have",
        'relay-unknown': "Couldn't read this server's relay details for Hide my IP",
        'already-open': 'Close your open link to make a new one',
    }),
    // ST1 to ST12: the card sentence each stop code starts with.
    stops: Object.freeze({
        'disk-full': 'The drive ran out of space',
        'hash-mismatch': "A file didn't match what was sent and was deleted",
        'path-too-long': 'A folder path was too long for Windows',
        'over-approved': 'More data arrived than you accepted',
        'relay-cap': 'Over the 2 GB relay limit · Nothing saved',
        'file-too-large-for-folder': 'A file is too large for this drive',
        'write-failed': "Windows couldn't write to the folder",
        'save-blocked': 'Windows blocked Floe from saving a file',
        stopped: 'You stopped this drop',
        'peer-abort': 'The sender stopped this drop',
        'time-limit': 'The drop reached the 24-hour limit',
    }),
    making: 'Making link...', // R16
    reconnecting: "Can't reach the Floe server", // C1
    connecting: 'Connecting to the sender...', // W12
    retryNow: 'Retry now', // C2
    stoppedHeading: 'DROP STOPPED', // ST0
    linkClosed: 'Link closed', // X2
    linkEndedAt: /^Link ended at /i, // X1
    promptSize: /^(\d+) files?, (.+)$/i, // P2 promptSize
    receiving: /^RECEIVING (\d+) OF (\d+)/i, // V1
    savedOf: /(?:^| · )(\d+) of (\d+) files? saved$/i, // ST16, after a middle dot (D-167)
    nothingSaved: /Nothing saved$/i, // ST16
    renamedOne: /^1 file now ends in \.floe-blocked/i, // DN4
    renamedMany: /^(\d+) files now end in \.floe-blocked/i, // DN4p
    // P4, P5, P6, P11: warningLine(code), mapped back to the code. P11 (the
    // laptop line) left the prompt in H7 (D-161) for the Receiving view, where
    // it reads "Keep this laptop plugged in and open" and shows only on a PC
    // with a battery, so its absence on a prompt is never a finding. Either
    // wording is still read here, so a prompt that draws the line (the HP
    // build, or a regression) shows laptop-power in the attempt's evidence.
    warnings: Object.freeze([
        ['low-space', /^Only .+ free on .+, not enough for this drop$/i],
        ['file-too-large-for-drive', /^This drive can't save files over 4 GB$/i],
        ['relay-over-cap', /^This .+ drop is over the 2 GB Hide my IP limit$/i],
        ['laptop-power', /^(?:On a laptop, plug in and keep the lid open|Keep this laptop plugged in and open)\.?$/i],
    ]),
});

/**
 * desktop/frontend/src/incoming.ts fmtBytes: 1024-based, KB MB GB TB with
 * one decimal. The UIA lane can read only this rendering of a drop's size, so
 * the prompt check compares it with the fixture's total in the same form.
 */
export function desktopFmtBytes(n) {
    if (!n || n < 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}

const isAbsWin = (p) =>
    /^[A-Za-z]:[\\/]/.test(String(p ?? '')) || /^\\\\/.test(String(p ?? ''));

/**
 * The request link lane as the REQUEST LINK view shows it, from one UIA
 * snapshot of the window (`snapshot` with values): the buttons each phase
 * shows (RequestLinkView.tsx), then its fixed copy for the codes, the
 * prompt's numbers (P2: the count and the rendered size; the exact byte
 * count is not on screen, so totalBytes is null and sizeText carries the
 * rendering), its host-computed folder (P3, an absolute path under the made
 * save folder) and warnings, and a result's counts (DN1 carries the saved
 * count; DN3, the check mark's sr-only text, shows only when every file
 * matched, so it alone vouches for files and verified, which read null
 * without it; verifyRequest in request.mjs fails a done view without it).
 * `gen` and `saveDir` are the UIA driver's own record of the links it made:
 * the view shows neither.
 * `state` is `unknown` when the view is not showing (another tab, Settings).
 */
export function requestStateFromItems(items, { gen = 0, saveDir = '' } = {}) {
    const list = Array.isArray(items) ? items : [];
    const buttons = list
        .filter((x) => x && x.type === 'Button' && x.name)
        .map((x) => ({ name: String(x.name), enabled: x.enabled !== false }));
    const texts = list
        .filter((x) => x && x.type === 'Text' && x.name)
        .map((x) => String(x.name).trim())
        .filter(Boolean);
    const has = (name) => buttons.some((b) => sameText(b.name, name));
    const hasText = (t) => texts.some((x) => sameText(x, t));
    const S = REQUEST_STRINGS;
    const C = REQUEST_COPY;
    const out = {
        source: 'uia',
        state: 'unknown',
        code: '',
        gen,
        saveDir: saveDir || '',
        link: '',
        route: '',
        prompt: undefined,
        result: undefined,
    };
    const link = list.find(
        (x) =>
            x &&
            (x.type === 'Edit' || x.type === 'Document') &&
            REQUEST_LINK_RE.test(String(x.value ?? ''))
    );
    if (has(S.accept) && has(S.decline)) out.state = 'deciding';
    else if (has(S.keepWaiting)) out.state = 'declined';
    else if (has(S.cancelDrop)) out.state = 'receiving';
    else if (has(S.closeLink))
        out.state =
            has(C.retryNow) || hasText(C.reconnecting)
                ? 'reconnecting'
                : hasText(C.connecting)
                  ? 'connecting'
                  : 'waiting';
    // Done and Stopped end in Make another link too (D-169, no Dismiss):
    // their headings tell them from Ended.
    else if (has(S.makeAnother))
        out.state = hasText(C.stoppedHeading)
            ? 'stopped'
            : texts.some((t) => RE.requestDone.test(t))
              ? 'done'
              : 'ended';
    else if (has(C.making)) out.state = 'making';
    else if (has(S.makeLink)) {
        const code = Object.entries(C.errors).find(([, line]) => hasText(line));
        out.state = code ? 'error' : 'ready';
        if (code) out.code = code[0];
    }
    if (
        ['waiting', 'reconnecting', 'connecting', 'deciding', 'declined'].includes(out.state) &&
        link
    )
        out.link = String(link.value);
    if (out.state === 'ended')
        // X5 is cut (D-170): a relaunch shows the Make link form, not an end.
        out.code = texts.some((t) => C.linkEndedAt.test(t)) ? 'expired' : 'closed';
    const underSave = (t) =>
        isAbsWin(t) && (!saveDir || samePath(path.dirname(t), saveDir));
    if (out.state === 'deciding') {
        const size = texts.map((t) => C.promptSize.exec(t)).find(Boolean);
        const warnings = [];
        for (const [code, rx] of C.warnings)
            if (texts.some((t) => rx.test(t))) warnings.push(code);
        out.prompt = {
            files: size ? Number(size[1]) : null,
            totalBytes: null,
            sizeText: size ? size[2] : null,
            folder: texts.find(underSave) ?? null,
            warnings,
        };
    }
    if (out.state === 'done' || out.state === 'stopped') {
        const renamed = texts.some((t) => C.renamedOne.test(t))
            ? 1
            : Number(texts.map((t) => C.renamedMany.exec(t)).find(Boolean)?.[1] ?? 0);
        if (out.state === 'done') {
            const m = texts.map((t) => RE.requestDone.exec(t)).find(Boolean);
            const saved = m ? Number(m[1]) : null;
            const verifiedLine = hasText(S.verifiedLine);
            out.result = {
                files: verifiedLine ? saved : null,
                saved,
                verified: verifiedLine ? saved : null,
                renamed,
                folder: null,
                verifiedLine,
            };
        } else {
            const card =
                texts.find((t) => Object.values(C.stops).some((s) => t.startsWith(s))) ??
                texts.find((t) => C.savedOf.test(t) || C.nothingSaved.test(t)) ??
                '';
            const stop = Object.entries(C.stops).find(([, s]) => card.startsWith(s));
            out.code = stop ? stop[0] : 'unknown';
            const counts = C.savedOf.exec(card);
            out.result = {
                files: counts ? Number(counts[2]) : null,
                saved: counts ? Number(counts[1]) : C.nothingSaved.test(card) ? 0 : null,
                verified: null,
                renamed,
                folder: null,
                verifiedLine: false,
            };
        }
    }
    return out;
}

export const FIND_WINDOW_MS = 30_000;
export const TREE_MS = 20_000;
export const STAGE_MS = 20_000;
export const CODE_MS = 30_000;
/**
 * How long a sender waits for the room code once the share link is up.
 * They render together, so this only covers the gap between two reads; a
 * sender that really registered none spends it once and then reports.
 */
export const CODE_AFTER_LINK_MS = 3_000;
export const STATUS_MS = 10_000;
export const CANCEL_MS = 10_000;
export const EXIT_MS = 15_000;
// How long launch() waits for an instance this process started, and is
// still closing, before it reads as a second instance (FU-26).
export const SECOND_INSTANCE_WAIT_MS = 5_000;
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

// The tag parser and the pack.ps1 identity rule (desktop-v0.2.8 -> 1.2.8.0:
// the Store refuses a 0 first octet) are versions.mjs's; this module used to
// carry byte-identical copies. Re-exported so the module's surface is
// unchanged (desktop.test.mjs imports them from here). The inverse mapping
// below stays local: storePackage depends on its strict shape rule.
export { parseTag, identityVersion } from './versions.mjs';

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

/**
 * An XPath 1.0 string literal for an arbitrary value. XPath 1.0 has no
 * escape sequence, so a value carrying both quote characters can only be
 * written as concat() of its pieces.
 */
/**
 * A share link the receiver can be driven with: an http(s) URL carrying a
 * `#room=` fragment. The wailsdev page's read used to hand the whole page
 * text to the web receiver, which failed as
 * `page.goto: Cannot navigate to invalid URL` (H-DIR-D2W, 2026-09-22), so
 * what the driver reads is parsed before it is believed.
 */
export function isRoomLink(value) {
    let url;
    try {
        url = new URL(String(value).trim());
    } catch {
        return false;
    }
    return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.hash.startsWith('#room=') &&
        url.hash.length > '#room='.length
    );
}

export function xpathLiteral(value) {
    const v = String(value);
    if (!v.includes("'")) return `'${v}'`;
    if (!v.includes('"')) return `"${v}"`;
    return `concat(${v
        .split("'")
        .map((part) => `'${part}'`)
        .join(`,"'",`)})`;
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
 * GitHub check off; server/web point the app at the infra under test. There
 * is no requestLinks key any more (D-160 removed the Settings > Beta switch
 * and the field): a legacy one in the record is kept as it is and the app
 * ignores it.
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

/**
 * Every running Floe desktop: floe-desktop.exe and the wails dev app
 * floe-desktop-dev.exe (FU-26), which share the single-instance lock.
 * Injectable for tests.
 */
export async function listDesktopProcesses(lister = defaultLister) {
    const rows = await lister();
    return rows.filter((r) => r.image === EXE_NAME || r.image === DEV_EXE_NAME);
}

async function defaultLister() {
    if (process.platform !== 'win32') return [];
    const out = await runText('tasklist', [
        '/FI',
        // Both images (EXE_NAME and DEV_EXE_NAME); tasklist takes a trailing *.
        'IMAGENAME eq floe-desktop*',
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
    const is = (key) => sameText(t, STRINGS[key]) || sameText(t, STRINGS_RELEASED[key]);
    if (is('connecting')) return { kind: 'connecting', text: t };
    if (is('enterCode')) return { kind: 'enter-code', text: t };
    if (is('canceled')) return { kind: 'canceled', text: t };
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
 * It then puts the original access and modification times back with
 * utimesSync and reads the mtime again (S1-REL-03a harness fix 14): an mtime
 * that will not come back (a refused utime, a volume that drops it) is
 * reported as changed, never as a mismatch, because the contents are what
 * the app reads.
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
            statSync,
            utimesSync,
        };
        this.backup = null;
        this.backupPath = null;
        this.sha = null;
        this.editedSha = null;
        this.restoredSha = null;
        this.applied = false;
        this.restored = false;
        this.mtimeMs = null;
        this.atimeMs = null;
        this.mtimeRestored = null;
        this.mtimeNote = null;
    }

    // A test may hand in an fs without the time calls; the real ones then serve.
    _stat(p) {
        return (this.fs.statSync ?? statSync)(p);
    }
    _utimes(p, atime, mtime) {
        return (this.fs.utimesSync ?? utimesSync)(p, atime, mtime);
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
        // The times first: every later write moves the mtime.
        const st = this._stat(this.configPath);
        this.mtimeMs = st.mtimeMs;
        this.atimeMs = st.atimeMs;
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
        this.restoreTimes();
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

    /**
     * utimesSync with the times read at apply(), in seconds with their
     * fraction, then one stat: within a millisecond is restored. Never
     * throws; the outcome is mtimeRestored and, when false, mtimeNote.
     */
    restoreTimes() {
        if (!Number.isFinite(this.mtimeMs)) return;
        const want = this.mtimeMs;
        try {
            this._utimes(
                this.configPath,
                (Number.isFinite(this.atimeMs) ? this.atimeMs : want) / 1000,
                want / 1000
            );
            const got = this._stat(this.configPath).mtimeMs;
            this.mtimeRestored = Math.abs(got - want) < 1;
            this.mtimeNote = this.mtimeRestored
                ? null
                : `mtime reads ${new Date(got).toISOString()} after the restore, not ${new Date(want).toISOString()}`;
        } catch (err) {
            this.mtimeRestored = false;
            this.mtimeNote = `mtime not restored: ${err.message}`;
        }
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
            mtimeBefore: Number.isFinite(this.mtimeMs)
                ? new Date(this.mtimeMs).toISOString()
                : null,
            mtimeRestored: this.mtimeRestored,
            mtimeNote: this.mtimeNote,
        };
    }
}

// ------------------------------------------- Explorer right-click entry

/**
 * The per-user "Send with Floe" Explorer verb, as
 * desktop/contextmenu_windows.go registerContextMenu writes it: the base
 * key's Default ("Send with Floe"), its Icon (the exe) and the command
 * subkey's Default ("<exe>" "%1"), all REG_SZ. At startup an unpackaged
 * build (desktop/app.go) rewrites all three to its own exe whenever the
 * command subkey exists and names another one, so a portable or head launch
 * points the user's entry at a scratch exe the run later deletes. The app
 * never creates the key, and neither does anything here.
 */
export const SHELL_MENU_KEY = 'Software\\Classes\\*\\shell\\Floe';

// The .NET Registry API, not reg.exe or the PowerShell registry provider:
// the `*` in the path is a wildcard to Get-Item and Set-ItemProperty, reg.exe
// prints a localized "(Default)" label, and OpenSubKey never creates a key,
// so a write to an absent key is refused instead of recreating it. The
// request goes in and the answer comes out as base64 of UTF-8 JSON, and the
// script travels as -EncodedCommand, because PowerShell 5.1 mangles embedded
// double quotes in arguments (the command value carries four) and its
// console output is not UTF-8.
const SHELL_MENU_PS = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Send-Answer($answer) {
    $json = ConvertTo-Json -InputObject $answer -Compress -Depth 5
    [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
}
function Read-Entry($key, $name) {
    if ($null -eq $key -or $key.GetValueNames() -notcontains $name) { return $null }
    $kind = $key.GetValueKind($name).ToString()
    if ($kind -ne 'String' -and $kind -ne 'ExpandString') { throw ('value [' + $name + '] is ' + $kind + ', not a string') }
    return @{ kind = $kind; value = [string]$key.GetValue($name, $null, 'DoNotExpandEnvironmentNames') }
}
function Write-Entry($key, $name, $entry) {
    if ($null -eq $entry) { $key.DeleteValue($name, $false) }
    else { $key.SetValue($name, [string]$entry.value, [Microsoft.Win32.RegistryValueKind]$entry.kind) }
}
$base = $null
$cmd = $null
try {
    $req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('@REQUEST@')) | ConvertFrom-Json
    $write = $req.op -eq 'write'
    $base = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($req.key, $write)
    if ($null -ne $base) { $cmd = $base.OpenSubKey('command', $write) }
    if ($write) {
        if ($null -eq $cmd) { throw 'the key or its command subkey is absent; never created' }
        Write-Entry $base '' $req.values.name
        Write-Entry $base 'Icon' $req.values.icon
        Write-Entry $cmd '' $req.values.command
        Send-Answer @{ ok = $true }
    } else {
        $command = Read-Entry $cmd ''
        Send-Answer @{ ok = $true; present = ($null -ne $command); values = @{ name = (Read-Entry $base ''); icon = (Read-Entry $base 'Icon'); command = $command } }
    }
} catch {
    Send-Answer @{ ok = $false; error = $_.Exception.Message }
} finally {
    if ($null -ne $cmd) { $cmd.Close() }
    if ($null -ne $base) { $base.Close() }
}
`;

function shellMenuCall(request, exec) {
    const script = SHELL_MENU_PS.replace('@REQUEST@', () =>
        Buffer.from(JSON.stringify(request), 'utf8').toString('base64')
    );
    const out = exec(
        'powershell.exe',
        [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { timeout: 30_000 }
    );
    let answer = null;
    try {
        answer = JSON.parse(
            Buffer.from(String(out).trim(), 'base64').toString('utf8')
        );
    } catch {
        // Reported below as an unreadable answer.
    }
    if (!answer || answer.ok !== true)
        throw new Error(
            `registry ${request.op} HKCU\\${request.key}: ${answer ? answer.error : 'unreadable answer'}`
        );
    return answer;
}

// PowerShell hashtables are unordered; this fixes the shape and key order so
// two readings compare as JSON.
const menuEntry = (e) =>
    e && typeof e.value === 'string'
        ? { kind: String(e.kind), value: e.value }
        : null;
const menuValues = (v = {}) => ({
    name: menuEntry(v.name),
    icon: menuEntry(v.icon),
    command: menuEntry(v.command),
});
const sameMenu = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * { present, values: { name, icon, command } }, each value { kind, value }
 * or null when unset. present is what the startup self-heal checks: a string
 * Default on the command subkey. Throws when the read fails.
 */
export function readShellMenu({
    key = SHELL_MENU_KEY,
    exec = defaultExec,
} = {}) {
    const answer = shellMenuCall({ op: 'read', key }, exec);
    return { present: answer.present === true, values: menuValues(answer.values) };
}

/** Write readShellMenu().values onto the EXISTING key (a null value is removed); throws on refusal. */
export function writeShellMenu(
    values,
    { key = SHELL_MENU_KEY, exec = defaultExec } = {}
) {
    shellMenuCall({ op: 'write', key, values: menuValues(values) }, exec);
}

/**
 * The Explorer verb across a run. take() snapshots it ONCE per process, at
 * the first unpackaged launch: a later snapshot would capture an earlier
 * leg's rewrite (P9 launches twice). restore() puts the snapshot back and
 * reads it again. Only an 'armed' guard ever writes; 'absent' (the app never
 * creates the key, so there is nothing to guard), 'unreadable' and 'off'
 * (not Windows) leave the registry alone for the rest of the process. A
 * failed read is a note, never a failed cell; a write the re-read
 * contradicts is a SafetyError (exit 4).
 */
export class ShellMenuGuard {
    constructor({
        key = SHELL_MENU_KEY,
        exec = defaultExec,
        platform = process.platform,
    } = {}) {
        this.key = key;
        this.exec = exec;
        this.platform = platform;
        this.state = 'unread';
        this.snapshot = null;
    }

    read() {
        return readShellMenu({ key: this.key, exec: this.exec });
    }

    take(note = () => {}) {
        if (this.state !== 'unread') return this.state;
        if (this.platform !== 'win32') {
            this.state = 'off';
            return this.state;
        }
        try {
            const now = this.read();
            if (now.present) {
                this.snapshot = now.values;
                this.state = 'armed';
                note(
                    `explorer verb: snapshot of HKCU\\${this.key} (command ${now.values.command.value})`
                );
            } else {
                this.state = 'absent';
                note(
                    `explorer verb: HKCU\\${this.key} absent; the app never creates it, left alone`
                );
            }
        } catch (err) {
            this.state = 'unreadable';
            note(
                `explorer verb: snapshot read failed, left alone this run: ${err.message}`
            );
        }
        return this.state;
    }

    /** Synchronous, so the process 'exit' hook can call it: { wrote, match }. */
    restore(note = () => {}) {
        if (this.state !== 'armed') return { wrote: false, match: null };
        let now;
        try {
            now = this.read();
        } catch (err) {
            note(`explorer verb: restore read failed, left as is: ${err.message}`);
            return { wrote: false, match: null };
        }
        if (!now.present) {
            note(`explorer verb: HKCU\\${this.key} is gone; not recreated`);
            return { wrote: false, match: null };
        }
        if (sameMenu(now.values, this.snapshot)) {
            note('explorer verb: unchanged');
            return { wrote: false, match: true };
        }
        try {
            writeShellMenu(this.snapshot, { key: this.key, exec: this.exec });
        } catch (err) {
            note(`explorer verb: write failed: ${err.message}`);
        }
        let after;
        try {
            after = this.read();
        } catch (err) {
            note(
                `explorer verb: re-read after the write failed: ${err.message}`
            );
            return { wrote: true, match: null };
        }
        const want = this.snapshot.command.value;
        if (after.present && sameMenu(after.values, this.snapshot)) {
            note(
                `explorer verb: put back command ${want} (the launch had rewritten it to ${now.values.command.value})`
            );
            return { wrote: true, match: true };
        }
        const got = after.values.command ? after.values.command.value : null;
        throw new SafetyError(
            `explorer verb restore mismatch at HKCU\\${this.key}: want command ${want}, got ${got}`,
            { key: this.key, want: this.snapshot, got: after.values }
        );
    }
}

/** The one guard every unpackaged DesktopLeg shares, unless a test hands in its own. */
export const shellMenuGuard = new ShellMenuGuard();

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
    try {
        shellMenuGuard.restore();
    } catch {
        // Best effort; SKILL.md section 6 covers what is left behind.
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

/** A UIA tree read costs 100 to 300 ms, so the request verbs poll slower than the DOM lane. */
export const UIA_REQUEST_POLL_MS = 250;
/** The request view reads the whole window in one snapshot; raw view trees run to a few hundred nodes. */
export const UIA_SNAPSHOT_MAX = 3000;
/** How long an answer's Invoke has to take the prompt away before it counts as swallowed. */
export const ANSWER_SETTLE_MS = 1_500;
export const ANSWER_ATTEMPTS = 3;
const COPIED = 'Copied'; // W3, the Copy link button's name for 1.5 s after a click

const hasButton = (items, name) =>
    (items || []).some((x) => x && x.type === 'Button' && sameText(x.name, name));

/**
 * shortPath (desktop/frontend/src/paths.ts) of a bare folder name: the Done
 * view shows the drop folder's own name cut in the middle to 34 characters.
 */
export function shortFolderName(name, max = 34) {
    const n = String(name ?? '');
    if (n.length <= max) return n;
    const room = Math.max(2, max - 3);
    const head = Math.floor(room / 2);
    return `${n.slice(0, head)}...${n.slice(n.length - (room - head))}`;
}

/**
 * UIA driver: one helper client plus the window handle. Every method maps
 * to one helper command; see desktop-uia.ps1.
 *
 * The request link verbs (S1-REL-03a step 5; built in FU-26 for the Store,
 * portable and head exe hosts of the shipped-profile cells) mirror the
 * PlaywrightDriver ones name for name and read the host's lane from one UIA
 * snapshot of the window (requestStateFromItems), since an exe has no bound
 * GetRequestLink. Two facts shape them. G2-F1 (session 166e0836): a UIA
 * pattern call (Invoke, Toggle, SetValue) activates the exe's window, so a
 * request host is away-only: with `awayOnly` set, every pattern call first
 * re-reads GetLastInputInfo and stops as SKIP present below 120 s of idle
 * input; reads never activate. And the prompt re-arms its 1 s guard when the
 * window gains focus, so the Invoke that activates it can be swallowed: an
 * answer is retried, never sooner than ACCEPT_WAIT_MS after the prompt was
 * first seen or after the last Invoke.
 */
export class UiaDriver {
    constructor(client, hwnd, { log = null } = {}) {
        this.client = client;
        this.hwnd = hwnd;
        this.log = log;
        // Set by lib/request.mjs on an exe request host, and by DesktopLeg
        // on every exe leg of a --user-away run (G2-F1).
        this.awayOnly = false;
        this.pollMs = UIA_REQUEST_POLL_MS;
        // The links this driver made: the view shows neither a generation
        // nor the save folder.
        this._gen = 0;
        this._saveDir = '';
        this._promptFolder = null;
    }
    /** GetLastInputInfo before a pattern call on an away-only host. */
    async _away() {
        if (!this.awayOnly) return;
        let idle = NaN;
        try {
            const fg = await this.client.foregroundCheck(this.hwnd);
            idle = Number(fg && fg.idleSeconds);
        } catch {
            // Unreadable counts as present.
        }
        if (!(idle >= USER_AWAY_IDLE_S))
            throw new PhaseError(
                'request',
                `desktop uia: input idle ${Number.isFinite(idle) ? idle : 'unknown'} s (< ${USER_AWAY_IDLE_S}); the owner may be at the PC, and a UIA pattern call activates the Floe window (G2-F1)`,
                { verdict: 'SKIP', reason: 'present' }
            );
    }
    async click(name, opts = {}) {
        await this._away();
        return this.client.retry(
            'click',
            { hwnd: this.hwnd, name, ...opts },
            { attempts: 2 }
        );
    }
    async setValue(placeholder, value, opts = {}) {
        await this._away();
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
    /**
     * An exe leg is launched fresh for its cell, so its receive view opens
     * on CODE; PlaywrightDriver.toCodeView says why the dev page needs one.
     */
    async toCodeView() {
        return false;
    }
    /** No bound GetSettings on an exe: the leg's desktop.json is the record. */
    async settings() {
        return null;
    }
    /** No bound SetSettings on an exe: a request host's addresses ride its desktop.json at launch. */
    async setAddresses() {
        return null;
    }

    // ------------------------------------------- request link verbs (UIA)

    async _items() {
        const r = await this.client.request('snapshot', {
            hwnd: this.hwnd,
            max: UIA_SNAPSHOT_MAX,
            values: true,
        });
        return Array.isArray(r && r.items) ? r.items : [];
    }
    async _visible(name) {
        return hasButton(await this._items(), name);
    }
    async _waitShown(name, timeoutMs, { now = Date.now, nap = sleep } = {}) {
        const start = now();
        for (;;) {
            if (await this._visible(name)) return now();
            if (now() - start >= timeoutMs)
                throw new PhaseError(
                    'request',
                    `desktop uia: "${name}" did not appear within ${timeoutMs} ms`
                );
            await nap(this.pollMs);
        }
    }
    async _waitGoneOrNull(name, timeoutMs, { now = Date.now, nap = sleep } = {}) {
        const start = now();
        for (;;) {
            if (!(await this._visible(name))) return now();
            if (now() - start >= timeoutMs) return null;
            await nap(this.pollMs);
        }
    }
    async _waitGone(name, timeoutMs, clock = {}) {
        const at = await this._waitGoneOrNull(name, timeoutMs, clock);
        if (at === null)
            throw new PhaseError(
                'request',
                `desktop uia: "${name}" was still showing ${timeoutMs} ms after the click; the view did not leave that state`
            );
        return at;
    }
    /**
     * Since H7 (D-160) the REQUEST LINK choice is always on Receive; there is
     * no Settings switch to turn on first. Waits for it, clicking RECEIVE once
     * when the window is not on that tab, and reports whether it showed
     * instead of throwing, so the runner words its own finding.
     */
    async awaitRequestTab({ timeoutMs = 10_000, now = Date.now, nap = sleep } = {}) {
        const start = now();
        if (!(await this._visible(REQUEST_STRINGS.choice)))
            await this.click(STRINGS.tabReceive, { index: 0, controlType: 'Button' });
        for (;;) {
            if (await this._visible(REQUEST_STRINGS.choice))
                return { shown: true, via: 'uia', waitedMs: now() - start };
            if (now() - start >= timeoutMs)
                return { shown: false, via: 'uia', waitedMs: now() - start };
            await nap(this.pollMs);
        }
    }
    /** Back to Receive > REQUEST LINK unless one of its state buttons shows. */
    async _toRequestView() {
        const items = await this._items();
        if (REQUEST_VIEW_MARKS.some((m) => hasButton(items, m))) return false;
        await this.click(STRINGS.tabReceive, { index: 0, controlType: 'Button' });
        if (await this._visible(REQUEST_STRINGS.choice))
            await this.click(REQUEST_STRINGS.choice, { controlType: 'Button' });
        return true;
    }
    /**
     * The drop folder of a result: the subfolder of the save folder this
     * driver made the link with whose name the Done view shows (DN6 shows the
     * name cut to 34 characters; the full path is only its title), else a
     * Text whose HelpText is a path there (INFERRED: Chromium's title), else
     * the prompt's host-computed folder (P3).
     */
    _dropFolder(items) {
        if (!this._saveDir) return this._promptFolder;
        const shown = (items || [])
            .filter((x) => x && x.type === 'Text' && x.name)
            .map((x) => String(x.name).trim());
        let names = [];
        try {
            names = readdirSync(this._saveDir, { withFileTypes: true })
                .filter((d) => d.isDirectory())
                .map((d) => d.name);
        } catch {
            // The save folder is gone; fall through to the other readings.
        }
        const hit = names.find((n) =>
            shown.some((t) => t === n || t === shortFolderName(n))
        );
        if (hit) return path.join(this._saveDir, hit);
        const help = (items || []).find(
            (x) =>
                x &&
                typeof x.help === 'string' &&
                isAbsWin(x.help) &&
                samePath(path.dirname(x.help), this._saveDir)
        );
        return help ? help.help : this._promptFolder;
    }
    /** The lane as the view shows it (requestStateFromItems), with the drop folder resolved. */
    async requestSnapshot() {
        const items = await this._items();
        const s = requestStateFromItems(items, {
            gen: this._gen,
            saveDir: this._saveDir,
        });
        if (s.prompt && s.prompt.folder) this._promptFolder = s.prompt.folder;
        if (s.result) s.result.folder = this._dropFolder(items);
        return s;
    }
    /**
     * A Settings switch (Hide my IP, the relay forcer): the one named by
     * `name` (a RegExp over its whole label) set through TogglePattern, only
     * when the snapshot shows it differs, and read back. A disabled switch is
     * left alone and reads unchanged, as a click on it does on the dev page.
     */
    async setToggle(name, value) {
        const want = Boolean(value);
        const rx = name instanceof RegExp ? name : new RegExp(String(name), 'i');
        const box = (await this._items()).find(
            (x) => x && x.type === 'CheckBox' && rx.test(String(x.name ?? ''))
        );
        const before = box ? box.toggle === 'On' : false;
        if (box && before === want) return { before, after: before, changed: false };
        if (box && box.enabled === false)
            return { before, after: before, changed: false };
        await this._away();
        try {
            const r = await this.client.request('toggle', {
                hwnd: this.hwnd,
                regex: rx.source,
                value: want,
            });
            return { before: r.before, after: r.after, changed: r.changed };
        } catch (err) {
            if (err && err.reason === 'disabled')
                return { before, after: before, changed: false };
            throw err;
        }
    }
    /**
     * MakeLink: Receive, the REQUEST LINK choice, Make another link after an
     * ended link, the Save to field set to the run's own folder and read back
     * (a field that is not there or will not take is SKIP desktop-savedir,
     * never the owner's Downloads\Floe), the lifetime (any key of
     * REQUEST_STRINGS.lifetimes other than the default is its option of the
     * select, clicked by name: SelectionItem, INFERRED; the H10 look fixture
     * measured all six options in Chromium's accessibility tree while the
     * select is closed; every cell makes 24 hours, the default), Make link,
     * then the waiting view.
     *
     * autoAccept true is TA-10a's, whose oracles read the host's own record
     * of the switch and the drop's mark (GetRequestLink), which this lane
     * does not have: SKIP request-auto-wailsdev-only before anything is
     * clicked (the matrix gate SKIPs the cell first; this is the second lock).
     */
    async makeRequestLink({
        lifetime = '24h',
        autoAccept = false,
        saveDir = null,
        timeoutMs = 30_000,
        now = Date.now,
        nap = sleep,
    } = {}) {
        const lifetimeText = lifetimeLabel(lifetime);
        if (!lifetimeText)
            throw new PhaseError(
                'request',
                `desktop uia: MakeLink takes ${LIFETIME_KEYS_TEXT}, not ${lifetime}`
            );
        if (autoAccept !== false)
            throw new PhaseError(
                'request',
                'desktop uia: MakeLink with Auto-accept on is a wailsdev verb (TA-10a reads GetRequestLink); no link is made',
                { verdict: 'SKIP', reason: 'request-auto-wailsdev-only' }
            );
        if (typeof saveDir !== 'string' || !path.isAbsolute(saveDir))
            throw new PhaseError(
                'request',
                'desktop uia: MakeLink needs the run\'s own save folder (an absolute path); an empty Save to field means the owner\'s Downloads\\Floe',
                { harness: true, reason: 'request-savedir' }
            );
        await this.click(STRINGS.tabReceive, { index: 0, controlType: 'Button' });
        await this.click(REQUEST_STRINGS.choice, { controlType: 'Button' });
        if (await this._visible(REQUEST_STRINGS.makeAnother))
            await this.click(REQUEST_STRINGS.makeAnother, { controlType: 'Button' });
        let set;
        try {
            set = await this.setValue(REQUEST_STRINGS.saveToPlaceholder, saveDir);
        } catch (err) {
            if (err && (err.reason === 'not-found' || err.reason === 'read-only' || err.reason === 'disabled'))
                throw new PhaseError(
                    'request',
                    `desktop uia: the Save to field could not be set (${err.reason}); no link is made`,
                    { verdict: 'SKIP', reason: 'desktop-savedir' }
                );
            throw err;
        }
        if (!set || set.after !== saveDir)
            throw new PhaseError(
                'request',
                `desktop uia: the Save to field reads "${set ? set.after : ''}", not the run's folder; no link is made`,
                { verdict: 'SKIP', reason: 'desktop-savedir' }
            );
        if (lifetime !== '24h')
            await this.click(lifetimeText, { controlType: 'any' });
        await this.click(REQUEST_STRINGS.makeLink, { controlType: 'Button' });
        const start = now();
        let waitingAt = null;
        for (;;) {
            const items = await this._items();
            if (hasButton(items, REQUEST_STRINGS.copyLink) || hasButton(items, COPIED)) {
                waitingAt = now();
                break;
            }
            const s = requestStateFromItems(items);
            if (s.state === 'error')
                throw new PhaseError(
                    'request',
                    `request-flow: Make link ended in error (${safeCode(s.code)})`,
                    { signatureKey: 'request-flow', code: safeCode(s.code) }
                );
            if (now() - start >= timeoutMs)
                throw new PhaseError(
                    'request',
                    `desktop uia: "${REQUEST_STRINGS.copyLink}" did not appear within ${timeoutMs} ms`
                );
            await nap(this.pollMs);
        }
        this._gen += 1;
        this._saveDir = saveDir;
        this._promptFolder = null;
        return { made: true, lifetime, autoAccept, saveDir, waitingAt };
    }
    /** ReadLink: the full link is the read-only link field's value (LinkBlock). */
    async readRequestLink() {
        const s = requestStateFromItems(await this._items(), {
            gen: this._gen,
            saveDir: this._saveDir,
        });
        if (!REQUEST_LINK_RE.test(s.link))
            throw new PhaseError(
                'request',
                `desktop uia: no request link to read (state ${s.state})`
            );
        return {
            link: s.link,
            via: 'uia-value',
            onScreen: true,
            shown: redactRequestLink(s.link),
        };
    }
    /**
     * Accept or Decline: never sooner than ACCEPT_WAIT_MS after the prompt
     * was first seen, nor after the previous Invoke (the guard re-arms on the
     * focus an Invoke brings, G2-F1); then the prompt must leave within
     * ANSWER_SETTLE_MS, or the Invoke counts as swallowed and is repeated,
     * ANSWER_ATTEMPTS at most. A refusal of a disabled button (the guard's
     * aria-disabled) is a swallowed Invoke too.
     */
    async _answer(
        name,
        { timeoutMs = 60_000, now = Date.now, nap = sleep, attempts = ANSWER_ATTEMPTS } = {}
    ) {
        await this._toRequestView();
        const seenAt = await this._waitShown(name, timeoutMs, { now, nap });
        const invokes = [];
        for (let k = 0; k < attempts; k++) {
            const from = invokes.length ? invokes[invokes.length - 1] : seenAt;
            for (;;) {
                const left = ACCEPT_WAIT_MS - (now() - from);
                if (left <= 0) break;
                await nap(left);
            }
            invokes.push(now());
            try {
                await this.click(name, { controlType: 'Button' });
            } catch (err) {
                if (err && err.verdict === 'SKIP') throw err;
                if (!(err && (err.reason === 'disabled' || err.reason === 'not-found')))
                    throw err;
            }
            const leftAt = await this._waitGoneOrNull(name, ANSWER_SETTLE_MS, { now, nap });
            if (leftAt !== null)
                return {
                    answered: name,
                    seenAt,
                    clickedAt: invokes[0],
                    waitedMs: invokes[0] - seenAt,
                    invokes: invokes.length,
                    leftAt,
                };
        }
        throw new PhaseError(
            'request',
            `desktop uia: "${name}" still showing after ${invokes.length} Invoke(s), each at least ${ACCEPT_WAIT_MS} ms after the last`
        );
    }
    async acceptRequest(o = {}) {
        return this._answer(REQUEST_STRINGS.accept, o);
    }
    /** Decline, then the declined view's Keep waiting must show (D3). */
    async declineRequest(o = {}) {
        const r = await this._answer(REQUEST_STRINGS.decline, o);
        await this._waitShown(REQUEST_STRINGS.keepWaiting, 10_000, o);
        return r;
    }
    /** Keep waiting (request-reopen, E-03): only from the declined view; the waiting view must come back. */
    async keepWaiting({ now = Date.now, nap = sleep } = {}) {
        await this._toRequestView();
        if (!(await this._visible(REQUEST_STRINGS.keepWaiting)))
            throw new PhaseError(
                'request',
                'desktop uia: Keep waiting is not showing; decline first'
            );
        await this.click(REQUEST_STRINGS.keepWaiting, { controlType: 'Button' });
        await this._waitGone(REQUEST_STRINGS.keepWaiting, 10_000, { now, nap });
        const waitingAt = await this._waitShown(REQUEST_STRINGS.copyLink, 10_000, { now, nap });
        return { reopened: true, waitingAt };
    }
    /** Close link, then the ended view's Make another link must show (X3). */
    async closeRequestLink({ now = Date.now, nap = sleep } = {}) {
        await this._toRequestView();
        await this.click(REQUEST_STRINGS.closeLink, { controlType: 'Button' });
        const endedAt = await this._waitShown(REQUEST_STRINGS.makeAnother, 10_000, { now, nap });
        return { closed: true, endedAt };
    }
    /** Put a done or stopped result away (Make another link; DN2 Dismiss is cut, D-169). */
    async dismissRequestResult({ now = Date.now, nap = sleep } = {}) {
        await this._toRequestView();
        await this.click(REQUEST_STRINGS.makeAnother, { controlType: 'Button' });
        const at = await this._waitGone(REQUEST_STRINGS.makeAnother, 10_000, { now, nap });
        return { dismissed: true, at };
    }
    /** Stop a drop that is still receiving (V4 Cancel drop). */
    async cancelRequestDrop({ now = Date.now, nap = sleep } = {}) {
        await this._toRequestView();
        await this.click(REQUEST_STRINGS.cancelDrop, { controlType: 'Button' });
        const at = await this._waitGone(REQUEST_STRINGS.cancelDrop, 10_000, { now, nap });
        return { canceled: true, at };
    }
    /** The done view as the owner reads it: DN1's count and whether DN3 shows. */
    async readRequestResult() {
        await this._toRequestView();
        const items = await this._items();
        const texts = items
            .filter((x) => x && x.type === 'Text' && x.name)
            .map((x) => String(x.name).trim());
        const heading = texts.find((t) => RE.requestDone.test(t)) ?? null;
        const m = heading ? RE.requestDone.exec(heading) : null;
        return {
            heading,
            files: m ? Number(m[1]) : null,
            verifiedLine: texts.some((t) => sameText(t, REQUEST_STRINGS.verifiedLine)),
        };
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
        if (after === STRINGS.codePlaceholder) {
            // The receive view's primary button, told apart from the
            // RECEIVE tab, which carries the same accessible name.
            //
            // The sibling shape this replaced could not reach it and cost
            // the first live wailsdev run every *2D cell (2026-09-22,
            // `locator.click: Timeout 30000ms exceeded`). App.tsx renders
            // the view as <div.space-y-4> holding one field group per
            // <div.space-y-2> and then the button, so the button is a
            // sibling of the GROUP that holds the code input, not of the
            // input, and not a descendant of any of those siblings:
            // `... ~ *` matched it and `.getByRole()` then searched
            // INSIDE it, where there is no button.
            //
            // Document order is the relationship that actually holds and
            // survives a layout change: the tab row lives in the card
            // header above the body, so the first button after the code
            // input carrying this exact label is the primary one.
            await this.page
                .locator(`input[placeholder="${STRINGS.codePlaceholder}"]`)
                .locator(
                    `xpath=following::button[normalize-space(.)=${xpathLiteral(name)}]`
                )
                .nth(0)
                .click();
            return { via: 'playwright', index: 0 };
        }
        await this.page
            .getByRole('button', { name, exact: true })
            .nth(index)
            .click();
        return { via: 'playwright', index };
    }
    /**
     * Hand the app files the way Explorer and a second instance do: the
     * `files:open` event App.tsx listens on (its mount effect,
     * `EventsOn('files:open', (paths) => addFiles(paths))`), which is the
     * one entry point that does not need a native window.
     *
     * The picker the Files button opens is Go's SelectFiles(), a native
     * dialog no browser page can drive, and StartSend() would skip the
     * very button the cell exists to exercise, so neither is usable here.
     *
     * The event is delivered with window.wails.EventsNotify, which runs
     * this page's own listeners and nothing else (Wails v2.12.0
     * runtime/desktop/events.js; the dev IPC calls it for every event it
     * receives, runtime/dev/main.js). Never runtime.EventsEmit: after its
     * local listeners it sends 'EE' to the dev server, whose
     * notifyExcludingSender rebroadcasts it to every other page
     * (devserver.go handleIPCWebSocket). Every leg has its own page on the
     * one dev server, so a sender's staging ran addFiles on the request
     * host's page too, moved it to Send, and stranded its Close link (the
     * first live TA-17 run, 2026-09-24). A page without EventsNotify is
     * refused rather than broadcast to.
     */
    async stage(files) {
        const paths = (files || []).map(String);
        const how = await this.page.evaluate((p) => {
            const w = window.wails;
            if (w && typeof w.EventsNotify === 'function') {
                w.EventsNotify(JSON.stringify({ name: 'files:open', data: [p] }));
                return 'notified';
            }
            const rt = window.runtime;
            return rt && typeof rt.EventsEmit === 'function' ? 'emit-only' : 'none';
        }, paths);
        if (how === 'emit-only')
            throw new PhaseError(
                'start',
                'desktop wailsdev: window.wails.EventsNotify is missing on the dev server page, and EventsEmit would hand the files to every other page on the dev server'
            );
        if (how !== 'notified')
            throw new PhaseError(
                'start',
                'desktop wailsdev: the Wails runtime is missing on the dev server page'
            );
        return { staged: paths.length, via: 'files:open' };
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
    /**
     * join is accepted and moot here: textContent already joins the leaves.
     *
     * The match runs in the page so containment can be used. An element's
     * textContent includes every descendant's, so a loose pattern matches
     * each ancestor of a hit as well, and querySelectorAll returns document
     * order, which put the page root first: `RE.link` used to answer with
     * the whole page text, and the web receiver was handed that as a URL
     * (H-DIR-D2W, 2026-09-22). UIA names one control at a time, which is
     * what the RE table was written against, so keep the innermost hits
     * only and this reads the same way on both drivers.
     */
    async readText(re, { controlType = 'Text', join = false } = {}) {
        void join;
        const rx = re instanceof RegExp ? re : new RegExp(String(re), 'i');
        return this.page.evaluate(
            ({ selector, source, flags }) => {
                const test = new RegExp(source, flags);
                const hit = [...document.querySelectorAll(selector)].filter(
                    (e) => test.test((e.textContent || '').trim())
                );
                return hit
                    .filter((e) => !hit.some((o) => o !== e && e.contains(o)))
                    .map((e) => (e.textContent || '').trim())
                    .filter(Boolean);
            },
            {
                selector:
                    controlType === 'Button'
                        ? 'button'
                        : 'p, span, code, h2, div',
                source: rx.source,
                // A sticky or global flag would carry lastIndex across the
                // filter above and drop every other match.
                flags: rx.flags.replace(/[gy]/g, ''),
            }
        );
    }
    /**
     * Set one Settings switch (SettingsPrimitives.tsx Switch: a real
     * checkbox, visually hidden, inside the label that names it). The label
     * is clicked rather than the input, because the input is `sr-only` and
     * a click at its own box is not what a person does. Returns what the
     * control read before and after, never a claim that it changed.
     */
    async setToggle(name, value) {
        const box = this.page.getByRole('checkbox', { name });
        const before = await box.isChecked();
        if (before !== value)
            await box.locator('xpath=ancestor::label[1]').click();
        const after = await box.isChecked();
        return { before, after, changed: after !== before };
    }

    // ------------------------------------------- request link verbs
    //
    // The wailsdev DOM mirror of the UIA verbs (S1-REL-03a step 5). Every
    // verb clicks a button by its frozen accessible name and then reads back
    // that the view moved, so a click that did not take is an error and
    // never a silent pass. The clock and the nap are injectable so the 1 s
    // guard wait is provable on a fake clock (desktop.test.mjs).

    _button(name) {
        return this.page.getByRole('button', { name, exact: true });
    }
    async _visible(name) {
        try {
            return await this._button(name).first().isVisible();
        } catch {
            return false;
        }
    }
    /** Poll until the named button shows; resolves the time it was seen. */
    async _waitShown(name, timeoutMs, { now = Date.now, nap = sleep } = {}) {
        const start = now();
        for (;;) {
            if (await this._visible(name)) return now();
            if (now() - start >= timeoutMs)
                throw new PhaseError(
                    'request',
                    `desktop wailsdev: "${name}" did not appear within ${timeoutMs} ms`
                );
            await nap(REQUEST_POLL_MS);
        }
    }
    async _waitGone(name, timeoutMs, { now = Date.now, nap = sleep } = {}) {
        const start = now();
        for (;;) {
            if (!(await this._visible(name))) return now();
            if (now() - start >= timeoutMs)
                throw new PhaseError(
                    'request',
                    `desktop wailsdev: "${name}" was still showing ${timeoutMs} ms after the click; the view did not leave that state`
                );
            await nap(REQUEST_POLL_MS);
        }
    }
    /**
     * Back to Receive > REQUEST LINK when the page is not showing it, before
     * a request verb clicks; returns whether it had to move. The page can
     * leave on its own terms (another leg's files:open rebroadcast moved it
     * to Send in the first live TA-17 run, 2026-09-24, and the release then
     * timed out on Close link), so no verb assumes it. The view is showing
     * when one of its state buttons is (REQUEST_VIEW_MARKS); otherwise the
     * RECEIVE tab (the first button of that name, in the card header) and
     * the REQUEST LINK choice, the same two clicks Make link starts with.
     */
    /**
     * The receive view is two sub-views behind a Code | Request link choice
     * (always, since H7), and it keeps the last one: after a request cell it
     * reopens on Request link, where neither the code field nor the receive
     * Save to field exists (the head default run of 2026-09-25 lost every
     * *2D cell to `locator.inputValue: Timeout 30000ms` that way). Presses
     * Code when it shows and is not already pressed; off the Receive tab
     * there is no choice row and nothing is pressed. Resolves whether it
     * pressed.
     */
    async toCodeView() {
        if (!(await this._visible(STRINGS.codeChoice))) return false;
        const code = this._button(STRINGS.codeChoice).first();
        if ((await code.getAttribute('aria-pressed')) === 'true') return false;
        await code.click();
        return true;
    }
    /**
     * Since H7 (D-160) the REQUEST LINK choice is always on Receive; there is
     * no Settings switch to turn on first. Waits for it, clicking RECEIVE once
     * when the page is not on that tab, and reports whether it showed instead
     * of throwing, so the runner words its own finding.
     */
    async awaitRequestTab({ timeoutMs = 10_000, now = Date.now, nap = sleep } = {}) {
        const start = now();
        if (!(await this._visible(REQUEST_STRINGS.choice)))
            await this._button(STRINGS.tabReceive).first().click();
        for (;;) {
            if (await this._visible(REQUEST_STRINGS.choice))
                return { shown: true, via: 'playwright', waitedMs: now() - start };
            if (now() - start >= timeoutMs)
                return { shown: false, via: 'playwright', waitedMs: now() - start };
            await nap(REQUEST_POLL_MS);
        }
    }
    async _toRequestView() {
        for (const name of REQUEST_VIEW_MARKS)
            if (await this._visible(name)) return false;
        await this._button(STRINGS.tabReceive).first().click();
        if (await this._visible(REQUEST_STRINGS.choice))
            await this._button(REQUEST_STRINGS.choice).first().click();
        return true;
    }
    /** The host-authoritative snapshot (GetRequestLink), or null. */
    async requestSnapshot() {
        return this.page.evaluate(async () => {
            const app = window.go && window.go.main && window.go.main.App;
            if (!app || typeof app.GetRequestLink !== 'function') return null;
            return app.GetRequestLink();
        });
    }

    /**
     * Make link: the Receive view, the CODE / REQUEST LINK row's request
     * choice, the Save to folder, the lifetime (24h is the default; any
     * other key of REQUEST_STRINGS.lifetimes is picked by its label on the
     * Link ends select), Make link, then wait for the waiting view (Copy
     * link). Never types a label: the owner's label is optional (R7) and a
     * cell has no reason to put text on screen.
     *
     * saveDir is required and must read back: an empty Save to field means
     * the owner's own Downloads\Floe (R9), and an audit drop never
     * lands there, the same rule as the Receive view's desktop-savedir SKIP.
     * The folder the host reports for the link is checked too, since Go
     * trims and owns the value.
     *
     * autoAccept is the form's Auto-accept switch (D-173): false, the form's
     * own default on every mount, which every cell but TA-10a keeps and
     * which is never clicked; or true, which turns the switch on through
     * its label, found by its accessible name. A build without the switch
     * (made before H10) cannot run true: SKIP request-no-auto-switch, no
     * link made. Either way the host must hold the link with the choice
     * asked for (the snapshot's autoAccept; absent reads off).
     */
    async makeRequestLink({
        lifetime = '24h',
        autoAccept = false,
        saveDir = null,
        timeoutMs = 30_000,
        now = Date.now,
        nap = sleep,
    } = {}) {
        const lifetimeText = lifetimeLabel(lifetime);
        if (!lifetimeText)
            throw new PhaseError(
                'request',
                `desktop wailsdev: MakeLink takes ${LIFETIME_KEYS_TEXT}, not ${lifetime}`
            );
        if (autoAccept !== true && autoAccept !== false)
            throw new PhaseError(
                'request',
                `desktop wailsdev: MakeLink takes autoAccept true or false, not ${autoAccept}`
            );
        if (typeof saveDir !== 'string' || !path.isAbsolute(saveDir))
            throw new PhaseError(
                'request',
                'desktop wailsdev: MakeLink needs the run\'s own save folder (an absolute path); an empty Save to field means the owner\'s Downloads\\Floe',
                { harness: true, reason: 'request-savedir' }
            );
        await this._button(STRINGS.tabReceive).first().click();
        await this._button(REQUEST_STRINGS.choice).first().click();
        // A link the last cell closed leaves the ended view (X2 and X3),
        // which offers Make another link instead of the form.
        if (await this._visible(REQUEST_STRINGS.makeAnother))
            await this._button(REQUEST_STRINGS.makeAnother).first().click();
        const field = this.page.getByPlaceholder(
            REQUEST_STRINGS.saveToPlaceholder,
            { exact: true }
        );
        await field.fill(saveDir);
        const typed = await field.inputValue();
        if (typed !== saveDir)
            throw new PhaseError(
                'request',
                `desktop wailsdev: the Save to field reads "${typed}", not the run's folder; no link is made`,
                { verdict: 'SKIP', reason: 'desktop-savedir' }
            );
        if (lifetime !== '24h') {
            const select = this.page
                .locator('select')
                .filter({ has: this.page.locator('option', { hasText: lifetimeText }) });
            if ((await select.count()) > 0)
                await select.first().selectOption({ label: lifetimeText });
            else await this.page.getByText(lifetimeText, { exact: true }).click();
        }
        if (autoAccept) {
            const box = this.page.getByRole('checkbox', {
                name: REQUEST_STRINGS.autoAcceptSwitch,
                exact: true,
            });
            if ((await box.count()) === 0)
                throw new PhaseError(
                    'request',
                    `desktop wailsdev: this build has no "${REQUEST_STRINGS.autoAcceptSwitch}" switch (made before Auto-accept); no link is made`,
                    { verdict: 'SKIP', reason: 'request-no-auto-switch' }
                );
            // The switch is an sr-only checkbox inside its box's label, as
            // Settings' are (setToggle): the label is what takes the click.
            const sw = box.first();
            if (!(await sw.isChecked()))
                await sw.locator('xpath=ancestor::label[1]').click();
            if (!(await sw.isChecked()))
                throw new PhaseError(
                    'request',
                    'desktop wailsdev: the Auto-accept switch did not turn on; no link is made'
                );
        }
        await this._button(REQUEST_STRINGS.makeLink).first().click();
        // The waiting view, or the error the lane answered with (E1 to E8:
        // request-1 gone, the network limit, no relay for Hide my IP...),
        // which would otherwise cost the whole timeout.
        const start = now();
        let waitingAt = null;
        for (;;) {
            if (await this._visible(REQUEST_STRINGS.copyLink)) {
                waitingAt = now();
                break;
            }
            const s = await this.requestSnapshot();
            if (s && s.state === 'error')
                throw new PhaseError(
                    'request',
                    `request-flow: Make link ended in error (${safeCode(s.code)})`,
                    { signatureKey: 'request-flow', code: safeCode(s.code) }
                );
            if (now() - start >= timeoutMs)
                throw new PhaseError(
                    'request',
                    `desktop wailsdev: "${REQUEST_STRINGS.copyLink}" did not appear within ${timeoutMs} ms`
                );
            await nap(REQUEST_POLL_MS);
        }
        const snap = await this.requestSnapshot();
        if (snap && !samePath(snap.saveDir, saveDir))
            throw new PhaseError(
                'request',
                'desktop wailsdev: the host holds the link with a save folder that is not the run\'s',
                { verdict: 'SKIP', reason: 'desktop-savedir' }
            );
        // A cell that asks would never see its prompt on an automatic link,
        // and TA-10a on a link that asks would prove nothing: the host's own
        // record of the choice decides, never the click.
        if (snap && (snap.autoAccept === true) !== autoAccept)
            throw new PhaseError(
                'request',
                `request-flow: the host made the link with autoAccept ${snap.autoAccept === true}, not the ${autoAccept} this cell chose`,
                { signatureKey: 'request-flow' }
            );
        return { made: true, lifetime, autoAccept, saveDir, waitingAt };
    }

    /**
     * Read link: the full link from GetRequestLink, checked against what
     * the waiting view shows when the view shows it (a read-only input in
     * RequestLinkView.tsx LinkBlock, so its value, plus any text node). The
     * value is returned to the caller for the visitor leg only; `shown` is
     * the redacted form.
     */
    async readRequestLink() {
        const snap = await this.requestSnapshot();
        const link = snap && typeof snap.link === 'string' ? snap.link : '';
        if (!REQUEST_LINK_RE.test(link))
            throw new PhaseError(
                'request',
                `desktop wailsdev: no request link to read (state ${snap ? snap.state : 'unknown'})`
            );
        // The view may drop the scheme (the mock shows floe.one/r/...), so
        // the check is that the host's link ends with what is on screen.
        const bare = link.replace(/^https?:\/\//i, '');
        const values = await this.page.evaluate(() =>
            [...document.querySelectorAll('input')]
                .map((e) => String(e.value || '').trim())
                .filter(Boolean)
        );
        const onScreen = [
            ...values,
            ...(await this.readText(/\/r\/[A-Za-z0-9_-]+#[0-9a-f-]{36}$/i)),
        ].filter(
            (t) =>
                /\/r\/[A-Za-z0-9_-]+#[0-9a-f-]{36}$/i.test(t) &&
                /^(https?:\/\/)?[^\s/#]+\/r\//i.test(t)
        );
        if (onScreen.length && !onScreen.some((t) => link.endsWith(t) || t === bare))
            throw new PhaseError(
                'request',
                'desktop wailsdev: the link on screen is not the link the host holds'
            );
        return {
            link,
            via: 'GetRequestLink',
            onScreen: onScreen.length > 0,
            shown: redactRequestLink(link),
        };
    }

    /**
     * Answer the prompt with Accept or Decline, never earlier than
     * ACCEPT_WAIT_MS after the prompt was first seen (the 1 s guard), then
     * read back that the prompt left.
     */
    async _answer(name, { timeoutMs = 60_000, now = Date.now, nap = sleep } = {}) {
        await this._toRequestView();
        const seenAt = await this._waitShown(name, timeoutMs, { now, nap });
        for (;;) {
            const left = ACCEPT_WAIT_MS - (now() - seenAt);
            if (left <= 0) break;
            await nap(left);
        }
        const clickedAt = now();
        await this._button(name).first().click();
        const leftAt = await this._waitGone(name, 10_000, { now, nap });
        return { answered: name, seenAt, clickedAt, waitedMs: clickedAt - seenAt, leftAt };
    }
    async acceptRequest(o = {}) {
        return this._answer(REQUEST_STRINGS.accept, o);
    }
    /** Decline, then the declined view's Keep waiting must show (D3). */
    async declineRequest(o = {}) {
        const r = await this._answer(REQUEST_STRINGS.decline, o);
        await this._waitShown(REQUEST_STRINGS.keepWaiting, 10_000, o);
        return r;
    }
    /**
     * Keep waiting (sends request-reopen, E-03): only from the declined
     * view, and the waiting view (Copy link) must come back.
     */
    async keepWaiting({ now = Date.now, nap = sleep } = {}) {
        await this._toRequestView();
        if (!(await this._visible(REQUEST_STRINGS.keepWaiting)))
            throw new PhaseError(
                'request',
                'desktop wailsdev: Keep waiting is not showing; decline first'
            );
        await this._button(REQUEST_STRINGS.keepWaiting).first().click();
        await this._waitGone(REQUEST_STRINGS.keepWaiting, 10_000, { now, nap });
        const waitingAt = await this._waitShown(
            REQUEST_STRINGS.copyLink,
            10_000,
            { now, nap }
        );
        return { reopened: true, waitingAt };
    }
    /** Close link, then the ended view's Make another link must show (X3). */
    async closeRequestLink({ now = Date.now, nap = sleep } = {}) {
        await this._toRequestView();
        await this._button(REQUEST_STRINGS.closeLink).first().click();
        const endedAt = await this._waitShown(
            REQUEST_STRINGS.makeAnother,
            10_000,
            { now, nap }
        );
        return { closed: true, endedAt };
    }

    /** Put a done or stopped result away (Make another link; DN2 Dismiss is cut, D-169). */
    async dismissRequestResult({ now = Date.now, nap = sleep } = {}) {
        await this._toRequestView();
        await this._button(REQUEST_STRINGS.makeAnother).first().click();
        const at = await this._waitGone(REQUEST_STRINGS.makeAnother, 10_000, {
            now,
            nap,
        });
        return { dismissed: true, at };
    }

    /** Stop a drop that is still receiving (V4 Cancel drop). */
    async cancelRequestDrop({ now = Date.now, nap = sleep } = {}) {
        await this._toRequestView();
        await this._button(REQUEST_STRINGS.cancelDrop).first().click();
        const at = await this._waitGone(REQUEST_STRINGS.cancelDrop, 10_000, {
            now,
            nap,
        });
        return { canceled: true, at };
    }

    /**
     * The done view as the owner reads it: the DN1 heading's file count and
     * whether the DN3 SHA sentence shows. Both are fixed copy; the file
     * names the view lists are never read here.
     */
    async readRequestResult() {
        await this._toRequestView();
        const heading = (await this.readText(RE.requestDone))[0] ?? null;
        const m = heading ? RE.requestDone.exec(heading) : null;
        const verified = await this.readText(
            new RegExp(
                `^${REQUEST_STRINGS.verifiedLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
            )
        );
        return {
            heading,
            files: m ? Number(m[1]) : null,
            verifiedLine: verified.length > 0,
        };
    }

    /**
     * Point the host at another signaling and web origin through the app's
     * own SetSettings, keeping Hide my IP and reportStats as they are, and
     * return what GetSettings reads afterwards. Go reads the addresses when
     * a link is made (MakeRequestLink, endpoints in endpoints.go), so this
     * lands before Make link; only the TA-13 blip uses it, and the runner
     * puts the old values back the same way.
     */
    async setAddresses(server, web) {
        return this.page.evaluate(
            async ([s, w]) => {
                const app = window.go && window.go.main && window.go.main.App;
                if (
                    !app ||
                    typeof app.GetSettings !== 'function' ||
                    typeof app.SetSettings !== 'function'
                )
                    return null;
                const cur = await app.GetSettings();
                await app.SetSettings(s, w, cur.hideIP, cur.reportStats);
                return app.GetSettings();
            },
            [String(server ?? ''), String(web ?? '')]
        );
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
 * Start per the plan, detached (FU-26): Win32_Process.Create through
 * lib/detached.mjs, so the app holds no foreground rights and its first
 * window shows SW_SHOWNOACTIVATE. Resolves { child: null, pid, detached };
 * the explorer.exe AUMID form resolves pid null and launcherPid, because
 * explorer hands the AUMID to the shell and exits, and the window search
 * that follows is the real handshake. `detach` is injectable so tests
 * never start anything.
 */
export async function launchProcess(
    plan,
    { evidenceDir = null, detach = launchDetached } = {}
) {
    if (plan.mode === 'wailsdev') return { child: null, pid: null };
    if (plan.command === 'explorer.exe') {
        const { pid } = await detach({
            command: 'explorer.exe',
            args: plan.args,
            env: null,
            show: SW.SHOWNOACTIVATE,
        });
        return { child: null, pid: null, launcherPid: pid, detached: true };
    }
    const { pid } = await detach({
        command: plan.command,
        args: plan.args,
        cwd: plan.cwd,
        env: plan.env ?? null,
        show: SW.SHOWNOACTIVATE,
    });
    if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true });
        writeFileSync(
            path.join(evidenceDir, 'desktop.launch.txt'),
            `detached launch (FU-26): Win32_Process.Create pid ${pid}, first window SW_SHOWNOACTIVATE; no stdout or stderr pipe\n`
        );
    }
    return { child: null, pid, detached: true };
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

/**
 * RECEIVE, then its Code sub-view (toCodeView), before any receive field is
 * read. Every code-receive path goes through here; the request views reach
 * RECEIVE through _toRequestView and makeRequestLink instead.
 */
export async function openReceiveCode(driver) {
    await driver.click(STRINGS.tabReceive, { index: 0 });
    await driver.toCodeView();
}

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
        // Test seams: the process launcher, the wailsdev page opener and the
        // Explorer verb guard (process-wide unless one is handed in).
        this.launcher = opts.launcher ?? launchProcess;
        this.openDriver = opts.openDriver ?? PlaywrightDriver.open;
        this.shellMenu = opts.shellMenu ?? shellMenuGuard;
        this.shellMenuArmed = false;
        // Set by lib/request.mjs on a request link host; run by stop().
        this.beforeClose = opts.beforeClose ?? null;
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
        const e = {
            // A request host behind a proxy of the run's own (TA-13 blip,
            // TA-14 Caddy) launches pointed at it: an exe has no bound
            // SetSettings (lib/request.mjs startHost sets serverOverride).
            server: this.opts.serverOverride ?? infra.server ?? '',
            web: infra.web ?? '',
            hideIP: Boolean(this.opts.relayOnly),
        };
        return e;
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

    /**
     * Never a second instance (FU-26): the single-instance lock forwards a
     * second launch to the running app, which raises its own window. An
     * instance this process started and is still closing gets
     * SECOND_INSTANCE_WAIT_MS (opts.secondInstanceWaitMs in tests) to go;
     * anything else is SKIP desktop-running before a file is seeded or a
     * launcher runs.
     */
    async refuseSecondInstance() {
        const deadline =
            Date.now() + (this.opts.secondInstanceWaitMs ?? SECOND_INSTANCE_WAIT_MS);
        for (;;) {
            const running = await listDesktopProcesses(this.lister);
            if (!running.length) return;
            const closing = running.every((r) => {
                const own = started.get(r.pid);
                return Boolean(own) && !own.exited;
            });
            if (!closing || Date.now() >= deadline)
                throw new PhaseError(
                    'start',
                    `desktop-running: ${running.map((r) => `${r.image} pid ${r.pid}`).join(', ')} already runs; a second launch would forward to it and raise its window, so none is started`,
                    { verdict: 'SKIP', reason: 'desktop-running' }
                );
            await sleep(250);
        }
    }

    /** Launch per mode, find the window, wait for the tree; sets this.driver. */
    async launch(files = []) {
        const { opts } = this;
        if (this.mode !== 'wailsdev') await this.refuseSecondInstance();
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
            // An unpackaged exe points the user's Explorer verb at itself on
            // startup; the first such launch in this process snapshots it.
            this.shellMenuArmed =
                this.shellMenu.take((l) => this.note(l)) === 'armed';
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
        // FU-28: a UIA pattern call activates an exe's window (G2-F1), so
        // with --user-away every one re-reads the input idle time first,
        // as the request host has since FU-26: an owner who comes back
        // mid-cell stops the leg as SKIP present instead of losing the
        // foreground to it.
        if (this.userAway) this.driver.awayOnly = true;
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
            // So `cleanup` can put the owner's mtime back as well (fix 14).
            mtimeMs: this.guard.mtimeMs,
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
     * true, and transfer.go receiveByCode posts to the configured server
     * when reportStats is true), so a receiver is driven only when
     * GetSettings already shows the audit values; a sender only needs the
     * server under test.
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
        // Before anything is staged: addFiles closes Settings, and the
        // forcer has to be in the page's state before StartSend reads it.
        await this.applyRelayForcer();
        // The wailsdev lane launches no process, so nothing carried the
        // files on argv (planLaunch sets filesStaged false for it) and the
        // page starts on an empty drop zone. Hand them over before spending
        // the staging budget on a wait that cannot pass: the first live run
        // burned 21 s per D2* cell to reach `no button named "Send 1 item"`
        // (2026-09-22). Every other mode stages at launch, and the store
        // fallback below stays the only way to stage a running app, because
        // it activates the window.
        if (
            this.mode === 'wailsdev' &&
            !this.plan?.filesStaged &&
            typeof this.driver.stage === 'function'
        ) {
            await this.driver.stage(files);
            this.note(
                `staged ${files.length} file(s) through the files:open event`
            );
        }
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
        // desktop/transfer.go runSend: TURN credentials, /ws, code registration.
        this.spend('turn');
        this.spend('conn');
        this.spend('code');
        await this.driver.click(want, { controlType: 'Button' });
        this.marks.clicked = Date.now();
        const until = Date.now() + this.budget(CODE_MS);
        // The code and the link land in ONE render: App.tsx sets sendCode
        // and sendLink from the same send:code event. The two reads below
        // are two round trips, so a render between them used to leave the
        // code unread while the link was already on screen, and the cell
        // failed code-registration-failed with the code visible in its own
        // capture (H-DIR-D2C, 2026-09-22: 13 ms from click to link). So
        // wait for both, and settle for a link alone only after a grace
        // window, which is what a sender that really registered no code
        // (a 429 from POST /api/code) looks like.
        let link = null;
        let code = null;
        let linkSeenAt = 0;
        const settle = () => {
            this._link = link;
            this._code = code ? code.toLowerCase() : null;
            this.marks.link = Date.now();
        };
        while (Date.now() < until) {
            const codes = await this.driver.readText(RE.code, {
                controlType: 'Text',
            });
            const links = await this.driver.readText(RE.link, {
                controlType: 'any',
            });
            code =
                codes.find((c) => !sameText(c, STRINGS.codePlaceholder)) ??
                code;
            // Never believe a read that is not a share link: the page's own
            // container text matches a loose pattern too, and the receiver
            // is driven with whatever this returns.
            const shareLink = links.find((l) => isRoomLink(l));
            if (shareLink && !link) {
                link = shareLink;
                linkSeenAt = Date.now();
            }
            if (
                link &&
                (code || Date.now() - linkSeenAt >= CODE_AFTER_LINK_MS)
            ) {
                if (!code)
                    this.note(
                        `share link is up but no room code appeared within ${CODE_AFTER_LINK_MS} ms`
                    );
                settle();
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
        if (link) {
            settle();
            await this.capture('link');
            return;
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
        await this.applyRelayForcer();
        await openReceiveCode(this.driver);
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
        // desktop/transfer.go receiveByCode: code.Resolve (code only), ice.Fetch, /ws.
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
        // pillRe is RE.pill, or RE.pillAuto for TA-10a's host (request.mjs
        // startHost), so AUTO-ACCEPT is kept as an idle word for that cell
        // only; it is never a route verdict either way.
        const pill = await this.driver.readText(this.pillRe || RE.pill, {
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

    /**
     * Force the desktop side onto the relay on the wailsdev lane.
     *
     * Every other mode gets `hideIP` from the desktop.json it launches with
     * (edit(), applied by the config guard or seedRedirectedConfig), but
     * the wailsdev app is started by the operator and the audit never
     * writes its config, so H-REL-*2D and H-REL-D2* observed `direct` and
     * failed forcer-ineffective (2026-09-22).
     *
     * The Settings switch is the mechanism, not the bound SetSettings call,
     * because App.tsx passes its own React `hideIP` to StartSend and
     * ReceiveByCode. That state is read from GetSettings once at mount, so
     * writing the file under a running page would persist a value the
     * transfer never uses. The switch's onChange sets the state AND saves
     * through the app's own saveSettings, which carries reportStats and the
     * addresses over untouched, and GetSettings then proves it landed.
     */
    async applyRelayForcer() {
        if (!this.opts.relayOnly || this.mode !== 'wailsdev') return;
        if (typeof this.driver.setToggle !== 'function')
            throw new PreconditionError(
                'desktop wailsdev: no way to force relay without a settings toggle',
                { reason: 'wailsdev-config' }
            );
        const r = await this.withSettings(() =>
            this.driver.setToggle(RE.hideIpRow, true)
        );
        const after = await this.driver.settings();
        if (after?.hideIP !== true)
            throw new PreconditionError(
                `desktop wailsdev: Hide my IP did not take (toggle ${r.before} -> ${r.after}, GetSettings hideIP=${after?.hideIP}); refusing to record a relay cell that ran direct`,
                { reason: 'wailsdev-config' }
            );
        this.hideIpForced = r.changed;
        this.note(`relay forced through Hide my IP (was ${r.before})`);
    }

    /** Put Hide my IP back, whatever happened to the cell. */
    async restoreRelayForcer() {
        if (!this.hideIpForced || !this.driver) return;
        this.hideIpForced = false;
        try {
            const r = await this.withSettings(() =>
                this.driver.setToggle(RE.hideIpRow, false)
            );
            this.note(`Hide my IP restored to ${r.after}`);
        } catch (err) {
            this.note(`Hide my IP restore failed: ${err.message}`);
        }
    }

    /** Open Settings, run one action against it, close Settings. */
    async withSettings(fn) {
        await this.driver.click(STRINGS.settings, { controlType: 'Button' });
        try {
            return await fn();
        } finally {
            // TitleBar's gear toggles, so the same click closes it.
            await this.driver.click(STRINGS.settings, {
                controlType: 'Button',
            });
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
                // A request link host closes its link and puts its switches
                // back here (lib/request.mjs releaseHost), so an interrupt's
                // shutdown() leaves no link open in the dev app either.
                if (typeof this.beforeClose === 'function') {
                    try {
                        await this.beforeClose(this);
                    } catch (err) {
                        this.note(`before close: ${err.message}`);
                    }
                }
                await this.restoreRelayForcer();
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
            // Only an app's startup rewrites the Explorer verb, so putting it
            // back after the close is final; a second leg's restore finds it
            // already back and writes nothing.
            if (this.shellMenuArmed) {
                this.shellMenuArmed = false;
                try {
                    this.shellMenu.restore((l) => this.note(l));
                } catch (err) {
                    this.note(`explorer verb restore: ${err.message}`);
                    // A config restore error came first and stays the one thrown.
                    if (!restoreError) restoreError = err;
                }
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

// ------------------------------------------------------------ head build

/** The launch modes buildHead can produce a build for by running steps. */
const HEAD_BUILD_MODES = Object.freeze(['portable', 'head', 'auto']);

function mtimeOf(file) {
    try {
        return statSync(file).mtimeMs;
    } catch {
        return null;
    }
}

/**
 * The HEAD desktop build for one launch lane, from lib/release.mjs
 * headDesktopCommands()'s plan ({ version, steps, exe, writes }) plus the
 * run's mode, fence, log and exec. Returns
 * { path, sha256, version, launch, builtAt } for audit.mjs's builds.desktop.
 *
 *   wailsdev  runs NO build step. The operator already has `wails dev`
 *             serving the app under their own isolated APPDATA, and the
 *             audit never starts it, so the only precondition is that the
 *             dev server answers. The lane has no exe on disk, so path and
 *             sha256 come back null and P7 reads n/a.
 *   portable  runs the plan's steps in order: npm run build in
 *   head      desktop/frontend first (desktop/main.go embeds frontend/dist
 *   auto      and that directory is gitignored), then wails build with
 *             shell false so the -ldflags value stays one argv element.
 *             `wails build` can exit 0 on a silent failure (CLAUDE.md), so
 *             the exe's mtime is read before the wails step and has to have
 *             advanced after it.
 *
 * Refuses any other mode, `store` included: the Store build is shipped, not
 * built here. Writes nothing itself and deletes nothing. Every byte lands
 * under the plan's `writes`, and each of those goes through the fence before
 * the first step runs, so a plan naming the real %APPDATA%\floe is a
 * SafetyError rather than a write (lib/fence.mjs refuses that tree, its
 * WebView2 profile and desktop.json ahead of the allowlist, so allowDir
 * cannot open it).
 */
export async function buildHead({
    version = null,
    steps = [],
    exe = null,
    writes = [],
    mode = 'portable',
    fence = null,
    log = () => {},
    exec = defaultExec,
    head = httpHead,
} = {}) {
    if (mode === 'wailsdev') {
        const status = await head(WAILSDEV_URL);
        if (!status)
            throw new PreconditionError(
                `desktop wailsdev: nothing answers ${WAILSDEV_URL}. The operator starts this lane: npm run build in desktop/frontend, then wails dev in desktop/ with APPDATA redirected away from the real %APPDATA%\\floe.`,
                { reason: 'wailsdev-down' }
            );
        log(
            `desktop: wailsdev ${version} answers at ${WAILSDEV_URL} (status ${status}); no build step, no exe on disk`
        );
        return {
            path: null,
            sha256: null,
            version,
            launch: 'wailsdev',
            served: WAILSDEV_URL,
            builtAt: null,
        };
    }
    if (!HEAD_BUILD_MODES.includes(mode))
        throw new PreconditionError(
            `desktop buildHead: ${mode} is not a head desktop lane (expected wailsdev or one of ${HEAD_BUILD_MODES.join(', ')})`,
            { reason: 'head-desktop-mode' }
        );
    if (!exe)
        throw new PreconditionError(
            'desktop buildHead: the build plan carries no exe path',
            { reason: 'head-desktop-plan' }
        );
    if (!fence)
        throw new PreconditionError(
            'desktop buildHead: a write fence is required before any build step runs',
            { reason: 'head-desktop-fence' }
        );
    for (const w of writes) fence.allowDir(w);
    for (const w of writes) fence.assertWritable(w);
    fence.assertWritable(exe);
    const before = mtimeOf(exe);
    for (const step of steps) {
        log(
            `desktop: head build ${step.cmd} ${step.args.join(' ')} (cwd ${step.cwd})`
        );
        await exec(step.cmd, step.args, {
            cwd: step.cwd,
            shell: Boolean(step.shell),
            timeout: step.timeoutMs,
        });
    }
    const after = mtimeOf(exe);
    if (after === null || (before !== null && after <= before))
        throw new PreconditionError(
            `wails build produced no new ${exe} (it can exit 0 on a silent failure, so the exe's mtime has to advance)`,
            { reason: 'head-desktop-build' }
        );
    const sha256Hex = await sha256OfFile(exe);
    log(`desktop: head build ${version} -> ${exe}`);
    return {
        path: exe,
        sha256: sha256Hex,
        version,
        launch: 'portable',
        builtAt: new Date(after).toISOString(),
    };
}

// ---------------------------------------------------------------- probes

/**
 * cleanup: put desktop.json back from the backup a run recorded in its
 * manifest ({ backup, configPath, sha256, mtimeMs }). Refuses while any
 * floe-desktop.exe runs (the app rewrites the file on exit) and writes
 * nothing when the file already matches the backup. With a fence the
 * target must be the fence's own desktop.json (the guard exception), so a
 * manifest edited to name another file is a SafetyError, never a write.
 * After a write it puts the recorded mtime back (fix 14; mtimeRestored is
 * null when the manifest predates the field).
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
    let mtimeRestored = null;
    let mtimeText = '';
    if (Number.isFinite(record.mtimeMs)) {
        try {
            utimesSync(configPath, record.mtimeMs / 1000, record.mtimeMs / 1000);
            mtimeRestored =
                Math.abs(statSync(configPath).mtimeMs - record.mtimeMs) < 1;
        } catch {
            mtimeRestored = false;
        }
        mtimeText = mtimeRestored ? ', mtime restored' : ', mtime changed';
    }
    const got = sha256(readFileSync(configPath));
    return {
        ok: got === want,
        written: true,
        mtimeRestored,
        detail: `desktop.json restored from ${record.backup}: want ${want.slice(0, 8)}, got ${got.slice(0, 8)}${mtimeText}`,
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
            await openReceiveCode(d);
            const set = await d.setValue(
                STRINGS.codePlaceholder,
                'zzz-zzz-zzz'
            );
            detail.set = set;
            await d.click(STRINGS.tabSend, { index: 0 });
            await sleep(300);
            await openReceiveCode(d);
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
            await openReceiveCode(d);
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
                await openReceiveCode(leg.driver);
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
