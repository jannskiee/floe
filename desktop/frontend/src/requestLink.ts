// Pure logic for the Request link on the desktop. It lives outside App.tsx so
// it can be tested without a DOM or the Wails runtime bindings (the same
// arrangement as settings.ts and history.ts).

import {etaLongLine, ETA_OVER_2H_LINE} from './requestCopy';

// The link shapes the web app serves in a browser only: a request link
// (/r/<11-character id>) and the Stage 2 drop link (/d/<id>, legacy /drop/<id>).
// Matched against the PATH and anchored at its end, so a self-hosted base path
// (https://files.example.com/floe/r/<id>) matches by its suffix and a query or
// fragment cannot fool either one; one trailing slash is allowed because a
// browser adds it. The same suffix rules as the engine's code.Resolve (spec 05
// 8.9), so the frontend pre-check and the Go defense in depth agree.
const REQUEST_PATH = /(^|\/)r\/[A-Za-z0-9_-]{11}\/?$/;
const DROP_PATH = /(^|\/)(d|drop)\/[A-Za-z0-9_-]+\/?$/;

/** requestLinkKind says whether a pasted Receive input is a request or drop
 *  link, which Floe Desktop cannot receive from: it is for a web browser. Only
 *  http and https URLs qualify, which is also what makes the parsed href safe
 *  to hand to BrowserOpenURL (a file: or custom-scheme string never gets that
 *  far). */
export function requestLinkKind(input: string): 'request' | 'drop' | null {
    return parsePastedLink(input)?.kind ?? null;
}

/** parsePastedLink is requestLinkKind plus the normalized href to open. */
export function parsePastedLink(input: string): {kind: 'request' | 'drop'; href: string} | null {
    let u: URL;
    try {
        u = new URL(input.trim());
    } catch {
        return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (REQUEST_PATH.test(u.pathname)) return {kind: 'request', href: u.href};
    if (DROP_PATH.test(u.pathname)) return {kind: 'drop', href: u.href};
    return null;
}

// ---------------------------------------------------------------------------
// The Request link lane as the frontend sees it (spec 06 4.4 and 6.3). Go is
// authoritative: the frontend adopts request:state snapshots and keeps only
// what Go never sees (a Make link click in flight, a result put away, the
// feature probe and the Settings switch).

/** RequestLinkSnapshot mirrors main.RequestLinkSnapshot in wailsjs/go/models.ts
 *  (desktop/requestlink.go). Codes are keys into requestCopy.ts, never text. */
export interface RequestLinkSnapshot {
    state: string;
    code: string;
    gen: number;
    promptGen: number;
    link: string;
    label: string;
    saveDir: string;
    expiresAt: number;
    route: string;
    reconnectUntil?: number;
    missedAt?: number;
    suggestClose: boolean;
    prompt?: RequestPrompt;
    result?: RequestResult;
}

/** The Accept prompt: the visitor's claims as numbers, and host-computed
 *  values. There is no field for a string the visitor chose (OD-04). */
export interface RequestPrompt {
    files: number;
    totalBytes: number;
    folder: string;
    freeBytes: number;
    warnings: string[];
    answerBy: number;
}

/** An accepted drop's outcome. names are the engine's display-safe saved
 *  names, at most 200; files keeps the real count. */
export interface RequestResult {
    files: number;
    saved: number;
    bytes: number;
    verified: number;
    renamed: number;
    folder: string;
    names: string[];
}

/** What the REQUEST LINK view shows: the Go states, where a Make link click in
 *  flight shows as making and a result put away as ready. */
export type Phase =
    | 'off' | 'ready' | 'making' | 'error' | 'waiting' | 'reconnecting' | 'connecting'
    | 'deciding' | 'declined' | 'receiving' | 'done' | 'stopped' | 'ended';

export const OFF_SNAPSHOT: RequestLinkSnapshot = {
    state: 'off', code: '', gen: 0, promptGen: 0, link: '', label: '', saveDir: '',
    expiresAt: 0, route: '', suggestClose: false,
};

const PHASES = new Set<string>([
    'off', 'ready', 'making', 'error', 'waiting', 'reconnecting', 'connecting',
    'deciding', 'declined', 'receiving', 'done', 'stopped', 'ended',
]);

// The lane holds something: a link being made or open, a drop or its result.
// E-38: the kill switch never hides the row over any of these.
const HOLDS = new Set(['making', 'waiting', 'reconnecting', 'connecting', 'deciding', 'declined', 'receiving', 'done', 'stopped']);
// A link exists and still works: the header marker and the close guard.
const OPEN = new Set(['waiting', 'reconnecting', 'connecting', 'deciding', 'declined', 'receiving']);
// Results a person can put away with Dismiss, Make another link, or an edit.
const TERMINAL = new Set(['error', 'done', 'stopped', 'ended']);

export function laneHoldsSomething(state: string): boolean {
    return HOLDS.has(state);
}

/** linkOpen: a link exists and works, Waiting to Receiving. */
export function linkOpen(state: string): boolean {
    return OPEN.has(state);
}

/** The frontend's own lane state. */
export interface RequestUI {
    snap: RequestLinkSnapshot;
    switchOn: boolean;
    featurePresent: boolean;
    /** Make link was clicked and its call has not come back yet. */
    making: boolean;
    /** gen:state:code of a result the owner put away (Dismiss, Make another
     *  link, an edit after an error); a re-emitted copy of it stays away. */
    hiddenKey: string;
    /** A Make link call the bridge rejected outright: shown as the unknown
     *  error until the next Make link or form edit. */
    localError: string;
    /** Floe closed last time with a link open (X5, O7): shown as an ended
     *  link until the owner moves on, and only while Go has nothing to say. */
    relaunch: boolean;
}

export const initialRequestUI: RequestUI = {
    snap: OFF_SNAPSHOT, switchOn: false, featurePresent: false, making: false, hiddenKey: '', localError: '', relaunch: false,
};

export type RequestEvent =
    | {type: 'FEATURE'; switchOn?: boolean; requestLinks?: boolean}
    | {type: 'SNAPSHOT'; snap: RequestLinkSnapshot}
    | {type: 'MAKE'}
    | {type: 'MAKE_DONE'}
    | {type: 'MAKE_FAILED'}
    | {type: 'ACK_ERROR'}
    | {type: 'DISMISS'}
    | {type: 'MAKE_ANOTHER'}
    | {type: 'RELAUNCH'}
    // No state of their own: Go answers each with a snapshot. They exist so a
    // caller can dispatch them and the tests can show they change nothing
    // locally (T9, T14, T15, T17, T18, T20, T23).
    | {type: 'CLOSE'}
    | {type: 'ANSWER'; answer: string}
    | {type: 'CANCEL_DROP'}
    | {type: 'GUARD_TICK'}
    | {type: 'WINDOW_FOCUS'};

function keyOf(s: RequestLinkSnapshot): string {
    return `${s.gen}:${s.state}:${s.code}`;
}

/** acceptStale says whether a snapshot may be adopted over the current one:
 *  never one with a lower gen (T27; the frontend twin of the lane generation,
 *  like recvAttempt in App.tsx). */
export function acceptStale(prev: RequestLinkSnapshot, next: RequestLinkSnapshot): boolean {
    return next.gen >= prev.gen;
}

/** normalizeSnapshot coerces a snapshot from the bridge into the shape the
 *  view reads, so a missing or mistyped field can never throw during render.
 *  An unknown state reads as off. */
export function normalizeSnapshot(raw: unknown): RequestLinkSnapshot {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const state = str(r.state);
    const out: RequestLinkSnapshot = {
        state: PHASES.has(state) ? state : 'off',
        code: str(r.code),
        gen: num(r.gen),
        promptGen: num(r.promptGen),
        link: str(r.link),
        label: str(r.label),
        saveDir: str(r.saveDir),
        expiresAt: num(r.expiresAt),
        route: str(r.route),
        suggestClose: r.suggestClose === true,
    };
    if (num(r.reconnectUntil)) out.reconnectUntil = num(r.reconnectUntil);
    if (num(r.missedAt)) out.missedAt = num(r.missedAt);
    const p = r.prompt as Record<string, unknown> | undefined;
    if (p && typeof p === 'object') {
        out.prompt = {
            files: num(p.files),
            totalBytes: num(p.totalBytes),
            folder: str(p.folder),
            freeBytes: num(p.freeBytes),
            warnings: Array.isArray(p.warnings) ? p.warnings.filter((w): w is string => typeof w === 'string') : [],
            answerBy: num(p.answerBy),
        };
    }
    const res = r.result as Record<string, unknown> | undefined;
    if (res && typeof res === 'object') {
        out.result = {
            files: num(res.files),
            saved: num(res.saved),
            bytes: num(res.bytes),
            verified: num(res.verified),
            renamed: num(res.renamed),
            folder: str(res.folder),
            names: Array.isArray(res.names) ? res.names.filter((n): n is string => typeof n === 'string') : [],
        };
    }
    return out;
}

/** reduce is the frontend lane state machine (spec 06 6.3). */
export function reduce(ui: RequestUI, ev: RequestEvent): RequestUI {
    switch (ev.type) {
        case 'FEATURE':
            return {
                ...ui,
                switchOn: ev.switchOn ?? ui.switchOn,
                featurePresent: ev.requestLinks ?? ui.featurePresent,
            };
        case 'SNAPSHOT': {
            if (!acceptStale(ui.snap, ev.snap)) return ui; // T27
            const newer = ev.snap.gen > ui.snap.gen;
            return {
                ...ui,
                snap: ev.snap,
                making: newer ? false : ui.making,
                localError: newer ? '' : ui.localError,
                relaunch: newer ? false : ui.relaunch,
            };
        }
        case 'MAKE':
            return {
                ...ui,
                making: true,
                localError: '',
                relaunch: false,
                // The old result goes away the moment a new link is asked for.
                hiddenKey: TERMINAL.has(ui.snap.state) ? keyOf(ui.snap) : ui.hiddenKey,
            };
        case 'MAKE_DONE':
            return {...ui, making: false};
        case 'MAKE_FAILED':
            return {...ui, making: false, localError: 'unknown'};
        case 'ACK_ERROR':
            if (phase(ui) !== 'error') return ui;
            return {...ui, localError: '', hiddenKey: ui.snap.state === 'error' ? keyOf(ui.snap) : ui.hiddenKey};
        case 'DISMISS':
        case 'MAKE_ANOTHER': {
            const p = phase(ui);
            if (p !== 'done' && p !== 'stopped' && p !== 'ended' && p !== 'error') return ui;
            if (ui.relaunch) return {...ui, relaunch: false};
            return {...ui, localError: '', hiddenKey: keyOf(ui.snap)};
        }
        case 'RELAUNCH':
            // X5 on the next launch, and only over a lane with nothing to say.
            if (ui.snap.gen !== 0 || (ui.snap.state !== 'off' && ui.snap.state !== 'ready')) return ui;
            return {...ui, relaunch: true};
        default:
            return ui;
    }
}

/** phase is what the REQUEST LINK view shows for this state. */
export function phase(ui: RequestUI): Phase {
    const s = ui.snap.state;
    if (!ui.switchOn && !HOLDS.has(s)) return 'off';
    if (ui.localError) return 'error';
    if (ui.making) return 'making';
    if (ui.relaunch && (s === 'off' || s === 'ready')) return 'ended';
    if (TERMINAL.has(s) && ui.hiddenKey === keyOf(ui.snap)) return ui.featurePresent ? 'ready' : 'off';
    if (s === 'off' || s === 'ready') return ui.featurePresent ? 'ready' : 'off';
    return (PHASES.has(s) ? s : 'off') as Phase;
}

/** RELAUNCHED is what the view shows for X5: an ended link with no label
 *  (the label died with the link). */
const RELAUNCHED: RequestLinkSnapshot = {...OFF_SNAPSHOT, state: 'ended', code: 'app-closed'};

/** viewSnapshot is the snapshot the REQUEST LINK view renders: Go's, or the
 *  local X5 ended link after a relaunch. */
export function viewSnapshot(ui: RequestUI): RequestLinkSnapshot {
    const s = ui.snap.state;
    if (ui.switchOn && !ui.making && !ui.localError && ui.relaunch && (s === 'off' || s === 'ready')) return RELAUNCHED;
    return ui.snap;
}

/** errorCode is the code the Error phase shows. */
export function errorCode(ui: RequestUI): string {
    return ui.localError || ui.snap.code;
}

/** showRow decides whether Receive shows the CODE | REQUEST LINK row (E-38):
 *  the switch must be on, and then the server must list request-1 or the lane
 *  must hold a link, a drop or its result. The kill switch never hides the row
 *  under a running drop. */
export function showRow(switchOn: boolean, featurePresent: boolean, laneState: string): boolean {
    return switchOn && (featurePresent || laneHoldsSomething(laneState));
}

/** markerVisible: the header "link open" marker, Waiting to Receiving (H1). */
export function markerVisible(snap: RequestLinkSnapshot): boolean {
    return linkOpen(snap.state);
}

/** settingsLocked: the Settings switch locks with S5 from making a link until
 *  its result is put away, so turning the Beta off never strands a link. */
export function settingsLocked(p: Phase): boolean {
    return HOLDS.has(p);
}

/** noticeVisible: the request notice shows on every screen while a prompt is
 *  pending, except on REQUEST LINK with the prompt scrolled into view. */
export function noticeVisible(snap: RequestLinkSnapshot, onRequestView: boolean, promptInView: boolean): boolean {
    return snap.state === 'deciding' && !(onRequestView && promptInView);
}

/** canMake: Make link is offered only with nothing open and nothing being
 *  made (one link in the Beta, OD-05). */
export function canMake(p: Phase): boolean {
    return p === 'ready' || p === 'error';
}

/** The Accept and Decline guard (spec 06 5.5, E-44): 1 s after the prompt
 *  renders and 1 s after the window regains focus. */
export const GUARD_MS = 1000;

export function guardActive(now: number, mountedAt: number, focusAt: number | null): boolean {
    if (now - mountedAt < GUARD_MS) return true;
    return focusAt !== null && now - focusAt < GUARD_MS;
}

/** etaLines: the long-drop warning under a receiving drop's progress. Nothing
 *  in the first minute (an early estimate is noise); then V6 when the time
 *  left is over 24 hours, V5 when it is over 2 hours. */
export function etaLines(snap: RequestLinkSnapshot, etaSeconds: number, elapsedSeconds: number): string[] {
    if (snap.state !== 'receiving') return [];
    if (!(elapsedSeconds >= 60) || !Number.isFinite(etaSeconds)) return [];
    if (etaSeconds > 24 * 3600) return [etaLongLine(etaSeconds)];
    if (etaSeconds > 2 * 3600) return [ETA_OVER_2H_LINE];
    return [];
}
