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
        return `Uses ${hostOf(server)}, so people on floe.one can't reach you`;
    }
    if (web.trim() !== '') {
        return `Share links point to ${hostOf(web)}, but transfers use Floe's server`;
    }
    return "Uses Floe's server unless you set your own";
}

/** webPlaceholder shows what the Web address field falls back to when left blank,
 *  so the derivation is visible instead of implied. Mirrors engine/serverurl.Web,
 *  which is what actually builds the link: the address read the way Normalize
 *  reads it (scheme and host in lower case, the default port dropped), and the
 *  host matched with one trailing dot taken off. It used to compare the raw
 *  string, so https://API.floe.one showed the API address while the link went to
 *  floe.one (CLI-05). One table pins both: the WEB-VECTORS rows in
 *  settings.test.ts, which TestWebMatchesTheDesktopPlaceholder also runs over
 *  Web. */
export function webPlaceholder(server: string): string {
    const s = normalizeServer(server);
    const key = withoutRootDot(s);
    if (s === '' || key === 'https://api.floe.one') return 'https://floe.one';
    if (key === 'http://localhost:3001') return 'http://localhost:3000';
    return s;
}

/** normalizeServer is engine/serverurl.Normalize: whitespace and every trailing
 *  slash trimmed, and for http or https the scheme and host in lower case and
 *  the default port (:443 on https, :80 on http) dropped. Userinfo, any other
 *  port and the path keep their case. */
function normalizeServer(server: string): string {
    const s = server.trim().replace(/\/+$/, '');
    const i = s.indexOf('://');
    if (i < 0) return s;
    const scheme = s.slice(0, i).toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return s;
    const rest = s.slice(i + 3);
    let end = rest.search(/[/?#]/);
    if (end < 0) end = rest.length;
    let authority = rest.slice(0, end);
    const tail = rest.slice(end);
    let user = '';
    const at = authority.lastIndexOf('@');
    if (at >= 0) {
        user = authority.slice(0, at + 1);
        authority = authority.slice(at + 1);
    }
    let host = authority.toLowerCase();
    if (scheme === 'https' && host.endsWith(':443')) host = host.slice(0, -':443'.length);
    else if (scheme === 'http' && host.endsWith(':80')) host = host.slice(0, -':80'.length);
    return `${scheme}://${user}${host}${tail}`;
}

/** withoutRootDot is the engine's withoutRootDot: a normalized address with one
 *  trailing dot taken off its host, for comparison only. */
function withoutRootDot(s: string): string {
    const i = s.indexOf('://');
    if (i < 0) return s;
    const rest = s.slice(i + 3);
    let end = rest.search(/[/?#]/);
    if (end < 0) end = rest.length;
    let host = rest.slice(0, end);
    const tail = rest.slice(end);
    let port = '';
    const c = host.lastIndexOf(':');
    if (c >= 0 && !host.slice(c).includes(']')) {
        port = host.slice(c);
        host = host.slice(0, c);
    }
    if (host.endsWith('.')) host = host.slice(0, -1);
    return `${s.slice(0, i + 3)}${host}${port}${tail}`;
}

// Settings > Notifications (D-162). The words are the approved NS1 to NS8 rows,
// byte for byte (approvedCopy.test.ts), and the Windows-only row is the one
// place Floe sends people to Windows' own per-app settings for banners, the
// Notification Center and the lock screen: Windows alone decides where a banner
// appears, so there is no position or duration control here.
export const NOTIFICATIONS_HEADING = 'Notifications';
export const SHOW_NOTIFICATIONS = 'Show notifications';
export const SHOW_NOTIFICATIONS_ON = 'For requests and transfers while Floe is in the background';
export const SHOW_NOTIFICATIONS_OFF = 'Requests still flash Floe on the taskbar';
export const PLAY_SOUND = 'Play sound';
export const WINDOWS_NOTIFICATIONS = 'Windows notification settings';
export const WINDOWS_NOTIFICATIONS_DESCRIPTION = 'Banners, Notification Center and lock screen';
export const OPEN_NOTIFICATION_SETTINGS = 'Open';
/** The Open button's accessible name: its visible word first (WCAG 2.5.3). */
export const OPEN_NOTIFICATION_SETTINGS_LABEL = 'Open Windows notification settings';
export const NOTIFICATION_SETTINGS_URI = 'ms-settings:notifications';
