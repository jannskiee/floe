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

/**
 * Reports whether the selected ICE candidate pair from getStats() runs through
 * a TURN relay, i.e. either side's candidate is a relay candidate. Anything
 * else (host or reflexive on both ends) is a direct peer-to-peer path.
 */
export function isRelayPair(localType?: string, remoteType?: string): boolean {
    return localType === 'relay' || remoteType === 'relay';
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

/** probeIsRelay decides whether a live connection is running through the TURN
 *  relay, from an RTCStatsReport.
 *
 *  It takes the STATS, not the peer connection, so the getStats() call and the
 *  `(peer as any)._pc` cast stay at the call site and this stays testable under
 *  client/vitest.config.ts, which has no DOM.
 *
 *  The verdict LATCHES: one nominated succeeded pair that is relay makes the
 *  answer relay, whatever the other pairs say. WebRTC normally nominates a
 *  single pair, but more than one can be nominated during an ICE restart or
 *  across m-lines, and the two readings this replaces disagreed in exactly that
 *  case. Latching is the conservative direction, because the reading gates the
 *  2 GB relay cap: calling a relayed connection direct would let an oversized
 *  transfer start on the relay, while the reverse only shows a cap that does
 *  not bind. */
export function probeIsRelay(stats: RTCStatsReport): boolean {
    return scanPairs(stats).relay;
}

/** readConnectionType is the badge's reading of the same scan, and it is a
 *  different question from probeIsRelay's: it must be able to answer "I do not
 *  know yet".
 *
 *  The badge polls from the moment the peer connects, so it runs before ICE has
 *  nominated anything. probeIsRelay answers false there, which is right for the
 *  gate (no evidence of a relay, so do not block) and wrong for the badge,
 *  which would flash "Direct" on a connection that turns out to be relayed.
 *  null means not yet decided, and the badge renders nothing. */
export function readConnectionType(stats: RTCStatsReport): 'direct' | 'relay' | null {
    const { nominated, relay } = scanPairs(stats);
    if (!nominated) return null;
    return relay ? 'relay' : 'direct';
}

/** One scan, two questions. `nominated` is whether ICE has settled on anything
 *  at all; `relay` LATCHES across every nominated succeeded pair. */
function scanPairs(stats: RTCStatsReport): { nominated: boolean; relay: boolean } {
    let nominated = false;
    let relay = false;
    stats.forEach((report) => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
            nominated = true;
            const local = stats.get(report.localCandidateId);
            const remote = stats.get(report.remoteCandidateId);
            if (isRelayPair(local?.candidateType, remote?.candidateType)) {
                relay = true;
            }
        }
    });
    return { nominated, relay };
}
