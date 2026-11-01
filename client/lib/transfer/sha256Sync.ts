// Synchronous SHA-256 (FIPS 180-4) and HMAC-SHA256 (RFC 2104), for the link-key
// check and nothing else. File digests stay in fileHash.ts.
//
// Hand-written, and why (decision W1). The key check fails closed, so a hash that
// cannot run refuses the transfer, which rules out everything that can be missing
// at the moment it is needed: a Worker chunk or a dynamic import can 404 after a
// deploy while the reload gate holds the tab, WebAssembly can be disabled (iOS
// Lockdown Mode, managed browsers), and crypto.subtle exists only in a secure
// context. It also has to answer inside the data callback that delivers the
// peer's tag, because metadata can follow it one macrotask later, and that leaves
// no room for a promise or a hold queue.
//
// sha256Sync.test.ts holds this to Node's crypto, the NIST vectors and RFC 4231.
// Nothing here is constant time beyond what SHA-256's own operations are; the one
// compare that must be is tagsEqual in keyCheck.ts.

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const BLOCK_BYTES = 64;

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

function compress(state: Uint32Array, w: Uint32Array, data: Uint8Array, at: number): void {
    for (let t = 0; t < 16; t++, at += 4) {
        w[t] = (data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3];
    }
    for (let t = 16; t < 64; t++) {
        const x = w[t - 15];
        const y = w[t - 2];
        const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
        const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
        w[t] = w[t - 16] + s0 + w[t - 7] + s1; // a Uint32Array keeps the sum mod 2^32
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let t = 0; t < 64; t++) {
        const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + s1 + ch + K[t] + w[t]) | 0;
        const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (s0 + maj) | 0;
        h = g;
        g = f;
        f = e;
        e = (d + t1) | 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) | 0;
    }
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
    state[5] += f;
    state[6] += g;
    state[7] += h;
}

/** The SHA-256 digest of `message`, 32 bytes. */
export function sha256(message: Uint8Array): Uint8Array<ArrayBuffer> {
    const state = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const w = new Uint32Array(64);
    const length = message.length;
    const whole = length - (length % BLOCK_BYTES);
    for (let at = 0; at < whole; at += BLOCK_BYTES) compress(state, w, message, at);

    // The tail, the 0x80 marker and the 64-bit big-endian bit count take one
    // block, or two when fewer than 9 bytes of the first are left.
    const tail = new Uint8Array(length - whole < 56 ? BLOCK_BYTES : 2 * BLOCK_BYTES);
    tail.set(message.subarray(whole));
    tail[length - whole] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.length - 8, Math.floor(length / 0x20000000));
    view.setUint32(tail.length - 4, (length * 8) % 0x100000000);
    for (let at = 0; at < tail.length; at += BLOCK_BYTES) compress(state, w, tail, at);

    const digest = new Uint8Array(32);
    const out = new DataView(digest.buffer);
    state.forEach((word, i) => out.setUint32(i * 4, word));
    return digest;
}

/** HMAC-SHA256 of `message` under `key`, 32 bytes. A key of any length is allowed. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array<ArrayBuffer> {
    const block = new Uint8Array(BLOCK_BYTES);
    block.set(key.length > BLOCK_BYTES ? sha256(key) : key);
    const inner = new Uint8Array(BLOCK_BYTES + message.length);
    const outer = new Uint8Array(BLOCK_BYTES + 32);
    for (let i = 0; i < BLOCK_BYTES; i++) {
        inner[i] = block[i] ^ 0x36;
        outer[i] = block[i] ^ 0x5c;
    }
    inner.set(message, BLOCK_BYTES);
    outer.set(sha256(inner), BLOCK_BYTES);
    return sha256(outer);
}
