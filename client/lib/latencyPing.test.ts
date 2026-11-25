import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { sendLatencyPing } from './latencyPing';

// The readout beside the Wifi icon on the sending card is the round trip of a
// 'ping' the page sends every 2 s (hooks/useSignaling.ts). socket.io-client
// keeps an emit made while the socket is not connected and sends the whole
// buffer as it connects again. Each answer was timed from its own emit, so
// after an outage the readout showed how long the page had waited, and the
// page sent one saved ping for every 2 s offline, all at once.

// Never connects: autoConnect is off, and nothing listens on port 9.
const offlineSocket = () => io('http://127.0.0.1:9', { autoConnect: false, forceNew: true });

describe('a socket that is not connected', () => {
    // The library behavior the skip exists for.
    it('keeps an emit made meanwhile in its send buffer', () => {
        const socket = offlineSocket();
        try {
            socket.emit('ping', () => {});
            expect(socket.connected).toBe(false);
            expect(socket.sendBuffer).toHaveLength(1);
        } finally {
            socket.close();
        }
    });
});

describe('sendLatencyPing', () => {
    it('sends nothing while the socket is not connected', () => {
        const socket = offlineSocket();
        const onRoundTrip = vi.fn();
        try {
            for (let i = 0; i < 5; i++) sendLatencyPing(socket, onRoundTrip);
            expect(socket.sendBuffer).toHaveLength(0);
            expect(onRoundTrip).not.toHaveBeenCalled();
        } finally {
            socket.close();
        }
    });

    // A socket the manager is reconnecting is active, and not connected. A
    // volatile emit still waits in the buffer whenever a new connection is
    // open and its namespace has not answered yet.
    it('waits for the connection itself, not for a socket that is trying to connect', () => {
        const socket = { connected: false, active: true, emit: vi.fn(), volatile: { emit: vi.fn() } };
        sendLatencyPing(socket, vi.fn());
        expect(socket.emit).not.toHaveBeenCalled();
        expect(socket.volatile.emit).not.toHaveBeenCalled();
    });

    it('sends one ping while connected, and hands back the time since it was sent', () => {
        const socket = { connected: true, emit: vi.fn() };
        const onRoundTrip = vi.fn();
        const now = vi.fn().mockReturnValueOnce(1000).mockReturnValueOnce(1012.3456);
        sendLatencyPing(socket, onRoundTrip, now);
        expect(socket.emit).toHaveBeenCalledTimes(1);
        expect(socket.emit).toHaveBeenCalledWith('ping', expect.any(Function));
        expect(onRoundTrip).not.toHaveBeenCalled();
        const answer = socket.emit.mock.calls[0][1] as () => void;
        answer();
        expect(onRoundTrip).toHaveBeenCalledTimes(1);
        expect(onRoundTrip).toHaveBeenCalledWith(12.35);
    });
});

// The hook cannot be mounted here (vitest runs in node, with no DOM), so its
// wiring is read as text, as refusalBanner.test.ts reads P2PTransfer.tsx.
describe('how useSignaling sends its ping', () => {
    const hook = readFileSync(fileURLToPath(new URL('../hooks/useSignaling.ts', import.meta.url)), 'utf8');

    it('sends it every 2 s through sendLatencyPing, and from nowhere else', () => {
        expect(hook).toContain("import { sendLatencyPing } from '@/lib/latencyPing';");
        expect(hook).toContain('pingInterval = setInterval(() => sendLatencyPing(socket, setPing), 2000);');
        expect(hook).not.toMatch(/emit\(\s*['"]ping['"]/);
    });

    // The buffer also holds what the page sends while it reconnects, such as
    // the join that onReconnect makes before the namespace has answered.
    it('leaves the socket send buffer alone', () => {
        expect(hook).not.toContain('sendBuffer');
    });
});
