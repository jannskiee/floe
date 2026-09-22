// Pure helpers for the Settings screen.
//
// They live outside App.tsx so they can be tested without a DOM or the Wails
// runtime bindings, which do not exist outside the WebView.

/** hostOf reduces an address to its host for display, e.g.
 *  "https://files.example.com:8443/" -> "files.example.com:8443".
 *
 *  Deliberately defensive: it runs against a field the user is still typing into,
 *  so "https://", "files.exa", and "" all reach it. new URL throws on every one of
 *  those, so the fallback strips a scheme and everything from the first slash and
 *  returns whatever is left, which is the best available answer mid-keystroke. */
export function hostOf(raw: string): string {
    const s = raw.trim();
    if (!s) return '';
    // No trailing-slash strip before this point, deliberately. Doing that turns a
    // half-typed "https://" into "https:", which then parses as a scheme with no
    // host and renders as the literal text "https:" in the summary line. URL.host
    // already excludes the path, so the strip bought nothing anyway.
    try {
        const host = new URL(s).host;
        if (host) return host;
    } catch {
        // Not a URL yet. Fall through and do what we can with the raw text.
    }
    // The (\/\/)? is what makes "https://" collapse to empty rather than to the
    // scheme: match the separator when present, and the scheme alone when it is not.
    return s.replace(/^[a-z][a-z0-9+.-]*:(\/\/)?/i, '').split('/')[0];
}

/** advancedSummary is the description on the collapsed Advanced row. It is the
 *  main thing standing between a user and a forgotten server override, so it
 *  names both the value in effect and what that value costs them.
 *
 *  There are THREE states, not two, and the third is the one that gets lost.
 *  Overriding only the share link address leaves the app signaling against Floe's
 *  own server, so telling that user "people on Floe's server cannot connect to
 *  you" would be flatly false. Collapsing this to a boolean is the single most
 *  likely regression here, which is why it has its own test. */
export function advancedSummary(server: string, web: string): string {
    if (server.trim() !== '') {
        return `This app uses ${hostOf(server)}, so people on floe.one cannot connect to you.`;
    }
    if (web.trim() !== '') {
        return `Share links point to ${hostOf(web)}, but this app still uses Floe's server.`;
    }
    return "This app uses Floe's server. You can point it at your own instead.";
}

/** webPlaceholder shows what the Web address field falls back to when left blank,
 *  so the derivation is visible instead of implied. Mirrors engine/serverurl.Web,
 *  which is what actually builds the link; keep the two in step. */
export function webPlaceholder(server: string): string {
    const s = server.trim().replace(/\/+$/, '');
    if (s === '' || s === 'https://api.floe.one') return 'https://floe.one';
    if (s === 'http://localhost:3001') return 'http://localhost:3000';
    return s;
}

// Settings > Beta > Request links copy, verbatim from the approved desktop copy
// table (Checkpoint C, rows S1 to S5). approvedCopy.test.ts byte-matches them.
export const BETA_HEADING = 'Beta'; // S1
export const REQUEST_LINKS_LABEL = 'Request links'; // S2
export const REQUEST_LINKS_ON_LINE = 'Let someone send files to this PC through a link you make. Works while Floe is open.'; // S3
export const REQUEST_LINKS_NO_SERVER_LINE = 'Not available on this server right now.'; // S4
export const REQUEST_LINKS_LINK_OPEN_LINE = 'Close your request link first.'; // S5

/** The Go-side /health probe result (FeatureResult in serverprobe.go). */
export interface RequestFeature {
    reachable: boolean;
    requestLinks: boolean;
}

/** requestLinksSwitch decides the Beta switch's state and the one line under
 *  it (spec 06 4.19).
 *
 *  An open link wins over everything: turning the Beta off must never strand a
 *  live link or a running drop, so the switch locks with S5 whatever the server
 *  says. Otherwise the switch works only against a server that listed request-1
 *  on the last probe; an unreachable server and one without the feature read
 *  the same (S4), because the app cannot tell a policy flip from an older
 *  self-hosted server. Before the first probe answers (null) the switch stays
 *  disabled but keeps the plain S3 line rather than claiming the server said
 *  no. */
export function requestLinksSwitch(
    feature: RequestFeature | null,
    linkOpen: boolean,
): {disabled: boolean; description: string} {
    if (linkOpen) return {disabled: true, description: REQUEST_LINKS_LINK_OPEN_LINE};
    if (feature === null) return {disabled: true, description: REQUEST_LINKS_ON_LINE};
    if (feature.reachable && feature.requestLinks) return {disabled: false, description: REQUEST_LINKS_ON_LINE};
    return {disabled: true, description: REQUEST_LINKS_NO_SERVER_LINE};
}
