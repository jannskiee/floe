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
