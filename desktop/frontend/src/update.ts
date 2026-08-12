// Update-notice decision helpers. They live outside App.tsx so they can be
// tested without a DOM or the Wails runtime bindings, which do not exist
// outside the WebView. The comparison mirrors compareDesktopVersions in
// desktop/updatecheck.go - keep the two in sync.

// The notice's click target. Compiled in on purpose: the Go checker returns
// only a version string, so neither a tampered API response nor a hand-edited
// cache file can steer the user's browser anywhere else.
export const DOWNLOAD_URL = 'https://www.floe.one/download';

// bareVersion strips the tag prefixes for display: "desktop-v0.2.3" -> "0.2.3".
export function bareVersion(tag: string): string {
    return tag.replace(/^desktop-/, '').replace(/^v/, '');
}

// isNewerDesktopVersion reports whether candidate is strictly newer than
// baseline. Either side may be a full tag ("desktop-v0.2.3"), v-prefixed, or
// bare. A "dev" or empty baseline is never outdated: the Go side already
// refuses to check on dev builds, and the frontend must not flash a notice
// before GetVersion has resolved. Parts that fail to parse count as 0, so
// malformed input fails closed to "not newer".
export function isNewerDesktopVersion(candidate: string, baseline: string): boolean {
    if (!candidate || !baseline || baseline === 'dev') return false;
    const a = parts(candidate);
    const b = parts(baseline);
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
}

function parts(version: string): [number, number, number] {
    const segs = bareVersion(version).split('.', 3);
    // Digit-strict like the Go side's Atoi: "10rc1" is 0, not 10. parseInt's
    // leniency would make the two comparators disagree on malformed tags.
    const num = (s: string | undefined) => (s && /^\d+$/.test(s) ? parseInt(s, 10) : 0);
    return [num(segs[0]), num(segs[1]), num(segs[2])];
}
