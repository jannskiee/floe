import { useState, useRef, useEffect, useCallback } from 'react';
import io, { Socket } from 'socket.io-client';
import { getSocketUrl } from '@/lib/runtimeConfig';

// Module-level singleton, created lazily during the first client render. Waiting
// until render gives the beforeInteractive runtime-config script time to load
// before a published image chooses its signaling URL.
let sharedSocket: Socket | undefined;

function getSocket(): Socket {
    sharedSocket ??= io(getSocketUrl(), {
        reconnectionDelay: 500,
        reconnectionDelayMax: 3000,
    });
    return sharedSocket;
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
    const socket = getSocket();
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
        if (socket.connected) queueMicrotask(() => setIsConnected(true));

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
        // `reconnect` is a Manager-level event — note the `.io` namespace.
        socket.io.on('reconnect', () => cbRef.current.onReconnect());

        const pingInterval = setInterval(() => {
            const start = performance.now();
            socket.emit('ping', () => {
                const duration = performance.now() - start;
                setPing(Number(duration.toFixed(2)));
            });
        }, 2000);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        socket.on('signal', (data: any) => cbRef.current.onSignal(data));
        socket.on('peer-disconnected', () => cbRef.current.onPeerDisconnected());

        return () => {
            clearInterval(pingInterval);
            socket.off('signal');
            socket.off('user-connected');
            socket.off('connect');
            socket.off('disconnect');
            socket.off('room-full');
            socket.off('peer-disconnected');
            socket.off('connect_error');
            socket.io.off('reconnect');
        };
    }, [socket]);

    const joinRoom = useCallback((roomId: string) => {
        socket.emit('join-room', roomId);
    }, [socket]);

    const sendSignal = useCallback((payload: SignalPayload) => {
        socket.emit('signal', payload);
    }, [socket]);

    // Dynamic, per-action registrations (sender on create-link, receiver on join).
    // The handler closes over current state, so it is replaced (off then on) each
    // time rather than memoized.
    const onUserConnected = useCallback((handler: (userId: string) => void) => {
        socket.off('user-connected');
        socket.on('user-connected', handler);
    }, [socket]);

    const onRoomFull = useCallback((handler: () => void) => {
        socket.off('room-full');
        socket.on('room-full', handler);
    }, [socket]);

    return {
        isConnected,
        setIsConnected,
        ping,
        joinRoom,
        sendSignal,
        onUserConnected,
        onRoomFull,
    };
}
