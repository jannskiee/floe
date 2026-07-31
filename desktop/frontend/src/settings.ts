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

/** isDefaultSettings reports whether every setting the Reset section writes is
 *  already at the value Floe ships with.
 *
 *  It trims. The app already treats a whitespace-only value as blank everywhere
 *  it is consumed: ReceiveByCode is handed output.trim(), saveSettings sends both
 *  addresses trimmed, and Go trims again in normalizeConfig. A folder of spaces is
 *  therefore the default, and reporting it as a custom value would be the one
 *  place in the app that disagreed.
 *
 *  Deliberately does NOT consider the Windows right-click menu. That entry is
 *  registry state rather than a setting this reset writes, and the confirm dialog
 *  says so. See resetAllSettings in App.tsx. */
export function isDefaultSettings(s: {
    saveDir: string;
    hideIP: boolean;
    reportStats: boolean;
    server: string;
    web: string;
}): boolean {
    return s.saveDir.trim() === ''
        && !s.hideIP
        && s.reportStats
        && s.server.trim() === ''
        && s.web.trim() === '';
}
