import { describe, it, expect } from 'vitest';
import {
    CONTROL_MSG_MAX,
    HIGH_WATER,
    LOW_WATER,
    DEFAULT_CHUNK,
    MAX_CHUNK,
    chunkSize,
    classifyControl,
    metadataMessage,
    ackMessage,
    endMessage,
} from './protocol';

const enc = new TextEncoder();

function toUint8(s: string): Uint8Array {
    return enc.encode(s);
}

function toArrayBuffer(s: string): ArrayBuffer {
    return toUint8(s).buffer as ArrayBuffer;
}

describe('constants', () => {
    it('CONTROL_MSG_MAX is 1000', () => expect(CONTROL_MSG_MAX).toBe(1000));
    it('HIGH_WATER is 8 MB', () => expect(HIGH_WATER).toBe(8 * 1024 * 1024));
    it('LOW_WATER is 4 MB', () => expect(LOW_WATER).toBe(4 * 1024 * 1024));
});

describe('chunkSize', () => {
    it('returns DEFAULT_CHUNK when no sctp max', () => {
        expect(chunkSize()).toBe(DEFAULT_CHUNK);
        expect(chunkSize(undefined)).toBe(DEFAULT_CHUNK);
        expect(chunkSize(null)).toBe(DEFAULT_CHUNK);
        expect(chunkSize(0)).toBe(DEFAULT_CHUNK);
    });

    it('clamps to MAX_CHUNK when sctp max is huge', () => {
        expect(chunkSize(Infinity)).toBe(DEFAULT_CHUNK); // Infinity is not finite
        expect(chunkSize(1_000_000)).toBe(MAX_CHUNK);
    });

    it('uses sctp max when within bounds', () => {
        expect(chunkSize(128 * 1024)).toBe(128 * 1024);
    });

    it('uses sctp max when it is less than DEFAULT_CHUNK', () => {
        expect(chunkSize(16 * 1024)).toBe(16 * 1024);
    });
});

describe('message builders round-trip', () => {
    it('metadataMessage parses back correctly', () => {
        const raw = metadataMessage('abc', 'file.txt', 1024, 1, 3);
        const msg = JSON.parse(raw);
        expect(msg).toMatchObject({ type: 'metadata', id: 'abc', fileName: 'file.txt', fileSize: 1024, index: 1, total: 3 });
    });

    it('ackMessage parses back correctly', () => {
        const raw = ackMessage('xyz', 512);
        const msg = JSON.parse(raw);
        expect(msg).toMatchObject({ type: 'ack', id: 'xyz', offset: 512 });
    });

    it('endMessage parses back correctly', () => {
        const raw = endMessage();
        const msg = JSON.parse(raw);
        expect(msg).toMatchObject({ type: 'end' });
    });
});

describe('classifyControl', () => {
    it('classifies metadata', () => {
        const raw = metadataMessage('id1', 'a.txt', 100, 1, 1);
        const result = classifyControl(toUint8(raw));
        expect(result?.type).toBe('metadata');
    });

    it('classifies ack', () => {
        const result = classifyControl(toUint8(ackMessage('id2', 0)));
        expect(result?.type).toBe('ack');
    });

    it('classifies end', () => {
        const result = classifyControl(toUint8(endMessage()));
        expect(result?.type).toBe('end');
    });

    it('returns null for binary data > CONTROL_MSG_MAX', () => {
        const big = new Uint8Array(CONTROL_MSG_MAX + 1).fill(65);
        expect(classifyControl(big)).toBeNull();
    });

    it('returns null for binary data that does not start with {', () => {
        const data = toUint8('hello world');
        expect(classifyControl(data)).toBeNull();
    });

    it('returns null for valid JSON but unknown type', () => {
        const data = toUint8(JSON.stringify({ type: 'unknown' }));
        expect(classifyControl(data)).toBeNull();
    });

    it('returns null for invalid JSON starting with {', () => {
        const data = toUint8('{not valid json');
        expect(classifyControl(data)).toBeNull();
    });

    it('returns null for exactly 1001 bytes of JSON-looking data', () => {
        // Pad to 1001 bytes — over the limit even if it looks like JSON
        const base = '{"type":"metadata","id":"' + 'x'.repeat(980) + '"}';
        const padded = toUint8(base.slice(0, CONTROL_MSG_MAX + 1));
        expect(classifyControl(padded)).toBeNull();
    });

    it('treats a small binary chunk that happens to look like JSON as file data (null)', () => {
        // A 999-byte payload that is valid JSON but has type "data" — should be null
        const payload = JSON.stringify({ type: 'data', bytes: 'x'.repeat(900) });
        expect(classifyControl(toUint8(payload.slice(0, 999)))).toBeNull();
    });

    it('accepts an ArrayBuffer as well as Uint8Array', () => {
        const buf = toArrayBuffer(endMessage());
        expect(classifyControl(buf)?.type).toBe('end');
    });
});
