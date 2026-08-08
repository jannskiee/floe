import { useState, useRef, useEffect, useCallback } from 'react';
import io, { Socket } from 'socket.io-client';
import { resolveSocketUrl } from '@/lib/socketUrl';

// Module-level singleton, created lazily on first use rather than at import.
// Keep getSocket() the ONLY io() call in the app so the whole client shares one
// socket. P2PTransfer (the only importer) therefore holds no direct reference.
//
// Lazy because the server URL is now resolved at runtime, which is async. A happy
// side effect: importing this module no longer opens a socket during SSR and
// prerender, which the old top-level io() did on the build machine.
let socketPromise: Promise<Socket> | null = null;

function getSocket(): Promise<Socket> {
    // Server-side: never connect, and never reject. Nothing awaits this on the
    // server, so an inert promise is the quietest possible no-op.
    if (typeof window === 'undefined') return new Promise<Socket>(() => {});

    if (!socketPromise) {
        socketPromise = resolveSocketUrl().then((url) =>
            io(url, {
                reconnectionDelay: 500,
                reconnectionDelayMax: 3000,
            })
        );
    }
    return socketPromise;
}

export interface SignalPayload {
    target: string | null;
    roomId?: string;
    signal: unknown; // peer-agnostic; the component passes SimplePeer.SignalData
}

export interface UseSignalingCallbacks {
    // Inbound signal: the component validates against its peer and calls peer.signal().
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onSignal: (data: any) => void;
    // The remote peer left the room (transfer-aware status + peer teardown).
    onPeerDisconnected: () => void;
    // Socket dropped. isConnected/ping are already cleared; the component sets a
    // transfer-aware status.
    onDisconnect: () => void;
    // Socket connect failed (e.g. rate limit).
    onConnectError: (err: Error) => void;
    // Socket reconnected (the component clears the error banner).
    onReconnect: () => void;
}

/**
 * Owns the Socket.IO transport only: online status, round-trip ping, joining a
 * room, and relaying WebRTC signals. It is peer- and transfer-agnostic — every
 * event whose handling depends on peer/transfer state is delegated to a callback
 * supplied by the component. (Peer/WebRTC creation lives in the component until
 * the usePeerConnection extraction.)
 */
export function useSignaling(callbacks: UseSignalingCallbacks) {
    const [isConnected, setIsConnected] = useState(false);
    const [ping, setPing] = useState(0);

    // Listeners are registered once (deps []), but always invoke the component's
    // current callbacks via this latest-ref, so no handler can go stale. The ref
    // is updated in an effect (not during render) to satisfy react-hooks/refs;
    // socket events are async, so the ref is always current by the time they fire.
    const cbRef = useRef(callbacks);
    useEffect(() => {
        cbRef.current = callbacks;
    });

    useEffect(() => {
        // The socket now arrives asynchronously, so guard against the component
        // unmounting before it exists: otherwise we would attach listeners and
        // start an interval that nothing ever cleans up.
        let cancelled = false;
        let sock: Socket | null = null;
        let pingInterval: ReturnType<typeof setInterval> | null = null;

        getSocket().then((socket) => {
            if (cancelled) return;
            sock = socket;

            if (socket.connected) setIsConnected(true);

            socket.on('connect', () => setIsConnected(true));
            socket.on('disconnect', () => {
                setIsConnected(false);
                setPing(0);
                cbRef.current.onDisconnect();
            });
            socket.on('connect_error', (err) => {
                setIsConnected(false);
                cbRef.current.onConnectError(err);
            });
            // `reconnect` is a Manager-level event, note the `.io` namespace.
            socket.io.on('reconnect', () => cbRef.current.onReconnect());

            pingInterval = setInterval(() => {
                const start = performance.now();
                socket.emit('ping', () => {
                    const duration = performance.now() - start;
                    setPing(Number(duration.toFixed(2)));
                });
            }, 2000);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            socket.on('signal', (data: any) => cbRef.current.onSignal(data));
            socket.on('peer-disconnected', () => cbRef.current.onPeerDisconnected());
        });

        return () => {
            cancelled = true;
            if (pingInterval) clearInterval(pingInterval);
            if (!sock) return;
            sock.off('signal');
            sock.off('user-connected');
            sock.off('connect');
            sock.off('disconnect');
            sock.off('room-full');
            sock.off('room-joined');
            sock.off('peer-disconnected');
            sock.off('connect_error');
            sock.io.off('reconnect');
        };
    }, []);

    // Every emit and registration below chains off the SAME shared promise.
    // Promise reactions run in registration order, so call order is preserved as
    // emit order even while the socket is still being created. That matters
    // because several callers are synchronous and cannot await: SimplePeer
    // 'signal' handlers, and the register-then-join pairs in P2PTransfer.

    const joinRoom = useCallback((roomId: string) => {
        void getSocket().then((s) => s.emit('join-room', roomId));
    }, []);

    const sendSignal = useCallback((payload: SignalPayload) => {
        void getSocket().then((s) => s.emit('signal', payload));
    }, []);

    // Dynamic, per-action registrations (sender on create-link, receiver on join).
    // The handler closes over current state, so it is replaced (off then on) each
    // time rather than memoized.
    const onUserConnected = useCallback((handler: (userId: string) => void) => {
        void getSocket().then((s) => {
            s.off('user-connected');
            s.on('user-connected', handler);
        });
    }, []);

    const onRoomFull = useCallback((handler: () => void) => {
        void getSocket().then((s) => {
            s.off('room-full');
            s.on('room-full', handler);
        });
    }, []);

    // The server acks every join-room with room-joined { role }. The sender
    // gates its link render on this ack (see handleCreateLink): the room must
    // exist server-side before the link is shareable, or a fast receiver can
    // join first, be handed the sender role, and fail with "expected receiver
    // role, got sender".
    const onRoomJoined = useCallback((handler: (data: { role: string }) => void) => {
        void getSocket().then((s) => {
            s.off('room-joined');
            s.on('room-joined', handler);
        });
    }, []);

    return {
        isConnected,
        setIsConnected,
        ping,
        joinRoom,
        sendSignal,
        onUserConnected,
        onRoomFull,
        onRoomJoined,
    };
}
