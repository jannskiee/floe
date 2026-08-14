import { useRef, useState } from 'react';
import type { Instance as PeerInstance } from 'simple-peer';
import { verifyCodeFromDescriptions } from '@/lib/transfer/verify';

/**
 * useVerifyCode derives the connection verification code (the safety-number
 * style "NNNN NNNN" from lib/transfer/verify) once a peer connects.
 *
 * Call compute(peer) from the peer's 'connect' handler: both SDP descriptions
 * are guaranteed set by then (DTLS cannot complete without them), so no
 * polling is needed. The code intentionally survives peer close and transfer
 * completion so a fast transfer can still be compared; reset() is for when a
 * NEW connection replaces the old one and the stale code must not linger.
 * Do not gate the display on connection state, and do not reset on
 * peer.on('close'): the post-completion persistence is relied on by the e2e
 * suite and mirrors the desktop app's behavior.
 */
export function useVerifyCode() {
    const [code, setCode] = useState<string | null>(null);
    // Monotonic attempt id: a late digest from a replaced peer must not
    // overwrite the current connection's code.
    const attemptRef = useRef(0);

    const compute = (peer: PeerInstance) => {
        const attempt = ++attemptRef.current;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pc = (peer as any)._pc as RTCPeerConnection | undefined;
        verifyCodeFromDescriptions(pc?.localDescription?.sdp, pc?.remoteDescription?.sdp)
            .then((c) => {
                if (c && attemptRef.current === attempt) setCode(c);
            });
    };

    const reset = () => {
        attemptRef.current++;
        setCode(null);
    };

    return { verifyCode: code, compute, reset };
}
