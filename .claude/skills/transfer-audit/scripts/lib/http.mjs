// GET-only HTTP for the audit. There is no way to send a body from here:
// the request method is fixed per function (GET or HEAD), no function takes
// a body, and http.test.mjs greps every script for the POST method name.
// `getDerived` is the shape the TURN probe needs: the body is parsed in
// memory, handed to a pure `derive` callback, and never returned, logged
// or stored.

export class HttpError extends Error {
    constructor(message, extra = {}) {
        super(message);
        this.name = 'HttpError';
        Object.assign(this, extra);
    }
}

const DEFAULT_TIMEOUT_MS = 10_000;

function withTimeout(timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    return { signal: ctl.signal, clear: () => clearTimeout(timer) };
}

function headerMap(headers) {
    const out = {};
    if (headers && typeof headers.forEach === 'function')
        headers.forEach((v, k) => {
            out[k.toLowerCase()] = v;
        });
    return out;
}

function contentLengthOf(headers) {
    const n = Number(headers['content-length']);
    return Number.isFinite(n) ? n : null;
}

/** GET url -> { status, ok, headers, text, contentLength }. */
export async function get(
    url,
    {
        timeoutMs = DEFAULT_TIMEOUT_MS,
        headers = {},
        fetchImpl = globalThis.fetch,
        redirect = 'follow',
    } = {}
) {
    const t = withTimeout(timeoutMs);
    try {
        const res = await fetchImpl(url, {
            method: 'GET',
            headers,
            redirect,
            signal: t.signal,
        });
        const h = headerMap(res.headers);
        const text = await res.text();
        return {
            status: res.status,
            ok: res.ok,
            headers: h,
            text,
            url: res.url || url,
            contentLength: contentLengthOf(h),
        };
    } catch (e) {
        throw new HttpError(
            `GET ${url}: ${e.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : e.message}`,
            { url, cause: e }
        );
    } finally {
        t.clear();
    }
}

/** GET url and parse JSON -> { status, ok, headers, json }. */
export async function getJson(url, opts = {}) {
    const res = await get(url, opts);
    let json = null;
    try {
        json = res.text ? JSON.parse(res.text) : null;
    } catch (e) {
        throw new HttpError(`GET ${url}: body is not JSON (${e.message})`, {
            url,
            status: res.status,
        });
    }
    return {
        status: res.status,
        ok: res.ok,
        headers: res.headers,
        json,
        url: res.url,
    };
}

/** HEAD url -> { status, ok, headers, url }. Follows redirects. */
export async function head(
    url,
    {
        timeoutMs = DEFAULT_TIMEOUT_MS,
        headers = {},
        fetchImpl = globalThis.fetch,
    } = {}
) {
    const t = withTimeout(timeoutMs);
    try {
        const res = await fetchImpl(url, {
            method: 'HEAD',
            headers,
            redirect: 'follow',
            signal: t.signal,
        });
        return {
            status: res.status,
            ok: res.ok,
            headers: headerMap(res.headers),
            url: res.url || url,
        };
    } catch (e) {
        throw new HttpError(
            `HEAD ${url}: ${e.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : e.message}`,
            { url, cause: e }
        );
    } finally {
        t.clear();
    }
}

/**
 * GET url, parse the JSON body in memory, return only what `derive(json)`
 * computes. The body and the parsed object are dropped before returning;
 * neither is attached to the result or to any thrown error. `neverBody` is
 * always true here and is exported so callers can assert on it.
 */
export async function getDerived(
    url,
    derive,
    {
        timeoutMs = DEFAULT_TIMEOUT_MS,
        headers = {},
        fetchImpl = globalThis.fetch,
    } = {}
) {
    if (typeof derive !== 'function')
        throw new HttpError('getDerived needs a derive(json) function');
    const t = withTimeout(timeoutMs);
    let status = null;
    let h = {};
    try {
        const res = await fetchImpl(url, {
            method: 'GET',
            headers,
            redirect: 'follow',
            signal: t.signal,
        });
        status = res.status;
        h = headerMap(res.headers);
        let derived = null;
        let bytes = null;
        // false when the body did not parse as JSON (a captive portal's
        // HTML, an error page): derive() then sees null, and the caller
        // can tell "not JSON" from a JSON null.
        let bodyJson = true;
        {
            const text = await res.text();
            bytes = Buffer.byteLength(text, 'utf8');
            let parsed = null;
            try {
                parsed = JSON.parse(text);
            } catch {
                parsed = null;
                bodyJson = false;
            }
            derived = derive(parsed);
        }
        return {
            status,
            ok: status >= 200 && status < 300,
            contentLength: contentLengthOf(h) ?? bytes,
            derived,
            bodyJson,
            neverBody: true,
        };
    } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(
            `GET ${url}: ${e.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : e.message}`,
            { url, status }
        );
    } finally {
        t.clear();
    }
}

export const neverBody = true;
