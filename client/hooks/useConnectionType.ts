import { useState, useRef } from 'react';
import type { Instance as PeerInstance } from 'simple-peer';
import { isRelayPair } from '@/lib/relay';

/**
 * Detects and tracks whether the active WebRTC connection is direct or routed
 * through a TURN relay, by polling the peer's ICE candidate-pair stats every 5s.
 * Pure connection-quality detection: it only drives the "Direct/Relay" badge and
 * has no effect on the transfer itself.
 */
export function useConnectionType() {
    const [connectionType, setConnectionType] = useState<'direct' | 'relay' | null>(null);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const checkConnectionType = async (peer: PeerInstance) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pc = (peer as any)._pc as RTCPeerConnection | undefined;
        if (!pc) return;
        try {
            const stats = await pc.getStats();
            stats.forEach((report) => {
                if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
                    const localCandidate = stats.get(report.localCandidateId);
                    const remoteCandidate = stats.get(report.remoteCandidateId);
                    const isRelay = isRelayPair(
                        localCandidate?.candidateType,
                        remoteCandidate?.candidateType
                    );
                    setConnectionType(isRelay ? 'relay' : 'direct');
                }
            });
        } catch { }
    };

    // Check immediately, then re-check every 5s (replacing any prior interval).
    const startPolling = (peer: PeerInstance) => {
        checkConnectionType(peer);
        if (intervalRef.current) clearInterval(intervalRef.current);
        intervalRef.current = setInterval(() => checkConnectionType(peer), 5000);
    };

    const stopPolling = () => {
        if (intervalRef.current) clearInterval(intervalRef.current);
    };

    const reset = () => setConnectionType(null);

    return { connectionType, startPolling, stopPolling, reset };
}
