// The failure signatures: the table that turns a leg's evidence into a triage key, and the sets
// the runner reads from it. Moved verbatim from cell.mjs; it imports nothing.

// [key, regex, retryable ('rel' = only on relay cells with a TURN-heavy
// window or a STUN-only warning), triage heading]. First hit wins.
export const SIGNATURES = Object.freeze([
    [
        'early-race',
        /connected, but no data arrived from the sender within|Connected, but the sender never started sending|receiver left or declined before the transfer started|no-data-after-connect/i,
        false,
        'connect-then-nothing',
    ],
    ['hash-mismatch', /hash-mismatch/, false, 'hash-mismatch'],
    ['incomplete-file', /incomplete file "/, false, 'incomplete-file'],
    ['route-mismatch', /route-mismatch/, false, 'route-mismatch'],
    ['route-disagree', /route-disagree/, false, 'route-disagree'],
    ['forcer-ineffective', /forcer-ineffective/, false, 'forcer-ineffective'],
    ['stats-attempt', /stats-attempt/, false, 'stats-attempt'],
    // A request link cell's own failures (lib/request.mjs): a flow step the
    // host or the visitor did not reach, and a drop that did not land as
    // exactly the manifest inside its subfolder. Never retried: a retry
    // that passes would make a lane or visitor defect read as luck.
    ['request-flow', /request-flow/, false, 'request-flow'],
    ['request-manifest', /request-manifest/, false, 'request-manifest'],
    // The request runner's own harness ERRORs (keyed, so the report can name
    // a triage row): TA-13's host not behind the blip proxy, a host lane
    // that already holds a live link this run did not leave behind, and a
    // release that did not leave the host as the cell found it.
    ['blip-url', /blip-url/, false, 'blip-url'],
    ['host-busy', /host-busy/, false, 'host-busy'],
    ['host-release', /host-release/, false, 'host-release'],
    // A .part left behind by a receiver that exited clean is a product
    // defect (the staged write was never committed or abandoned), never a
    // harness fault.
    ['stale-part', /stale-part|stale \.part file/, false, 'stale-part'],
    // A CLI or desktop sender whose POST /api/code failed prints only the
    // Link row (send.go runSend: "Warning: could not generate short code"); the
    // cause is the code limiter, so the retry is allowed and paced.
    [
        'code-registration-failed',
        /code-registration-failed|could not generate short code/i,
        true,
        'rate-limit',
    ],
    [
        'relay-cap',
        /relay connections are capped at 2 GB|Relay limit exceeded/,
        false,
        'relay-cap',
    ],
    [
        'uia-setvalue',
        /Please enter a code or link\.|uia-setvalue|desktop-receiver-undrivable/i,
        false,
        'uia-setvalue',
    ],
    // Only the texts a real 429 produces: the server bodies, the CLI's
    // code client ("server returned 429 when registering|resolving code")
    // and an HTTP status line. A bare 429 also appears in byte counts
    // ("429 of 12582912 bytes") and speeds ("429.3 KB/s"), so it is never
    // matched on its own.
    [
        'rate-limited',
        /Too many refreshes|Rate limit exceeded|Too many requests|Too many reports|server returned 429\b|HTTP 429\b/i,
        true,
        'rate-limit',
    ],
    // The browser leg records the status of every TURN credential answer.
    // A refused fetch on a relay-forced page leaves it with no candidates at
    // all, so its peer's connect timeout is the limiter's, not the network's.
    // 429 is the per-IP limiter (drain the window and retry); 5xx is the
    // server or the Cloudflare mint failing, which is infra, exactly as the
    // same answer seen by a CLI leg (ice-fetch-failed) already is.
    [
        'turn-fetch-rejected',
        /turn-fetch-status 429\b/,
        true,
        'turn-fetch-rejected',
    ],
    // Any other status the hint can carry: a 5xx from the server or the
    // Cloudflare mint, a 4xx, or the 0 the adapter records for a fetch that
    // never got headers. The 429 row sits above and wins; 200 and 304 never
    // reach the classifier.
    ['turn-fetch-failed', /turn-fetch-status \d+\b/, true, 'infra-down'],
    // The one designed FAIL of the relay-cap cell: bytes crossed the relay
    // before the gate, or the sender ended some other way.
    ['cap-not-enforced', /cap-not-enforced/, false, 'cap-not-enforced'],
    ['turn-degraded', /Using STUN only/, 'rel', 'turn-degraded'],
    [
        'ice-fetch-failed',
        /failed to fetch ICE credentials/i,
        true,
        'infra-down',
    ],
    [
        'signaling-unreachable',
        /could not reach signaling server|failed to connect to signaling server|Could not reach the server/i,
        true,
        'infra-down',
    ],
    [
        'room-full',
        /room is full|Link Invalid|expected sender role/i,
        true,
        'room-full',
    ],
    [
        'goto-timeout',
        /page\.goto|navigation timeout|goto-timeout/i,
        true,
        'stale-bundle',
    ],
    [
        'stale-bundle-reload',
        /stale-bundle-reload|ChunkLoadError|module factory is not available/i,
        true,
        'stale-bundle',
    ],
    // The product's own connect timeouts, plus the harness's: on a DIR
    // cell the connect budget (45 s) runs out before the CLI's own error
    // (signalWaitTimeout 30 s + connectTimeout 30 s) can land, so the
    // waitLine, waitForFunction and phase-timeout texts are the signature.
    [
        'connect-timeout',
        /timed out establishing a connection|timed out waiting for the peer|A connection could not be established|Connection failed|no line matching \/\^ \{2\}Connected|no PC reached connected in|phase timeout: connect exceeded/i,
        'rel',
        'connect-timeout',
    ],
    [
        'code-expired',
        /not found or expired|was not recognized/i,
        false,
        'code-expired',
    ],
    ['code-spent', /no longer active/i, false, 'code-spent'],
    [
        'peer-refused',
        /connection closed before any file arrived/i,
        false,
        'peer-refused',
    ],
    ['ack-timeout', /timed out waiting for ack/i, false, 'ack-timeout'],
    [
        'stall',
        /transfer stalled: no data for|backpressure stall|connection closed mid-transfer/i,
        false,
        'stall',
    ],
    ['incompatible', /Cannot transfer: /, false, 'incompatible'],
    ['wsl-host-ip', /wsl: no default route IP/, false, 'wsl-host-ip'],
    ['phase-timeout', /phase timeout/i, false, 'phase-timeout'],
]);

/**
 * Every key that has a row in references/triage.md. The report prints its
 * "no row" disclaimer from this set, so a key with a row never carries the
 * disclaimer and a key without one always does. triage.test.mjs asserts
 * this set and the table's first column are the same.
 */
export const TRIAGE_KEYS = new Set([
    'connect-then-nothing',
    'room-full',
    'code-expired',
    'code-spent',
    'turn-degraded',
    'turn-fetch-rejected',
    'turn-fetch-failed',
    'cap-not-enforced',
    'connect-timeout',
    'relay-cap',
    'phase-timeout',
    'stale-bundle',
    'stats-attempt',
    'rate-limit',
    'uia-setvalue',
    'infra-down',
    'stall',
    'incomplete-file',
    'hash-mismatch',
    'incompatible',
    'route-disagree',
    'route-mismatch',
    'forcer-ineffective',
    'peer-refused',
    'ack-timeout',
    'stale-part',
    'kill-receiver-part',
    'kill-failed',
    'kill-sender-outcome',
    'kill-sender-cleanup',
    'stats-delta',
    'hash-not-refused',
    'hash-refusal-code',
    'wsl-host-ip',
    'request-flow',
    'request-manifest',
    'blip-url',
    'host-busy',
    'host-release',
]);

export const INFRA_KEYS = new Set([
    'ice-fetch-failed',
    'signaling-unreachable',
    'turn-fetch-failed',
]);

/**
 * Signature keys whose retry drains a full limiter window and counts a
 * ledger symptom. lib/pacing.mjs makes two CONSECUTIVE symptoms infraDown(),
 * so audit.mjs clears them after any cell that ended for another reason.
 */
export const PENALIZED_KEYS = new Set([
    'rate-limited',
    'code-registration-failed',
    'turn-degraded',
    'turn-fetch-rejected',
    'connect-timeout',
]);

/** classifySignature(text, { relay, turnHeavy }) -> { key, retryable, triage, text } */
export function classifySignature(
    text,
    { relay = false, turnHeavy = false } = {}
) {
    const s = String(text || '');
    for (const [key, re, retry, triage] of SIGNATURES) {
        if (re.test(s)) {
            const retryable =
                retry === 'rel' ? relay && turnHeavy : Boolean(retry);
            return { key, retryable, triage, text: firstLine(s) };
        }
    }
    return {
        key: 'unknown',
        retryable: false,
        triage: null,
        text: firstLine(s),
    };
}

export function isEarlyRace(text) {
    return classifySignature(text).key === 'early-race';
}

const firstLine = (s) =>
    String(s || '')
        .split(/\r?\n/)
        .find((l) => l.trim()) || '';
