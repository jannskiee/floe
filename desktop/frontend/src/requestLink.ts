// Pure logic for the Request link on the desktop. It lives outside App.tsx so
// it can be tested without a DOM or the Wails runtime bindings (the same
// arrangement as settings.ts and history.ts).

import {
    etaLongLine,
    ETA_OVER_2H_LINE,
    LIFETIME_1H,
    LIFETIME_24H,
    LIFETIME_30M,
    LIFETIME_3D,
    LIFETIME_7D,
    LIFETIME_8H,
} from './requestCopy';

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
// next-launch line).

/** RequestLinkSnapshot mirrors main.RequestLinkSnapshot in wailsjs/go/models.ts
 *  (desktop/requestlink.go). Codes are keys into requestCopy.ts, never text. */
export interface RequestLinkSnapshot {
    state: string;
    code: string;
    gen: number;
    /** Orders snapshots with gen (D-115): the lane stamps every snapshot it
     *  emits or returns from one per-process counter. */
    seq: number;
    promptGen: number;
    link: string;
    label: string;
    saveDir: string;
    expiresAt: number;
    /** The link's own Auto-accept switch (D-173): true when a drop that needs
     *  no asking is accepted at once. Per link, never remembered. */
    autoAccept: boolean;
    route: string;
    reconnectUntil?: number;
    missedAt?: number;
    suggestClose: boolean;
    /** This PC may run on a battery: Go's own fact, asked at each prompt (P11,
     *  E-94). The Receiving view's laptop line reads it. */
    battery: boolean;
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
    /** False only when the save volume positively answered that it can carry the
     *  Windows downloaded-file mark. True where it cannot, and also true when the
     *  volume could not be asked and off Windows: every doubt lands on true,
     *  because true is what brings DN5 back (S-7). Go's own fact. Go always sends
     *  it and normalizeSnapshot always sets it (absent or junk reads as true);
     *  optional only so the fixtures that build a result by hand need not all
     *  name it. */
    noNamedStreams?: boolean;
    folder: string;
    names: string[];
    /** One per name, in the same order: the bytes committed for that file
     *  (D-171), or -1 where Go sent none (that row shows no size). Optional
     *  so the fixtures that build a result by hand need not all name it. */
    sizes?: number[];
    /** The link took this drop by its own choice, with no prompt (HA1,
     *  D-173). Absent reads as not automatic. */
    autoAccepted?: boolean;
}

/** A Link ends key: the fixed set Go's requestLifetime takes (D-173). Nothing
 *  is above 7 days, the server's reservation cap, and nothing is below 30
 *  minutes, so the 9:45 answer window fits inside the shortest link. */
export type Lifetime = '30m' | '1h' | '8h' | '24h' | '3d' | '7d';

/** The Link ends choices in their list order, each key beside its label. */
export const LIFETIMES: readonly {readonly key: Lifetime; readonly label: string}[] = Object.freeze([
    Object.freeze({key: '30m', label: LIFETIME_30M}),
    Object.freeze({key: '1h', label: LIFETIME_1H}),
    Object.freeze({key: '8h', label: LIFETIME_8H}),
    Object.freeze({key: '24h', label: LIFETIME_24H}),
    Object.freeze({key: '3d', label: LIFETIME_3D}),
    Object.freeze({key: '7d', label: LIFETIME_7D}),
]);

export const DEFAULT_LIFETIME: Lifetime = '24h';

/** isLifetime says whether v is one of the six keys. Anything else is left for
 *  the caller to refuse, never folded into the default. */
export function isLifetime(v: unknown): v is Lifetime {
    return typeof v === 'string' && LIFETIMES.some((l) => l.key === v);
}

/** What the REQUEST LINK view shows: the Go states, where a Make link click in
 *  flight shows as making and a result put away as ready. */
export type Phase =
    | 'ready' | 'making' | 'error' | 'waiting' | 'reconnecting' | 'connecting'
    | 'deciding' | 'declined' | 'receiving' | 'done' | 'stopped' | 'ended';

export const OFF_SNAPSHOT: RequestLinkSnapshot = {
    state: 'off', code: '', gen: 0, seq: 0, promptGen: 0, link: '', label: '', saveDir: '',
    expiresAt: 0, autoAccept: false, route: '', suggestClose: false, battery: false,
};

const PHASES = new Set<string>([
    'off', 'ready', 'making', 'error', 'waiting', 'reconnecting', 'connecting',
    'deciding', 'declined', 'receiving', 'done', 'stopped', 'ended',
]);

// A link exists and still works: the header marker and the close guard.
const OPEN = new Set(['waiting', 'reconnecting', 'connecting', 'deciding', 'declined', 'receiving']);
// Results a person can put away with Dismiss, Make another link, or an edit.
const TERMINAL = new Set(['error', 'done', 'stopped', 'ended']);

/** linkOpen: a link exists and works, Waiting to Receiving. */
export function linkOpen(state: string): boolean {
    return OPEN.has(state);
}

/** The frontend's own lane state. */
export interface RequestUI {
    snap: RequestLinkSnapshot;
    /** Make link was clicked and its call has not come back yet. */
    making: boolean;
    /** gen:state:code of a result the owner put away (Dismiss, Make another
     *  link, an edit after an error); a re-emitted copy of it stays away. */
    hiddenKey: string;
    /** A Make link call the bridge rejected outright: shown as the unknown
     *  error until the next Make link or form edit. */
    localError: string;
    /** The last prompt this lane generation showed, as numbers and the
     *  host-computed folder: Receiving names the count and the folder from it
     *  before the first progress event, since a receiving snapshot need not
     *  carry the prompt (D-136). Never a visitor string (OD-04). */
    accepted: {gen: number; files: number; folder: string} | null;
}

export const initialRequestUI: RequestUI = {
    snap: OFF_SNAPSHOT, making: false, hiddenKey: '', localError: '',
    accepted: null,
};

/** keepAccepted is the accepted field after adopting `snap`: its prompt when it
 *  carries one, the one already kept while the generation holds, else none. */
function keepAccepted(prev: RequestUI['accepted'], snap: RequestLinkSnapshot): RequestUI['accepted'] {
    if (snap.prompt) return {gen: snap.gen, files: snap.prompt.files, folder: snap.prompt.folder};
    return prev && prev.gen === snap.gen ? prev : null;
}

/** acceptedPrompt is what Receiving shows before the first progress event: the
 *  count and folder of the prompt this generation answered, or null. */
export function acceptedPrompt(ui: RequestUI): {files: number; folder: string} | null {
    const a = ui.accepted;
    return a && a.gen === ui.snap.gen ? {files: a.files, folder: a.folder} : null;
}

export type RequestEvent =
    | {type: 'SNAPSHOT'; snap: RequestLinkSnapshot}
    | {type: 'MAKE'}
    | {type: 'MAKE_DONE'}
    | {type: 'MAKE_FAILED'}
    | {type: 'ACK_ERROR'}
    | {type: 'MAKE_ANOTHER'}
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
 *  only one that is not older by (gen, seq) (T27 and D-115). Events and
 *  binding replies both pass through here, so a reply the lane stamped before
 *  a later event (an AnswerRequest reply saying deciding after receiving was
 *  emitted, the GetRequestLink pull, MakeRequestLink's making) can never bring
 *  an older state back. An equal (gen, seq) is the same snapshot delivered
 *  twice, since the lane never stamps two alike; adopting it changes nothing
 *  (and lets the stubs, which stamp every answer 0, still show their refusal).
 *  The frontend twin of the lane generation, like recvAttempt in App.tsx. */
export function acceptStale(prev: RequestLinkSnapshot, next: RequestLinkSnapshot): boolean {
    if (next.gen !== prev.gen) return next.gen > prev.gen;
    return next.seq >= prev.seq;
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
        seq: num(r.seq),
        promptGen: num(r.promptGen),
        link: str(r.link),
        label: str(r.label),
        saveDir: str(r.saveDir),
        expiresAt: num(r.expiresAt),
        // Automatic only when the bridge says exactly true (G1: fail closed).
        autoAccept: r.autoAccept === true,
        route: str(r.route),
        suggestClose: r.suggestClose === true,
        battery: r.battery === true,
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
            noNamedStreams: res.noNamedStreams !== false,
            folder: str(res.folder),
            ...namesAndSizes(res.names, res.sizes),
            autoAccepted: res.autoAccepted === true,
        };
    }
    return out;
}

/** namesAndSizes keeps the saved names that are strings and, beside each, its
 *  size from the same index: a finite number of zero or more, else -1. A junk
 *  name drops with its size, so the two never fall out of step (D-171). */
function namesAndSizes(rawNames: unknown, rawSizes: unknown): {names: string[]; sizes: number[]} {
    const names: string[] = [];
    const sizes: number[] = [];
    const ns = Array.isArray(rawNames) ? rawNames : [];
    const ss = Array.isArray(rawSizes) ? rawSizes : [];
    ns.forEach((n, i) => {
        if (typeof n !== 'string') return;
        const s = ss[i];
        names.push(n);
        sizes.push(typeof s === 'number' && Number.isFinite(s) && s >= 0 ? s : -1);
    });
    return {names, sizes};
}

/** reduce is the frontend lane state machine (spec 06 6.3). */
export function reduce(ui: RequestUI, ev: RequestEvent): RequestUI {
    switch (ev.type) {
        case 'SNAPSHOT': {
            if (!acceptStale(ui.snap, ev.snap)) return ui; // T27
            const newer = ev.snap.gen > ui.snap.gen;
            return {
                ...ui,
                snap: ev.snap,
                making: newer ? false : ui.making,
                localError: newer ? '' : ui.localError,
                accepted: keepAccepted(ui.accepted, ev.snap),
            };
        }
        case 'MAKE':
            return {
                ...ui,
                making: true,
                localError: '',
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
        case 'MAKE_ANOTHER': {
            const p = phase(ui);
            if (p !== 'done' && p !== 'stopped' && p !== 'ended' && p !== 'error') return ui;
            return {...ui, localError: '', hiddenKey: keyOf(ui.snap)};
        }
        default:
            return ui;
    }
}

/** phase is what the REQUEST LINK view shows for this state. An idle lane is
 *  ready: nothing is probed ahead of Make link, which is the authority about
 *  the server and answers E1 or E4 under the button (H7 S-1). */
export function phase(ui: RequestUI): Phase {
    const s = ui.snap.state;
    if (ui.localError) return 'error';
    if (ui.making) return 'making';
    if (TERMINAL.has(s) && ui.hiddenKey === keyOf(ui.snap)) return 'ready';
    if (s === 'off' || s === 'ready') return 'ready';
    return (PHASES.has(s) ? s : 'ready') as Phase;
}

/** errorCode is the code the Error phase shows. */
export function errorCode(ui: RequestUI): string {
    return ui.localError || ui.snap.code;
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

/** showLaptopLine: P11 shows on a receiving drop only on a PC with a battery,
 *  and only while the time left reads over 5 minutes, from the same average
 *  and the same first-minute guard as etaLines: a short drop never needs the
 *  advice, and an early estimate is noise. */
export function showLaptopLine(snap: RequestLinkSnapshot, etaSeconds: number, elapsedSeconds: number): boolean {
    if (snap.state !== 'receiving' || !snap.battery) return false;
    if (!(elapsedSeconds >= 60) || !Number.isFinite(etaSeconds)) return false;
    return etaSeconds > 5 * 60;
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
