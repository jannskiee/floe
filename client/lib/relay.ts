// Pure relay-policy helpers, shared by the sender flow in P2PTransfer and the
// useRelayConfiguration hook. Kept side-effect free so the relay gate (which the
// e2e suite does not exercise) can be unit-tested directly.

export const RELAY_SIZE_LIMIT = 2 * 1024 * 1024 * 1024; // 2 GB

/**
 * The ICE server list to hand SimplePeer. When the user keeps relay fallback on
 * (the default), every server is offered. When they turn it off, TURN servers
 * are stripped so the connection can only succeed as a direct path; STUN is kept.
 */
export function filterIceServers(
    servers: RTCIceServer[],
    relayEnabled: boolean
): RTCIceServer[] {
    if (relayEnabled) return servers;
    return servers.filter((s) => {
        const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
        return !urls.some((u) => u.startsWith('turn:') || u.startsWith('turns:'));
    });
}

export interface CandidatePairClass {
    isRelay: boolean;
    scope: 'same-network' | 'internet';
}

/**
 * Classifies the selected ICE candidate pair from getStats(). Relay means
 * either side connects through a TURN server. For non-relay pairs, host↔host
 * means both devices reached each other without NAT traversal (same network);
 * anything involving a reflexive candidate is a hole-punched path across the
 * internet. Informational only — a VPN can make distinct networks look local.
 */
export function classifyCandidatePair(
    localType?: string,
    remoteType?: string
): CandidatePairClass {
    const isRelay = localType === 'relay' || remoteType === 'relay';
    const scope =
        localType === 'host' && remoteType === 'host' ? 'same-network' : 'internet';
    return { isRelay, scope };
}

export type RelayGateVerdict =
    | { action: 'proceed' }
    | { action: 'block-relay-disabled' }
    | { action: 'block-over-limit'; totalSize: number };

/**
 * Once the sender's connection resolves, decide whether the transfer may start.
 * A relayed connection is blocked when the user disabled relay fallback, or when
 * the payload exceeds the relay size cap. Direct connections always proceed.
 * Pure: the caller owns every side effect (status, error, Sentry, peer.destroy).
 */
export function evaluateRelayGate(opts: {
    isRelay: boolean;
    relayEnabled: boolean;
    totalSize: number;
}): RelayGateVerdict {
    const { isRelay, relayEnabled, totalSize } = opts;
    if (isRelay && !relayEnabled) return { action: 'block-relay-disabled' };
    if (isRelay && totalSize > RELAY_SIZE_LIMIT) {
        return { action: 'block-over-limit', totalSize };
    }
    return { action: 'proceed' };
}
