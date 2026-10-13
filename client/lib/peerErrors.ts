// Pure classification of WebRTC peer errors, shared by the sender and receiver
// error handlers in P2PTransfer. Kept side-effect free so the branchy
// "expected vs unexpected" decision and the analytics reason mapping (which the
// e2e suite cannot reliably trigger) can be unit-tested directly. The caller
// owns every side effect (Sentry, setError, track, setStatus).
//
// One rule holds for everything here: the MESSAGE of a peer error is read to
// classify it and goes nowhere else. simple-peer hands over the browser's own
// exception, and the browser quotes what the other peer sent inside it: the
// SDP line it could not parse ("Failed to parse SessionDescription. <line>
// ..."), the reason a data channel abort carried. The page used to draw that
// text after "Connection error:" and send it to Sentry as an exception, so
// whoever held the link could put a sentence in Floe's own banner
// (e2e/peer-error-text.spec.ts reproduces it). What leaves this module is a
// fixed sentence and a code from simple-peer's own list.

export type PeerErrorReason =
    | 'relay-disabled'
    | 'abort'
    | 'ice-failed'
    | 'conn-failed'
    | 'unknown';

/**
 * Decide whether a peer error is an expected outcome (logged as a breadcrumb,
 * never sent to Sentry) versus a real bug to capture, and map it to the reason
 * label reported to analytics.
 *
 * `relayEnabled` is a sender-only concern: when the sender forced relay off, any
 * connection failure is expected and attributed to `relay-disabled`. The receiver
 * has no relay toggle, so it omits the option and the default (`true`) neutralizes
 * that term, matching the receiver's original behavior.
 *
 * `code` is the error's own code (peerErrorCodeOf). With it, the three expected
 * kinds are told apart by the code simple-peer set, and the message only
 * confirms an abort on a data channel error. Without it the message alone
 * decided, and a peer can put the words "User-Initiated Abort" in an SDP line
 * that does not parse: its parse error then read as a peer that left, showed
 * the abort sentence, sent Sentry nothing and counted as `abort`. Both
 * handlers pass the code; the message-only form stays for callers that have
 * none.
 */
export function classifyPeerError(
    message: string | undefined,
    { relayEnabled = true, code }: { relayEnabled?: boolean; code?: string } = {}
): { isExpected: boolean; reason: PeerErrorReason } {
    const isAbort = isPeerAbort(message, code);
    const isIceFailed = code === undefined ? message === 'Ice connection failed.' : code === 'ERR_ICE_CONNECTION_FAILURE';
    const isConnFailed = code === undefined ? message === 'Connection failed.' : code === 'ERR_CONNECTION_FAILURE';

    const isExpected = !relayEnabled || isIceFailed || isConnFailed || isAbort;

    const reason: PeerErrorReason = !relayEnabled
        ? 'relay-disabled'
        : isAbort
            ? 'abort'
            : isIceFailed
                ? 'ice-failed'
                : isConnFailed
                    ? 'conn-failed'
                    : 'unknown';

    return { isExpected, reason };
}

/**
 * Every code simple-peer 9 puts on an error it raises (`err.code`, set by
 * err-code with Object.defineProperty, so it shadows a DOMException's own
 * numeric code). peerErrors.test.ts reads the installed library and fails
 * when this list and its source disagree.
 */
export const PEER_ERROR_CODES: ReadonlySet<string> = new Set([
    'ERR_ADD_ICE_CANDIDATE',
    'ERR_ADD_TRANSCEIVER',
    'ERR_CONNECTION_FAILURE',
    'ERR_CREATE_ANSWER',
    'ERR_CREATE_OFFER',
    'ERR_DATA_CHANNEL',
    'ERR_DESTROYED',
    'ERR_ICE_CONNECTION_CLOSED',
    'ERR_ICE_CONNECTION_FAILURE',
    'ERR_PC_CONSTRUCTOR',
    'ERR_PC_PEER_IDENTITY',
    'ERR_REMOVE_TRACK',
    'ERR_SENDER_ALREADY_ADDED',
    'ERR_SENDER_REMOVED',
    'ERR_SET_LOCAL_DESCRIPTION',
    'ERR_SET_REMOTE_DESCRIPTION',
    'ERR_SIGNALING',
    'ERR_TRACK_NOT_ADDED',
    'ERR_UNSUPPORTED_REPLACETRACK',
    'ERR_WEBRTC_SUPPORT',
]);

/**
 * The code of a peer error when it is one of simple-peer's own, otherwise
 * 'unknown'. An allowlist, the same idiom as refusalCodeOf in
 * lib/transfer/protocol.ts: the value is read off an object the peer's bytes
 * helped build, so anything that is not a listed string is dropped.
 */
export function peerErrorCodeOf(err: unknown): string {
    const code = (err as { code?: unknown } | null | undefined)?.code;
    return typeof code === 'string' && PEER_ERROR_CODES.has(code) ? code : 'unknown';
}

/**
 * What the page shows for a peer error it has no closer wording for. The
 * connection failed before any file moved, so each sentence says what that
 * side can do next. Never the error's own text.
 */
export const RECEIVER_PEER_ERROR =
    'Connection failed. Reload the page to try again. If it fails again, ask the sender for a new link.';
export const SENDER_PEER_ERROR =
    'Connection failed. Ask the other device to open the link again. If it fails again, reload the page, add the files again, and share the new link.';

export function peerErrorBanner(role: 'receiver' | 'sender'): string {
    return role === 'receiver' ? RECEIVER_PEER_ERROR : SENDER_PEER_ERROR;
}

/**
 * What Sentry is told about such an error: the code and the role, as a
 * message, a fingerprint (one issue per role and code) and two tags. The
 * error object itself is never captured: its message is the text above.
 */
export function peerErrorReport(
    role: 'receiver' | 'sender',
    err: unknown
): {
    code: string;
    message: string;
    fingerprint: string[];
    tags: { peerErrorRole: string; peerErrorCode: string };
} {
    const code = peerErrorCodeOf(err);
    return {
        code,
        message: `Unexpected peer error: ${code}`,
        fingerprint: ['peer-error', role, code],
        tags: { peerErrorRole: role, peerErrorCode: code },
    };
}

/**
 * Whether the sender's banner for an expected early error names the relay
 * setting.
 *
 * Only with the box unchecked, and not for an abort. The analytics label above
 * calls every such error 'relay-disabled', which is a fair bucket for a count,
 * but the banner tells a person what to do: its relay sentence says to reload
 * and make a new link, and a recipient who closed their tab during the
 * handshake can simply open the same link again.
 */
export function senderErrorBlamesRelay(message: string | undefined, relayEnabled: boolean, code?: string): boolean {
    return !relayEnabled && !isPeerAbort(message, code);
}

/** The other end closed its side: a data channel error whose text says so.
 *  With no code to go by (an older caller), the text alone. */
function isPeerAbort(message: string | undefined, code?: string): boolean {
    const says = message?.includes('User-Initiated Abort') ?? false;
    return code === undefined ? says : says && code === 'ERR_DATA_CHANNEL';
}
