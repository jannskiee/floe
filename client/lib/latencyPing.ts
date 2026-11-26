import type { Socket } from 'socket.io-client';

/**
 * One tick of the sending card's latency readout: a 'ping' that the signaling
 * server answers at once, timed from its own emit.
 *
 * Nothing while the socket is not connected. socket.io-client keeps an emit
 * made then and sends the whole buffer as it connects again, so the pings of
 * an outage went out together, and each answer timed how long its ping had
 * waited: after 120 s offline the readout read 34060ms until the next ping.
 */
export function sendLatencyPing(
    socket: Pick<Socket, 'connected' | 'emit'>,
    onRoundTrip: (ms: number) => void,
    now: () => number = () => performance.now()
): void {
    if (!socket.connected) return;
    const start = now();
    socket.emit('ping', () => onRoundTrip(Number((now() - start).toFixed(2))));
}
