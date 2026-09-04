import { useState, useRef } from 'react';
import type { Instance as PeerInstance } from 'simple-peer';
import { readConnectionType } from '@/lib/relay';

/**
 * Detects and tracks whether the active WebRTC connection is direct or routed
 * through a TURN relay, by polling the peer's ICE candidate-pair stats every 5s.
 * Pure connection-quality detection: it only drives the "Direct/Relay" badge and
 * has no effect on the transfer itself.
 *
 * The reading comes from lib/relay.ts, which is also what the relay-size gate
 * in P2PTransfer uses. It used to be a second, subtly different copy of the
 * same scan: this one wrote a verdict per nominated pair, so the LAST pair the
 * stats iterator yielded won, while the gate latched on any relay pair. With
 * more than one nominated pair (an ICE restart, or several m-lines) the badge
 * could read Direct on a connection the gate was blocking as relay.
 */
export function useConnectionType() {
    const [connectionType, setConnectionType] = useState<'direct' | 'relay' | null>(null);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const checkConnectionType = async (peer: PeerInstance) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pc = (peer as any)._pc as RTCPeerConnection | undefined;
        if (!pc) return;
        try {
            // null means ICE has not nominated a pair yet. Leave the badge as
            // it was rather than guessing: the poll starts the moment the peer
            // connects, so this is the normal state for the first tick or two.
            const next = readConnectionType(await pc.getStats());
            if (next) setConnectionType(next);
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
