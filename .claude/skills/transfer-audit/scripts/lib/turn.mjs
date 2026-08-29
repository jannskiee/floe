// Shape probe for GET /api/turn-credentials. The response carries live TURN
// credentials (server/server.js serves Cloudflare-minted or coturn HMAC
// pairs), so the body is parsed in memory by http.getDerived and only the
// scheme summary leaves this module: { entries, schemes, servesTurn,
// contentLength }. Nothing here logs, stores or returns urls, username or
// credential; turn.test.mjs proves that with a fake body.
import { getDerived } from './http.mjs';

// The STUN-only fallback body (two Google STUN entries) is 82 bytes as
// JSON.stringify writes it and was measured at 84 on the wire on 2026-08-16
// (journal [17]); either length with a stun-only scheme list is the second
// signal beside the scheme parse when the local stack runs without
// Cloudflare keys.
export const STUN_FALLBACK_BYTES = 84;
export const STUN_FALLBACK_BYTES_MIN = 82;
export const TURN_PATH = '/api/turn-credentials';

/** Pure: parsed body -> { entries, schemes, servesTurn }. */
export function classifyIce(body) {
    const list = Array.isArray(body)
        ? body
        : body && Array.isArray(body.iceServers)
          ? body.iceServers
          : [];
    const urls = list
        .flatMap((e) => (Array.isArray(e?.urls) ? e.urls : [e?.urls]))
        .filter((u) => typeof u === 'string');
    const schemes = [
        ...new Set(urls.map((u) => u.split(':')[0].toLowerCase())),
    ].sort();
    return {
        entries: list.length,
        schemes,
        servesTurn: urls.some((u) => /^turns?:/i.test(u)),
    };
}

/**
 * probeTurn(baseUrl, { timeoutMs, ledger, fetchImpl }) ->
 *   { server, status, contentLength, entries, schemes, servesTurn,
 *     stunFallbackShape, at }
 * On production pass the ledger: the probe costs one TURN fetch of the
 * 20 per minute cap, so it is paced like any other request.
 */
export async function probeTurn(
    baseUrl,
    { timeoutMs = 10_000, ledger = null, fetchImpl, sleep } = {}
) {
    const server = String(baseUrl).replace(/\/+$/, '');
    if (ledger) {
        await ledger.waitFor('probe:turn', { sleep });
        ledger.spend('probe:turn');
    }
    const res = await getDerived(server + TURN_PATH, classifyIce, {
        timeoutMs,
        fetchImpl,
    });
    const shape = res.derived || { entries: 0, schemes: [], servesTurn: false };
    // A 200 whose body is not JSON (a captive portal, an error page) has
    // proved nothing about TURN: servesTurn stays null, and bodyJson false
    // says why, so the report never reads it as "no turn scheme served".
    const bodyJson = res.bodyJson !== false;
    return {
        server,
        status: res.status,
        contentLength: res.contentLength,
        entries: shape.entries,
        schemes: shape.schemes,
        bodyJson,
        servesTurn: res.status === 200 && bodyJson ? shape.servesTurn : null,
        stunFallbackShape:
            !shape.servesTurn &&
            shape.schemes.length === 1 &&
            shape.schemes[0] === 'stun' &&
            res.contentLength !== null &&
            res.contentLength >= STUN_FALLBACK_BYTES_MIN &&
            res.contentLength <= STUN_FALLBACK_BYTES,
        rateLimited: res.status === 429,
        at: new Date().toISOString(),
    };
}

export function describeTurn(p) {
    if (!p) return 'not probed';
    if (p.status !== 200) return `HTTP ${p.status}`;
    if (p.bodyJson === false) return 'HTTP 200, body-not-json';
    return `${p.entries} entries, schemes ${p.schemes.join(',') || 'none'}`;
}
