// Pure logic for the Request link on the desktop. It lives outside App.tsx so
// it can be tested without a DOM or the Wails runtime bindings (the same
// arrangement as settings.ts and history.ts).

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
