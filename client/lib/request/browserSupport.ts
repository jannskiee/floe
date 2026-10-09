// What the visitor page needs from the browser it is running in.
//
// Pure over an injected window-shaped object, because client/vitest.config.ts
// runs with environment: 'node'. The caller passes `window`; nothing here
// touches a global.
//
// Everything is a capability probe, never a user-agent string. The one place a
// user agent is unavoidable (folder picking, S1-WEB-02) gets its own function
// and says why.

/** The slice of `window` these probes read. Declared structurally rather than as
 *  `Window` so a test can hand over a plain object and so a missing global is an
 *  ordinary `undefined` rather than a ReferenceError. */
export interface SupportWindow {
    RTCPeerConnection?: unknown;
    HTMLInputElement?: unknown;
}

/** Does `ctor` look like a constructor whose prototype carries `member`?
 *
 *  Both globals these probes read are declared as `var`, not as properties of
 *  the Window interface, which is why callers pass `typeof window` rather than
 *  `Window`: a plain `Window` shares no property with SupportWindow and
 *  TypeScript rejects the call as a weak-type mismatch. */
function prototypeHas(ctor: unknown, member: string): boolean {
    if (typeof ctor !== 'function') return false;
    const proto = (ctor as { prototype?: unknown }).prototype;
    if (typeof proto !== 'object' || proto === null) return false;
    return member in proto;
}

/** True when this browser can open a WebRTC data channel.
 *
 *  Both halves are load-bearing. A browser can expose RTCPeerConnection and
 *  still not carry createDataChannel (the media-only implementations, and the
 *  shims some in-app webviews install), and a data channel is the only thing
 *  this page uses a peer connection for: no media, no getUserMedia. The probe
 *  therefore reads the PROTOTYPE rather than constructing a peer connection,
 *  because constructing one is the very thing the page must not do before the
 *  visitor asks for it (it would start ICE gathering on a page load).
 *
 *  Checking the prototype and not an instance also means this stays true in the
 *  one case that matters for tests: an init script that deletes
 *  window.RTCPeerConnection outright. */
export function hasDataChannelSupport(win: SupportWindow | undefined | null): boolean {
    const ctor = win?.RTCPeerConnection;
    if (typeof ctor !== 'function') return false;
    const proto = (ctor as { prototype?: unknown }).prototype;
    if (typeof proto !== 'object' || proto === null) return false;
    return typeof (proto as { createDataChannel?: unknown }).createDataChannel === 'function';
}

/** Chrome's major version when this user agent is Chrome ON ANDROID, else null.
 *  Desktop Chrome and Chrome on iOS (which is WebKit, and says CriOS) are not
 *  this. */
function chromeAndroidMajor(userAgent: string): number | null {
    if (!/\bAndroid\b/.test(userAgent)) return null;
    const match = /\bChrome\/(\d+)/.exec(userAgent);
    return match ? Number(match[1]) : null;
}

/** The iOS version when this user agent is an iOS device, else null. Every
 *  browser on iOS is WebKit, so the limitation below is the platform's and the
 *  brand in the user agent does not matter.
 *
 *  An iOS device whose version cannot be read returns 0.0, which sorts below
 *  every threshold: unknown means hide. iPadOS in desktop mode says Macintosh
 *  and is not detectable here at all, which is a known gap rather than a
 *  decision. */
function iosVersion(userAgent: string): { major: number; minor: number } | null {
    if (!/\b(iPhone|iPad|iPod)\b/.test(userAgent)) return null;
    // "CPU iPhone OS 18_3 like Mac OS X" and the iPad form "CPU OS 18_3".
    const os = /\bOS (\d+)(?:[._](\d+))?/.exec(userAgent);
    if (os) return { major: Number(os[1]), minor: Number(os[2] ?? 0) };
    const version = /\bVersion\/(\d+)(?:\.(\d+))?/.exec(userAgent);
    if (version) return { major: Number(version[1]), minor: Number(version[2] ?? 0) };
    return { major: 0, minor: 0 };
}

/**
 * True when Choose folder is worth showing.
 *
 * Feature detection alone is not enough here, which is why a user agent is a
 * parameter. Three cases, and only the first is detectable:
 *
 * - `webkitdirectory` absent from HTMLInputElement.prototype: the attribute does
 *   nothing, and the browser says so. Firefox Android before 142 is here.
 * - Chrome on Android below 132: the property IS present. 18 to 130 let the
 *   visitor open the picker and then offer only files, and 131 crashes when a
 *   directory is selected. Nothing in the DOM distinguishes those from a working
 *   implementation.
 * - iOS below 18.4: the property is present and setting it has no effect.
 *
 * Hiding the button is the whole remedy. The dropzone still takes a dragged
 * folder on any browser with the entries API, and C-30 names zipping as the
 * fallback.
 */
export function canPickFolders(
    win: SupportWindow | undefined | null,
    userAgent: string
): boolean {
    if (!prototypeHas(win?.HTMLInputElement, 'webkitdirectory')) return false;

    const chromeAndroid = chromeAndroidMajor(userAgent);
    if (chromeAndroid !== null && chromeAndroid < 132) return false;

    const ios = iosVersion(userAgent);
    if (ios && (ios.major < 18 || (ios.major === 18 && ios.minor < 4))) return false;

    return true;
}

/** The slice of `window` the pointer probe reads. */
export interface PointerWindow {
    matchMedia?: (query: string) => { matches: unknown };
}

/**
 * True on a touch-first device: a phone or a tablet, where the page shows
 * "Keep this page open and your screen on." above Send and hides the drop copy
 * (E-45, D-091 Q-C11: a line, never a block).
 *
 * Only a real `true` counts. A missing or throwing matchMedia reads as a fine
 * pointer, because the line is a courtesy and a desktop visitor who is shown
 * it loses nothing, while a probe error must never stop a send.
 */
export function isCoarsePointer(win: PointerWindow | undefined | null): boolean {
    try {
        return win?.matchMedia?.('(pointer: coarse)').matches === true;
    } catch {
        return false;
    }
}

const RELAY_SCHEME = /^turns?:/i;
const ICE_SCHEME = /^(stun|stuns|turn|turns):/i;

function urlsOf(server: RTCIceServer): string[] {
    return Array.isArray(server.urls) ? server.urls : [server.urls];
}

/** True when the list offers any TURN relay (a `turn:` or `turns:` URL, in a
 *  string or an array). Hide my IP needs one: with none, the page stops
 *  before it joins rather than failing ICE with the switch on (V6b). */
export function hasRelayUrl(iceServers: readonly RTCIceServer[]): boolean {
    return iceServers.some((s) => urlsOf(s).some((u) => typeof u === 'string' && RELAY_SCHEME.test(u)));
}

/**
 * The ICE server list from a `/api/turn-credentials` answer, or null.
 *
 * The answer is a server's word, not a peer's, but it still goes straight
 * into an RTCPeerConnection, so it is checked for shape: an array of entries
 * whose `urls` is a non-empty string or string array of ICE schemes, with
 * optional string `username` and `credential`. Anything else refuses the whole
 * answer and the page keeps its own STUN list. Only those three keys are kept.
 * Nothing here logs or returns the credential anywhere but the peer config.
 */
export function parseIceServers(body: unknown): RTCIceServer[] | null {
    if (!Array.isArray(body) || body.length === 0) return null;
    const out: RTCIceServer[] = [];
    for (const entry of body) {
        if (typeof entry !== 'object' || entry === null) return null;
        const { urls, username, credential } = entry as Record<string, unknown>;
        const list = Array.isArray(urls) ? urls : [urls];
        if (list.length === 0) return null;
        if (!list.every((u) => typeof u === 'string' && ICE_SCHEME.test(u))) return null;
        if (username !== undefined && typeof username !== 'string') return null;
        if (credential !== undefined && typeof credential !== 'string') return null;
        const server: RTCIceServer = { urls: urls as string | string[] };
        if (username !== undefined) server.username = username;
        if (credential !== undefined) server.credential = credential;
        out.push(server);
    }
    return out;
}
