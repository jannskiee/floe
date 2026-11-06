// The hand-written primitive under the link-key check (decision W1). It is held
// to three independent authorities: Node's crypto over every message length that
// can hit a padding edge, the published NIST and RFC 4231 values as literals, and
// keycheck-vectors.json, whose tags came from Node's createHmac (keyCheck.test.ts).
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hmacSha256, sha256 } from './sha256Sync';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const ascii = (s: string) => new TextEncoder().encode(s);
const nodeSha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const nodeHmac = (k: Uint8Array, m: Uint8Array) => createHmac('sha256', k).update(m).digest('hex');

/** Deterministic bytes, so a failure reproduces: xorshift32 from a seed. */
function bytes(length: number, seed: number): Uint8Array {
    const out = new Uint8Array(length);
    let x = seed >>> 0 || 1;
    for (let i = 0; i < length; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        out[i] = x & 0xff;
    }
    return out;
}

// One padding block is 56 bytes of room, so 55, 56, 63, 64 and 65 are the edges
// of the first block and 119, 120 and 128 of the second.
const BLOCK_EDGES = [55, 56, 63, 64, 65, 119, 120, 128];
const KEY_LENGTHS = [0, 16, 63, 64, 65, 131];

describe('sha256 against Node crypto', () => {
    it('agrees on every message length from 0 to 300', () => {
        for (let length = 0; length <= 300; length++) {
            const message = bytes(length, 0x5eed0000 + length);
            expect(hex(sha256(message)), `length ${length}`).toBe(nodeSha(message));
        }
    });

    it('agrees on the block edges, whatever the bytes', () => {
        for (const length of BLOCK_EDGES) {
            for (const fill of [0x00, 0xff, 0x80]) {
                const message = new Uint8Array(length).fill(fill);
                expect(hex(sha256(message)), `length ${length} fill ${fill}`).toBe(nodeSha(message));
            }
        }
    });

    it('agrees on 1 MiB, so the block loop runs well past the padding code', () => {
        const message = bytes(1024 * 1024, 0x5eedabcd);
        expect(hex(sha256(message))).toBe(nodeSha(message));
    });

    it('reads a view at its own offset, not the buffer behind it', () => {
        // simple-peer hands out Node Buffers over a shared pool, and a certificate
        // can arrive the same way.
        const backing = bytes(200, 0x5eed1234);
        const view = backing.subarray(17, 133);
        expect(hex(sha256(view))).toBe(nodeSha(view));
    });

    it('leaves its input alone', () => {
        const message = bytes(70, 0x5eed4321);
        const copy = message.slice();
        sha256(message);
        expect(message).toEqual(copy);
    });
});

describe('sha256 against the NIST vectors (FIPS 180-4 examples)', () => {
    const cases: Array<[string, string, string]> = [
        ['empty', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
        ['abc', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
        [
            '448 bits',
            'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
            '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
        ],
        [
            '896 bits',
            'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
            'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
        ],
    ];
    for (const [name, message, digest] of cases) {
        it(name, () => expect(hex(sha256(ascii(message)))).toBe(digest));
    }

    it('one million a', () => {
        expect(hex(sha256(new Uint8Array(1_000_000).fill(0x61)))).toBe(
            'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'
        );
    });
});

describe('hmacSha256 against Node crypto', () => {
    it('agrees on every key length that can hit a block edge, over the message edges', () => {
        for (const keyLength of KEY_LENGTHS) {
            const key = bytes(keyLength, 0x5eed7000 + keyLength);
            for (const length of [0, 1, ...BLOCK_EDGES, 300]) {
                const message = bytes(length, 0x5eed8000 + length);
                expect(hex(hmacSha256(key, message)), `key ${keyLength} message ${length}`).toBe(nodeHmac(key, message));
            }
        }
    });

    it('leaves its key and message alone', () => {
        const key = bytes(16, 0x5eed1111);
        const message = bytes(70, 0x5eed2222);
        const keyCopy = key.slice();
        const messageCopy = message.slice();
        hmacSha256(key, message);
        expect(key).toEqual(keyCopy);
        expect(message).toEqual(messageCopy);
    });
});

describe('hmacSha256 against RFC 4231', () => {
    const repeat = (byte: number, length: number) => new Uint8Array(length).fill(byte);
    const counting = Uint8Array.from({ length: 25 }, (_, i) => i + 1);

    const cases: Array<{ name: string; key: Uint8Array; data: Uint8Array; mac: string }> = [
        {
            name: 'case 1',
            key: repeat(0x0b, 20),
            data: ascii('Hi There'),
            mac: 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
        },
        {
            name: 'case 2, a key shorter than the block',
            key: ascii('Jefe'),
            data: ascii('what do ya want for nothing?'),
            mac: '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
        },
        {
            name: 'case 3',
            key: repeat(0xaa, 20),
            data: repeat(0xdd, 50),
            mac: '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe',
        },
        {
            name: 'case 4',
            key: counting,
            data: repeat(0xcd, 50),
            mac: '82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b',
        },
        {
            name: 'case 5, compared to the 128 bits the RFC prints',
            key: repeat(0x0c, 20),
            data: ascii('Test With Truncation'),
            mac: 'a3b6167473100ee06e0c796c2955552b',
        },
        {
            name: 'case 6, a key longer than the block',
            key: repeat(0xaa, 131),
            data: ascii('Test Using Larger Than Block-Size Key - Hash Key First'),
            mac: '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
        },
        {
            name: 'case 7, a key and a message both longer than the block',
            key: repeat(0xaa, 131),
            data: ascii(
                'This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.'
            ),
            mac: '9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2',
        },
    ];

    for (const { name, key, data, mac } of cases) {
        it(name, () => expect(hex(hmacSha256(key, data)).slice(0, mac.length)).toBe(mac));
    }
});

describe('the module uses nothing a key check could lose at run time', () => {
    it('reaches for no crypto.subtle, Worker, WebAssembly or dynamic import (decision W1)', async () => {
        const { readFileSync } = await import('node:fs');
        const source = readFileSync(new URL('./sha256Sync.ts', import.meta.url), 'utf8');
        const code = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        for (const banned of ['crypto.subtle', 'subtle', 'WebAssembly', 'Worker', 'import(', 'hash-wasm', 'from ']) {
            expect(code.includes(banned), banned).toBe(false);
        }
    });
});
