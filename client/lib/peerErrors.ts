// Pure classification of WebRTC peer errors, shared by the sender and receiver
// error handlers in P2PTransfer. Kept side-effect free so the branchy
// "expected vs unexpected" decision and the analytics reason mapping (which the
// e2e suite cannot reliably trigger) can be unit-tested directly. The caller
// owns every side effect (Sentry, setError, track, setStatus).

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
 */
export function classifyPeerError(
    message: string | undefined,
    { relayEnabled = true }: { relayEnabled?: boolean } = {}
): { isExpected: boolean; reason: PeerErrorReason } {
    const isAbort = message?.includes('User-Initiated Abort') ?? false;
    const isIceFailed = message === 'Ice connection failed.';
    const isConnFailed = message === 'Connection failed.';

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
