import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
    createReceiver,
    MAX_QUEUED_WHILE_PENDING,
    INTERNAL_ERROR_MESSAGE,
    OUT_OF_MEMORY_MESSAGE,
    SPILL_BYTES,
    type ReceiveFailure,
    type ReceivedFile,
    type ReceiverDeps,
} from './receiver';
import { metadataMessage, endMessage, incompatibleMessage, CONTROL_MSG_MAX, PROTOCOL_VERSION, MIN_PROTOCOL_VERSION } from './protocol';

describe('receiver: per-file SHA-256', () => {
    const nodeHash = async (blob: Blob) => createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex');
    const digestOf = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
    const MISMATCH = 'A file did not match what was sent, so it was discarded. Ask the sender to try again.';
    const UNREADABLE = "The sender's SHA-256 for a file could not be read, so the file was discarded. Ask the sender to try again.";

    function payload(n: number, seed = 1): Uint8Array {
        const b = new Uint8Array(n);
        for (let i = 0; i < n; i++) b[i] = ((i * 7 + seed) % 250) + 1; // never starts with '{'
        return b;
    }

    function harness(deps: ReceiverDeps = { hashBlob: nodeHash }) {
        const sent: (string | Uint8Array)[] = [];
        const errors: string[] = [];
        const completed: ReceivedFile[] = [];
        const allComplete: Array<[number, number]> = [];
        const verifying: Array<[number, number]> = [];
        const rx = createReceiver(
            {
                send: (d) => sent.push(d),
                onFileComplete: (f) => completed.push(f),
                onAllComplete: (b, c) => allComplete.push([b, c]),
                onVerifying: (i, t) => verifying.push([i, t]),
                onError: (m) => errors.push(m),
            },
            deps
        );
        const binaryFrames = () =>
            sent.filter((s): s is Uint8Array => typeof s !== 'string').map((b) => JSON.parse(new TextDecoder().decode(b)));
        const acks = () => sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s));
        return { rx, sent, errors, completed, allComplete, verifying, binaryFrames, acks };
    }

    function feed(h: ReturnType<typeof harness>, id: string, data: Uint8Array, index: number, total: number, end: string) {
        h.rx.handleMessage(metadataMessage(id, `${id}.bin`, data.byteLength, index, total, 0));
        if (data.byteLength > 0) h.rx.handleMessage(data);
        h.rx.handleMessage(end);
    }

    const endWith = (value: unknown) => JSON.stringify({ type: 'end', sha256: value });

    it('verifies sha256 and keeps the file', async () => {
        const h = harness();
        const data = payload(5000);
        feed(h, 'a', data, 1, 1, endMessage(digestOf(data)));
        await h.rx.settled();
        expect(h.errors).toEqual([]);
        expect(h.completed).toHaveLength(1);
        expect(h.completed[0].verified).toBe(true);
        expect(new Uint8Array(await h.completed[0].blob.arrayBuffer())).toEqual(data);
        expect(h.verifying).toEqual([[1, 1]]);
        expect(h.allComplete).toEqual([[5000, 1]]);
    });

    it('discards a mismatched file and sends hash-mismatch', async () => {
        const h = harness();
        const data = payload(3000);
        const wrong = digestOf(payload(3000, 2));
        feed(h, 'a', data, 1, 1, endMessage(wrong));
        await h.rx.settled();
        expect(h.completed).toEqual([]);
        expect(h.errors).toEqual([MISMATCH]);
        const [frame] = h.binaryFrames();
        expect(frame).toMatchObject({
            type: 'incompatible',
            reason: 'receiver discarded a file because its SHA-256 did not match',
            code: 'hash-mismatch',
            saved: 0,
            pv: PROTOCOL_VERSION,
            pvMin: MIN_PROTOCOL_VERSION,
        });
    });

    it('refuses a malformed sha256 as hash-mismatch', async () => {
        for (const bad of [null, 3, 'ABC', digestOf(payload(1)).toUpperCase(), 'a'.repeat(63), 'a'.repeat(65), {}, []]) {
            const h = harness();
            feed(h, 'a', payload(100), 1, 1, endWith(bad));
            await h.rx.settled();
            expect(h.completed, JSON.stringify(bad)).toEqual([]);
            const [frame] = h.binaryFrames();
            expect(frame.code).toBe('hash-mismatch');
        }
    });

    it('refuses an unreadable sha256 before hashing', async () => {
        let calls = 0;
        const h = harness({
            hashBlob: async (b) => {
                calls += 1;
                return nodeHash(b);
            },
        });
        feed(h, 'a', payload(100), 1, 1, endWith('not-a-digest'));
        await h.rx.settled();
        expect(calls).toBe(0);
        expect(h.errors).toEqual([UNREADABLE]);
        expect(h.binaryFrames()[0].reason).toBe("receiver discarded a file because the sender's SHA-256 was not readable");
        expect(h.verifying).toEqual([]);
    });

    it('accepts a file without sha256 as today', () => {
        let calls = 0;
        const h = harness({
            hashBlob: async () => {
                calls += 1;
                return null;
            },
        });
        const data = payload(200);
        feed(h, 'a', data, 1, 1, endMessage());
        // Synchronous, exactly as before: no check, no wait.
        expect(calls).toBe(0);
        expect(h.completed).toHaveLength(1);
        expect(h.completed[0].verified).toBe(false);
        expect(h.errors).toEqual([]);
    });

    it('treats a hasher failure as unverified', async () => {
        const failing: Array<ReceiverDeps['hashBlob']> = [
            async () => null,
            async () => {
                throw new Error('worker died');
            },
        ];
        for (const hashBlob of failing) {
            const h = harness({ hashBlob });
            const data = payload(300);
            feed(h, 'a', data, 1, 1, endMessage(digestOf(data)));
            await h.rx.settled();
            expect(h.errors).toEqual([]);
            expect(h.completed).toHaveLength(1);
            expect(h.completed[0].verified).toBe(false);
        }
    });

    it('marks verified only on a matching digest', async () => {
        const h = harness();
        const a = payload(10, 1);
        const b = payload(10, 2);
        feed(h, 'a', a, 1, 2, endMessage(digestOf(a)));
        await h.rx.settled();
        feed(h, 'b', b, 2, 2, endMessage());
        await h.rx.settled();
        expect(h.completed.map((f) => f.verified)).toEqual([true, false]);
    });

    // A digest the test releases by hand, so frames can arrive while it is pending.
    // The receiver starts the digest a microtask after the end frame, so release
    // waits for that call before resolving it.
    function heldHash() {
        let release: ((hex: string | null) => void) | null = null;
        const hashBlob = () =>
            new Promise<string | null>((resolve) => {
                release = resolve;
            });
        const releaseWhenCalled = async (hex: string | null) => {
            while (release === null) await Promise.resolve();
            release(hex);
        };
        return { hashBlob, release: (hex: string | null) => void releaseWhenCalled(hex) };
    }

    it('queues frames that arrive while a digest is pending', async () => {
        const held = heldHash();
        const h = harness({ hashBlob: held.hashBlob });
        const a = payload(400, 1);
        feed(h, 'a', a, 1, 2, endMessage(digestOf(a)));
        // The next file's metadata arrives while the first file is being checked.
        h.rx.handleMessage(metadataMessage('b', 'b.bin', 10, 2, 2, 0));
        expect(h.acks().map((m) => m.id)).toEqual(['a']);
        expect(h.completed).toEqual([]);
        held.release(digestOf(a));
        await h.rx.settled();
        expect(h.completed.map((f) => f.fileName)).toEqual(['a.bin']);
        // Handled in order, after the file.
        expect(h.acks().map((m) => m.id)).toEqual(['a', 'b']);
    });

    it('stops on an oversized string frame while a digest is pending, and keeps nothing', async () => {
        // DV-AUDIT CP-0 F1: the control cap used to be skipped while a check was
        // pending, so any number of strings of any size could wait in memory.
        const held = heldHash();
        const h = harness({ hashBlob: held.hashBlob });
        const a = payload(300, 1);
        feed(h, 'a', a, 1, 2, endMessage(digestOf(a)));
        h.rx.handleMessage('{"type":"metadata","pad":"' + 'x'.repeat(CONTROL_MSG_MAX) + '"}');
        expect(h.errors).toEqual([
            `The sender sent a control message larger than ${CONTROL_MSG_MAX} bytes, so the transfer was stopped.`,
        ]);
        held.release(digestOf(a));
        await h.rx.settled();
        // The file being checked is not handed over after a stop, even though it matched.
        expect(h.completed).toEqual([]);
        // And nothing after the stop is read.
        h.rx.handleMessage(metadataMessage('c', 'c.bin', 10, 2, 2, 0));
        expect(h.acks().map((m) => m.id)).toEqual(['a']);
    });

    it('stops when a sender floods string frames while a digest is pending', async () => {
        const held = heldHash();
        const h = harness({ hashBlob: held.hashBlob });
        const a = payload(200, 1);
        feed(h, 'a', a, 1, 2, endMessage(digestOf(a)));
        // Exactly the bound is still accepted and handled in order afterwards...
        for (let i = 0; i < MAX_QUEUED_WHILE_PENDING; i++) h.rx.handleMessage('{"type":"unknown-' + i + '"}');
        expect(h.errors).toEqual([]);
        // ...and one more stops the transfer.
        h.rx.handleMessage('{"type":"unknown-over"}');
        expect(h.errors).toEqual([
            'The sender sent more messages than a transfer allows while a file was being checked, so the transfer was stopped.',
        ]);
        held.release(digestOf(a));
        await h.rx.settled();
        expect(h.completed).toEqual([]);
    });

    it('a conforming frame during the check still waits and is handled after it', async () => {
        const held = heldHash();
        const h = harness({ hashBlob: held.hashBlob });
        const a = payload(200, 1);
        feed(h, 'a', a, 1, 2, endMessage(digestOf(a)));
        h.rx.handleMessage(metadataMessage('b', 'b.bin', 10, 2, 2, 0));
        held.release(digestOf(a));
        await h.rx.settled();
        expect(h.errors).toEqual([]);
        expect(h.completed.map((f) => f.fileName)).toEqual(['a.bin']);
        expect(h.acks().map((m) => m.id)).toEqual(['a', 'b']);
    });

    it('drops binary frames that arrive while a digest is pending', async () => {
        const held = heldHash();
        const h = harness({ hashBlob: held.hashBlob });
        const a = payload(100, 1);
        feed(h, 'a', a, 1, 2, endMessage(digestOf(a)));
        h.rx.handleMessage(payload(50, 9)); // mid-wait chunk: no file is open
        h.rx.handleMessage(metadataMessage('b', 'b.bin', 20, 2, 2, 0));
        held.release(digestOf(a));
        await h.rx.settled();
        const b = payload(20, 3);
        h.rx.handleMessage(b);
        h.rx.handleMessage(endMessage());
        expect(h.errors).toEqual([]);
        expect(new Uint8Array(await h.completed[1].blob.arrayBuffer())).toEqual(b);
    });

    it('drops queued frames after a refusal', async () => {
        const held = heldHash();
        const h = harness({ hashBlob: held.hashBlob });
        feed(h, 'a', payload(100), 1, 2, endMessage(digestOf(payload(100, 5))));
        h.rx.handleMessage(metadataMessage('b', 'b.bin', 20, 2, 2, 0));
        // The real bytes' digest, not the one the sender sent.
        held.release(digestOf(payload(100)));
        await h.rx.settled();
        expect(h.errors).toEqual([MISMATCH]);
        expect(h.acks().map((m) => m.id)).toEqual(['a']);
    });

    it('sends saved as the number of files already handed over', async () => {
        const h = harness();
        const a = payload(10, 1);
        feed(h, 'a', a, 1, 2, endMessage(digestOf(a)));
        await h.rx.settled();
        feed(h, 'b', payload(10, 2), 2, 2, endMessage(digestOf(a)));
        await h.rx.settled();
        expect(h.binaryFrames()[0].saved).toBe(1);
    });

    it('does not fire onAllComplete for a discarded last file', async () => {
        const h = harness();
        const a = payload(10, 1);
        feed(h, 'a', a, 1, 2, endMessage(digestOf(a)));
        await h.rx.settled();
        feed(h, 'b', payload(10, 2), 2, 2, endMessage(digestOf(a)));
        await h.rx.settled();
        expect(h.completed).toHaveLength(1);
        expect(h.allComplete).toEqual([]);
    });

    it('settled resolves at once when idle and after a pending digest', async () => {
        const held = heldHash();
        const h = harness({ hashBlob: held.hashBlob });
        await h.rx.settled();
        const a = payload(10);
        feed(h, 'a', a, 1, 1, endMessage(digestOf(a)));
        let done = false;
        const waiting = h.rx.settled().then(() => {
            done = true;
        });
        await Promise.resolve();
        expect(done).toBe(false);
        held.release(digestOf(a));
        await waiting;
        expect(done).toBe(true);
        expect(h.completed).toHaveLength(1);
    });

    it('keeps the file unverified when the hash outruns its bound', async () => {
        const h = harness({
            hashBlob: (_blob, signal) => new Promise((resolve) => signal?.addEventListener('abort', () => resolve(null))),
            hashBoundMs: () => 10,
        });
        const a = payload(10);
        feed(h, 'a', a, 1, 1, endMessage(digestOf(a)));
        await h.rx.settled();
        expect(h.errors).toEqual([]);
        expect(h.completed[0].verified).toBe(false);
    });

    // CP0-F2. The bound used to be AbortSignal.timeout, which Safari before 16
    // does not have: the signal was undefined there, so a hasher that never
    // answered left settled() pending forever with every later frame queued
    // behind it. An AbortController plus a setTimeout works on every engine.
    it('bounds the hash wait with a timer when AbortSignal.timeout is missing', async () => {
        const realTimeout = AbortSignal.timeout;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (AbortSignal as any).timeout = undefined;
        try {
            const h = harness({
                hashBlob: (_blob, signal) => new Promise((resolve) => signal?.addEventListener('abort', () => resolve(null))),
                hashBoundMs: () => 10,
            });
            const a = payload(10);
            feed(h, 'a', a, 1, 1, endMessage(digestOf(a)));
            await h.rx.settled();
            expect(h.errors).toEqual([]);
            expect(h.completed).toHaveLength(1);
            // A missing check never claims a match, and never refuses either.
            expect(h.completed[0].verified).toBe(false);
        } finally {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (AbortSignal as any).timeout = realTimeout;
        }
    });

    it('clears the bound timer when the digest settles', async () => {
        vi.useFakeTimers();
        try {
            const h = harness({ hashBlob: nodeHash, hashBoundMs: () => 30_000 });
            const a = payload(10);
            feed(h, 'a', a, 1, 1, endMessage(digestOf(a)));
            const done = h.rx.settled();
            await vi.advanceTimersByTimeAsync(0);
            await done;
            expect(h.completed[0].verified).toBe(true);
            // The 30 s bound must not outlive the digest it was guarding.
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('releases the chunks of a checked file before its digest settles', async () => {
        const held = heldHash();
        const h = harness({ hashBlob: held.hashBlob });
        const a = payload(300);
        feed(h, 'a', a, 1, 2, endMessage(digestOf(a)));
        // The same id announced again while the check runs: once handled, it must
        // start from byte 0, which it can only do if the entry is already gone.
        h.rx.handleMessage(metadataMessage('a', 'a.bin', 300, 2, 2, 0));
        held.release(digestOf(a));
        await h.rx.settled();
        expect(h.acks().map((m) => m.offset)).toEqual([0, 0]);
    });

    it('keeps the file unverified when the hasher throws synchronously', async () => {
        const h = harness({
            hashBlob: () => {
                throw new Error('sync');
            },
        });
        const a = payload(40);
        feed(h, 'a', a, 1, 1, endMessage(digestOf(a)));
        await h.rx.settled();
        expect(h.errors).toEqual([]);
        expect(h.completed).toHaveLength(1);
        expect(h.completed[0].verified).toBe(false);
    });

    it('keeps the file unverified when onVerifying throws', async () => {
        const completed: ReceivedFile[] = [];
        const rx = createReceiver(
            {
                send: () => { },
                onFileComplete: (f) => completed.push(f),
                onVerifying: () => {
                    throw new Error('ui');
                },
            },
            { hashBlob: nodeHash }
        );
        const a = payload(40);
        rx.handleMessage(metadataMessage('a', 'a.bin', a.byteLength, 1, 1, 0));
        rx.handleMessage(a);
        rx.handleMessage(endMessage(digestOf(a)));
        await rx.settled();
        expect(completed.map((f) => f.verified)).toEqual([false]);
    });

    it('a queued end starts a second check and settled waits for both', async () => {
        const releases: Array<(hex: string | null) => void> = [];
        const h = harness({
            hashBlob: () =>
                new Promise<string | null>((resolve) => {
                    releases.push(resolve);
                }),
        });
        const a = payload(30, 1);
        const empty = new Uint8Array(0);
        feed(h, 'a', a, 1, 2, endMessage(digestOf(a)));
        // A zero-byte second file arrives whole while the first is being checked.
        h.rx.handleMessage(metadataMessage('b', 'b.bin', 0, 2, 2, 0));
        h.rx.handleMessage(endMessage(digestOf(empty)));
        let done = false;
        const waiting = h.rx.settled().then(() => {
            done = true;
        });
        await Promise.resolve();
        await Promise.resolve();
        releases[0](digestOf(a));
        // Let the first check settle and the queue drain into the second check.
        // A macrotask, not a count of microtasks: the verdict also waits for the
        // read-back of the file's last part (see probe in receiver.ts), and a
        // Blob read settles outside the microtask queue.
        await new Promise((r) => setTimeout(r, 0));
        expect(h.completed.map((f) => f.fileName)).toEqual(['a.bin']);
        expect(h.acks().map((m) => m.id)).toEqual(['a', 'b']);
        expect(releases).toHaveLength(2);
        expect(done).toBe(false);
        releases[1](digestOf(empty));
        await waiting;
        expect(h.completed.map((f) => [f.fileName, f.verified])).toEqual([['a.bin', true], ['b.bin', true]]);
        expect(h.allComplete).toEqual([[30, 2]]);
    });

    it('shows the two fixed sentences', async () => {
        const mismatch = harness();
        feed(mismatch, 'a', payload(10), 1, 1, endMessage(digestOf(payload(10, 4))));
        await mismatch.rx.settled();
        const unreadable = harness();
        feed(unreadable, 'a', payload(10), 1, 1, endWith(null));
        await unreadable.rx.settled();
        expect([mismatch.errors, unreadable.errors]).toEqual([[MISMATCH], [UNREADABLE]]);
    });

    it('keeps code and saved when the reason shrinks to fit the cap', () => {
        const frame = incompatibleMessage('very long prose. '.repeat(500), 'hash-mismatch', 0);
        expect(new TextEncoder().encode(frame).byteLength).toBeLessThanOrEqual(CONTROL_MSG_MAX);
        const parsed = JSON.parse(frame);
        expect(parsed).toMatchObject({ code: 'hash-mismatch', saved: 0 });
        expect(parsed.reason.length).toBeGreaterThan(0);
        // Uncoded callers still send exactly the old frame shape.
        expect(Object.keys(JSON.parse(incompatibleMessage('x')))).toEqual(['type', 'reason', 'pv', 'pvMin']);
    });

    // FU-48. P2PTransfer.tsx wires peer.on('close', rx.dispose) (#500) next to a
    // close handler that waits on settled(). A Go sender closes about 50 ms
    // after its last end marker, while this side may still be hashing the file
    // it sent, so the close lands in the middle of the check. The file is whole
    // by then: the close must not cost the person their last file.
    describe('a close while a check is pending', () => {
        it('still hands over the file being checked, once, verified', async () => {
            const held = heldHash();
            const h = harness({ hashBlob: held.hashBlob });
            const a = payload(400);
            feed(h, 'a', a, 1, 1, endMessage(digestOf(a)));
            // The same order as the component: the close handler asks for
            // settled() first, then dispose runs on the same event.
            const closed = h.rx.settled();
            h.rx.dispose();
            held.release(digestOf(a));
            await closed;
            expect(h.errors).toEqual([]);
            expect(h.completed).toHaveLength(1);
            expect(h.completed[0].verified).toBe(true);
            expect(new Uint8Array(await h.completed[0].blob.arrayBuffer())).toEqual(a);
            expect(h.allComplete).toEqual([[400, 1]]);
        });

        it('still refuses a file that does not match, and says so', async () => {
            const held = heldHash();
            const h = harness({ hashBlob: held.hashBlob });
            const a = payload(300);
            feed(h, 'a', a, 1, 1, endMessage(digestOf(a)));
            const closed = h.rx.settled();
            h.rx.dispose();
            held.release(digestOf(payload(300, 2)));
            await closed;
            expect(h.completed).toEqual([]);
            expect(h.errors).toEqual([MISMATCH]);
            expect(h.allComplete).toEqual([]);
        });

        it('reads none of the frames that waited, and nothing after the close', async () => {
            const held = heldHash();
            const h = harness({ hashBlob: held.hashBlob });
            const a = payload(200);
            feed(h, 'a', a, 1, 2, endMessage(digestOf(a)));
            // The next file's metadata was already queued when the connection went.
            h.rx.handleMessage(metadataMessage('b', 'b.bin', 10, 2, 2, 0));
            const closed = h.rx.settled();
            h.rx.dispose();
            h.rx.handleMessage(metadataMessage('c', 'c.bin', 10, 2, 2, 0));
            held.release(digestOf(a));
            await closed;
            expect(h.completed.map((f) => f.fileName)).toEqual(['a.bin']);
            // No ack for b or c: nobody is there to read one.
            expect(h.acks().map((m) => m.id)).toEqual(['a']);
            expect(h.errors).toEqual([]);
        });
    });

    // The read-back of a file's last part settles with the digest (#501's merge
    // note). The probe here rejects one macrotask later, after a digest that
    // already came back null, which is what the hash worker answers when the
    // same broken part fails its read.
    describe('a broken last part', () => {
        const RealBlob = Blob;
        afterEach(() => {
            vi.unstubAllGlobals();
        });

        function brokenLate(): void {
            vi.stubGlobal(
                'Blob',
                class extends RealBlob {
                    slice(): Blob {
                        return {
                            arrayBuffer: () =>
                                new Promise((_, reject) =>
                                    setTimeout(() => reject(new DOMException('', 'NotReadableError')), 0)
                                ),
                        } as unknown as Blob;
                    }
                }
            );
        }

        function failing(deps: ReceiverDeps) {
            const errors: string[] = [];
            const failures: (ReceiveFailure | undefined)[] = [];
            const completed: ReceivedFile[] = [];
            const rx = createReceiver(
                {
                    send: () => {},
                    onFileComplete: (f) => completed.push(f),
                    onError: (m, f) => {
                        errors.push(m);
                        failures.push(f);
                    },
                },
                deps
            );
            return { rx, errors, failures, completed };
        }

        it('stops with the out-of-memory message instead of handing the file over unverified', async () => {
            brokenLate();
            const h = failing({ hashBlob: async () => null });
            const a = payload(500);
            h.rx.handleMessage(metadataMessage('a', 'a.bin', a.byteLength, 1, 1, 0));
            h.rx.handleMessage(a);
            h.rx.handleMessage(endMessage(digestOf(a)));
            await h.rx.settled();
            expect(h.completed).toEqual([]);
            expect(h.errors).toEqual([OUT_OF_MEMORY_MESSAGE]);
            expect(h.failures[0]).toMatchObject({ code: 'out-of-memory', received: 500, expected: 500 });
        });

        it('still stops on it when the connection closed during the check', async () => {
            // #500's out-of-memory stop survives the close: the file is not
            // handed over just because the close let its check finish.
            brokenLate();
            const held = heldHash();
            const h = failing({ hashBlob: held.hashBlob });
            const a = payload(500);
            h.rx.handleMessage(metadataMessage('a', 'a.bin', a.byteLength, 1, 1, 0));
            h.rx.handleMessage(a);
            h.rx.handleMessage(endMessage(digestOf(a)));
            const closed = h.rx.settled();
            h.rx.dispose();
            held.release(null);
            await closed;
            expect(h.completed).toEqual([]);
            expect(h.errors).toEqual([OUT_OF_MEMORY_MESSAGE]);
        });

        it('cannot leave the check pending when the read-back never settles', async () => {
            // readBack resolves at the hash bound (CP0-F2): a part whose
            // read-back hangs must not hold every later frame behind the check,
            // keep settled() from resolving, or keep the close decision waiting.
            vi.stubGlobal(
                'Blob',
                class extends RealBlob {
                    slice(): Blob {
                        return { arrayBuffer: () => new Promise(() => {}) } as unknown as Blob;
                    }
                }
            );
            const h = failing({
                hashBlob: async (b) => digestOf(new Uint8Array(await b.arrayBuffer())),
                hashBoundMs: () => 20,
            });
            const a = payload(100);
            h.rx.handleMessage(metadataMessage('a', 'a.bin', a.byteLength, 1, 1, 0));
            h.rx.handleMessage(a);
            h.rx.handleMessage(endMessage(digestOf(a)));
            const outcome = await Promise.race([
                h.rx.settled().then(() => 'settled'),
                new Promise((r) => setTimeout(() => r('hung'), 500)),
            ]);
            expect(outcome).toBe('settled');
            expect(h.errors).toEqual([]);
            expect(h.completed).toHaveLength(1);
            expect(h.completed[0].verified).toBe(true);
        });
    });

    it('verifies a file that crossed a spill, built from every part in order', async () => {
        // takeBlob on the checked path: the spilled parts and the held tail,
        // composed, are exactly what was sent.
        const h = harness();
        const a = payload(SPILL_BYTES + 4321, 3);
        // In 256 KiB chunks, so one part is spilled mid-file and a 4321-byte
        // tail is still held when the end marker arrives.
        h.rx.handleMessage(metadataMessage('a', 'a.bin', a.byteLength, 1, 1, 0));
        for (let off = 0; off < a.byteLength; off += 256 * 1024) h.rx.handleMessage(a.subarray(off, off + 256 * 1024));
        h.rx.handleMessage(endMessage(digestOf(a)));
        await h.rx.settled();
        expect(h.errors).toEqual([]);
        expect(h.completed).toHaveLength(1);
        expect(h.completed[0].verified).toBe(true);
        expect(h.completed[0].blob.size).toBe(a.byteLength);
    });

    it('stops once when a frame that waited out a check throws', async () => {
        // drain hands queued frames to runMessage: a throw there is caught,
        // latched and reported once, the same as a frame that arrived live.
        const held = heldHash();
        const sent: (string | Uint8Array)[] = [];
        const errors: string[] = [];
        const failures: (ReceiveFailure | undefined)[] = [];
        const completed: string[] = [];
        const rx = createReceiver(
            {
                send: (d) => sent.push(d),
                onFileStart: (index) => {
                    if (index === 2) throw new TypeError('render failed');
                },
                onFileComplete: (f) => completed.push(f.fileName),
                onError: (m, f) => {
                    errors.push(m);
                    failures.push(f);
                },
            },
            { hashBlob: held.hashBlob }
        );
        const a = payload(100);
        rx.handleMessage(metadataMessage('a', 'a.bin', a.byteLength, 1, 2, 0));
        rx.handleMessage(a);
        rx.handleMessage(endMessage(digestOf(a)));
        rx.handleMessage(metadataMessage('b', 'b.bin', 10, 2, 2, 0));
        held.release(digestOf(a));
        await new Promise((r) => setTimeout(r, 0));
        expect(completed).toEqual(['a.bin']);
        expect(errors).toEqual([INTERNAL_ERROR_MESSAGE]);
        expect(failures[0]).toMatchObject({ code: 'internal', received: 0, expected: null });
        // The sender is told, with the closed set's code and the one file
        // already handed over.
        const abort = JSON.parse(new TextDecoder().decode(sent[sent.length - 1] as Uint8Array));
        expect(abort).toMatchObject({ type: 'incompatible', code: 'write-failed', saved: 1 });
        // Latched: nothing after it reopens the transfer, and settled() is free.
        rx.handleMessage(payload(10, 4));
        rx.handleMessage(endMessage());
        expect(errors).toHaveLength(1);
        await expect(rx.settled()).resolves.toBeUndefined();
    });

    it('stops once when handing a checked file over throws', async () => {
        // main's 'reports no sizes for a throw after the file was handed over'
        // (#500), on the checked path every current sender takes: the hand-over
        // runs after the digest, outside runMessage, and must still stop once.
        const held = heldHash();
        const sent: (string | Uint8Array)[] = [];
        const errors: string[] = [];
        const failures: (ReceiveFailure | undefined)[] = [];
        const rx = createReceiver(
            {
                send: (d) => sent.push(d),
                onFileComplete: () => {
                    throw new TypeError('render failed');
                },
                onError: (m, f) => {
                    errors.push(m);
                    failures.push(f);
                },
            },
            { hashBlob: held.hashBlob }
        );
        const a = payload(100);
        rx.handleMessage(metadataMessage('a', 'a.bin', 100, 1, 2, 0));
        rx.handleMessage(a);
        rx.handleMessage(endMessage(digestOf(a)));
        rx.handleMessage(metadataMessage('b', 'b.bin', 10, 2, 2, 0));
        const done = rx.settled();
        held.release(digestOf(a));
        await done;
        expect(errors).toEqual([INTERNAL_ERROR_MESSAGE]);
        expect(failures[0]).toMatchObject({ code: 'internal', received: 0, expected: null });
        // The file the page failed to record is not followed by the next one.
        const acks = sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s).id);
        expect(acks).toEqual(['a']);
        // The sender is told; the file that threw was never counted as handed over.
        const abort = JSON.parse(new TextDecoder().decode(sent[sent.length - 1] as Uint8Array));
        expect(abort).toMatchObject({ type: 'incompatible', code: 'write-failed', saved: 0 });
    });

    it('stops once when a frame that arrives during a check cannot even be measured', async () => {
        // The control cap's TextEncoder runs inside runMessage's try like any
        // other allocation (#500's merge note): out of memory there stops the
        // transfer once instead of escaping into simple-peer's emitter, and the
        // file being checked is not handed over after it.
        const held = heldHash();
        const errors: string[] = [];
        const failures: (ReceiveFailure | undefined)[] = [];
        const completed: string[] = [];
        const rx = createReceiver(
            {
                send: () => {},
                onFileComplete: (f) => completed.push(f.fileName),
                onError: (m, f) => {
                    errors.push(m);
                    failures.push(f);
                },
            },
            { hashBlob: held.hashBlob }
        );
        const a = payload(100);
        rx.handleMessage(metadataMessage('a', 'a.bin', a.byteLength, 1, 2, 0));
        rx.handleMessage(a);
        rx.handleMessage(endMessage(digestOf(a)));
        vi.stubGlobal(
            'TextEncoder',
            class {
                encode(): Uint8Array {
                    throw new RangeError('Array buffer allocation failed');
                }
            }
        );
        try {
            expect(() => rx.handleMessage(metadataMessage('b', 'b.bin', 10, 2, 2, 0))).not.toThrow();
            expect(() => rx.handleMessage(metadataMessage('c', 'c.bin', 10, 2, 2, 0))).not.toThrow();
        } finally {
            vi.unstubAllGlobals();
        }
        held.release(digestOf(a));
        await rx.settled();
        expect(errors).toEqual([OUT_OF_MEMORY_MESSAGE]);
        expect(failures[0]).toMatchObject({ code: 'out-of-memory', received: 0, expected: null });
        expect(completed).toEqual([]);
    });
});
