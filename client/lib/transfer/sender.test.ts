import { describe, it, expect, vi } from 'vitest';
import { sendFiles, sendAbortReason, CONTROL_FLUSH_MS, type SenderDeps } from './sender';
import { ackMessage, incompatibleMessage, CONTROL_MSG_MAX, READ_SLAB, DEFAULT_CHUNK } from './protocol';

const enc = new TextEncoder();

// Minimal no-op buffer channel — backpressure never engaged in tests.
function makeBufferChannel() {
    return {
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        addEventListener: () => { },
        removeEventListener: () => { },
    };
}

// Creates a File with known random bytes of given size.
function makeFile(sizeBytes: number, name = 'test.bin'): File {
    const buf = new Uint8Array(sizeBytes);
    if (sizeBytes > 0) {
        // Pseudo-random but deterministic content
        for (let i = 0; i < sizeBytes; i++) {
            buf[i] = (i * 31 + 7) % 256;
        }
    }
    return new File([buf], name, { type: 'application/octet-stream' });
}

/**
 * The other half of #283: a browser SENDER used to print whatever reason
 * arrived, so a browser too old for its peer read the peer's neutral wording
 * instead of "refresh the page". It now rebuilds from the frame's pv range,
 * the way the Go sender has since PR #282.
 */
describe('sender: a version mismatch is rebuilt from the frame', () => {
    it('shows the browser remedy instead of the neutral wire wording', async () => {
        const wire =
            "Cannot transfer: your floe is too old for this peer.\n  You: protocol 1  Peer: protocol 2 (1.11.0)\n  Update Floe to continue.";
        const errors: string[] = [];
        await sendFiles(
            scriptedDeps(() =>
                JSON.stringify({ type: 'incompatible', reason: wire, pv: 2, pvMin: 2, ver: '1.11.0' })
            ),
            [{ id: 'x', file: makeFile(16, 'a.bin') }],
            { onError: (m) => errors.push(m) }
        );
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('your browser is running an older version of Floe');
        expect(errors[0]).toContain('Refresh the page to get the latest version.');
        expect(errors[0]).toContain('Peer: protocol 2 (1.11.0)');
        expect(errors[0]).not.toContain('Update Floe to continue.');
    });

    it('still prints a deliberate abort verbatim, because its pv range overlaps ours', async () => {
        // The PR #429 contract, pinned on the sender side for the first time.
        // incompatibleMessage stamps the current range, so this is an abort
        // reason and not a version mismatch.
        const reason = 'Transfer blocked: relay connections are capped at 2 GB.';
        const errors: string[] = [];
        await sendFiles(
            scriptedDeps(() => incompatibleMessage(reason)),
            [{ id: 'x', file: makeFile(16, 'a.bin') }],
            { onError: (m) => errors.push(m) }
        );
        expect(errors).toEqual([reason]);
    });

    it('cleans a hostile version string in a mismatch frame', async () => {
        const ver = 'v\u202e' + 'x'.repeat(400);
        const errors: string[] = [];
        await sendFiles(
            scriptedDeps(() =>
                JSON.stringify({ type: 'incompatible', reason: 'x', pv: 2, pvMin: 2, ver })
            ),
            [{ id: 'x', file: makeFile(16, 'a.bin') }],
            { onError: (m) => errors.push(m) }
        );
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('Cannot transfer');
        expect(errors[0]).not.toContain('\u202e');
    });
});

/**
 * sendAbortReason exists for the half-second between saying why and tearing the
 * connection down. Without the wait the frame goes with the channel and the
 * peer sees only the close, which is issue #284 on the browser side.
 */
describe('sender: an abort reason reaches the wire before teardown', () => {
    it('sends the reason as a STRING and waits for the buffer to drain', async () => {
        // A binary frame on the sender-to-receiver path is file data by
        // definition, so a binary reason would land in somebody's file.
        const sent: (string | Uint8Array)[] = [];
        let buffered = 4096;
        const channel = {
            get bufferedAmount() { return buffered; },
            bufferedAmountLowThreshold: 0,
            addEventListener: () => {},
            removeEventListener: () => {},
        };
        let settled = false;
        const done = sendAbortReason((d) => sent.push(d), channel, 'Transfer blocked: capped at 2 GB.').then(() => {
            settled = true;
        });

        expect(typeof sent[0]).toBe('string');
        expect(JSON.parse(sent[0] as string).type).toBe('incompatible');

        // The assertion that matters: an implementation that skipped the
        // drain would already be settled here, and the reason would go with
        // the channel when the caller tears it down.
        await Promise.resolve();
        expect(settled).toBe(false);

        buffered = 0;
        await done;
        expect(settled).toBe(true);
    });

    it('does not hang when the peer never drains', async () => {
        // Fake timers, so the deadline is asserted from both sides instead of
        // waited out. On the real clock this test spent 2 s asleep and was the
        // long pole of the whole client unit suite.
        vi.useFakeTimers();
        try {
            const channel = {
                bufferedAmount: 4096,
                bufferedAmountLowThreshold: 0,
                addEventListener: () => {},
                removeEventListener: () => {},
            };
            let settled = false;
            const done = sendAbortReason(() => {}, channel, 'why').then(() => {
                settled = true;
            });

            // Not a millisecond early: a peer that is merely slow gets the
            // whole window, and drainBelow's 200 ms poll must not end it.
            await vi.advanceTimersByTimeAsync(CONTROL_FLUSH_MS - 1);
            expect(settled).toBe(false);

            // And not a millisecond late. A peer that stopped acknowledging
            // must not hold the teardown open.
            await vi.advanceTimersByTimeAsync(1);
            expect(settled).toBe(true);
            await done;
        } finally {
            vi.useRealTimers();
        }
    });
});

/**
 * The rejection reason and the version string in an ack are peer-supplied and
 * used to land in the error banner verbatim. React escapes HTML, not control
 * characters or bidi marks, so the sender cleans and caps them first.
 */
// Loopback deps whose receiver side is scripted: `reply` builds the frame that
// answers the sender's metadata, delivered on a microtask like the loopback
// harness in transfer.test.ts so waitForAck is registered before it fires. `sent` collects
// every string frame the sender emits, for "never announced the file as done"
// assertions.
function scriptedDeps(reply: (metadataId: string) => string, sent: string[] = []): SenderDeps {
    let senderDataHandler: ((d: string | Uint8Array | ArrayBuffer) => void) | null = null;
    return {
        send: (d) => {
            if (typeof d !== 'string') return;
            sent.push(d);
            const parsed = JSON.parse(d) as { type: string; id?: string };
            if (parsed.type === 'metadata' && parsed.id) {
                const frame = enc.encode(reply(parsed.id));
                // A fixture past the control cap is dropped by classifyControl
                // and the sender waits out the ack timeout, so pin the size.
                expect(frame.byteLength).toBeLessThanOrEqual(CONTROL_MSG_MAX);
                queueMicrotask(() => senderDataHandler?.(frame));
            }
        },
        onData: (handler) => {
            senderDataHandler = handler;
            return () => { senderDataHandler = null; };
        },
        channel: makeBufferChannel(),
        sctpMaxMessageSize: null,
    };
}

describe('sender: rejection text is display-safe', () => {
    it('cleans and caps an incompatible reason', async () => {
        // 70 lines of an erase-line escape: 910 bytes once JSON-escaped, and
        // 350 characters after the invisible ones go, so the cap is exercised.
        const reason = '\u001b[2Kxx\n'.repeat(70);
        const errors: string[] = [];
        await sendFiles(scriptedDeps(() => incompatibleMessage(reason)),
            [{ id: 'x', file: makeFile(16, 'a.bin') }],
            { onError: (m) => errors.push(m) });
        expect(errors).toHaveLength(1);
        expect(errors[0].length).toBeLessThanOrEqual(300);
        expect(errors[0].endsWith('…')).toBe(true);
        expect(errors[0]).not.toContain('\u001b');
        expect(errors[0]).not.toContain('\n');
    });

    it('cleans the version string in an ack that fails the compat check', async () => {
        const ver = 'v\u202e' + 'x'.repeat(850);
        const errors: string[] = [];
        await sendFiles(
            scriptedDeps((id) => JSON.stringify({ type: 'ack', id, offset: 0, pv: 2, pvMin: 2, ver })),
            [{ id: 'x', file: makeFile(16, 'a.bin') }],
            { onError: (m) => errors.push(m) });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('Cannot transfer');
        expect(errors[0]).not.toContain('\u202e');
    });
});

/**
 * The ack's offset is the receiver's word for how much of the file it already
 * has, cast straight off the wire. A negative one used to make the chunk loop
 * spin forever on empty slabs, and one past the end sent an end marker after
 * zero bytes. Each test carries a 5 s timeout because the failure mode is a hang.
 */
describe('sender: resume offset from the receiver', () => {
    it('refuses a negative offset instead of spinning forever', async () => {
        const errors: string[] = [];
        const sent: string[] = [];
        await sendFiles(
            scriptedDeps((id) => ackMessage(id, -1e9), sent),
            [{ id: 'x', file: makeFile(16, 'a.bin') }],
            { onError: (m) => errors.push(m) });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('-1000000000');
        expect(sent.some((f) => f.includes('"end"'))).toBe(false);
    }, 5000);

    it('refuses an offset past the end of the file', async () => {
        const errors: string[] = [];
        const sent: string[] = [];
        await sendFiles(
            scriptedDeps((id) => ackMessage(id, 17), sent),
            [{ id: 'x', file: makeFile(16, 'a.bin') }],
            { onError: (m) => errors.push(m) });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('17');
        expect(sent.some((f) => f.includes('"end"'))).toBe(false);
    }, 5000);

    it('still accepts a resume from inside the file', async () => {
        const errors: string[] = [];
        const sent: string[] = [];
        await sendFiles(
            scriptedDeps((id) => ackMessage(id, 8), sent),
            [{ id: 'x', file: makeFile(16, 'a.bin') }],
            { onError: (m) => errors.push(m) });
        expect(errors).toEqual([]);
        expect(sent.some((f) => f.includes('"end"'))).toBe(true);
    }, 5000);
});

/**
 * A file that becomes unreadable mid-send used to `break` out of the read loop
 * and fall through to the unconditional end marker, so the sender announced a
 * finished file after a short byte count and both sides showed success.
 */
describe('sender: unreadable file', () => {
    it('reports an error and never announces the file as done', async () => {
        let sawEnd = false;
        const errors: string[] = [];
        let allSent = false;

        // Rejects on the first slab read, the way a moved file, an unplugged
        // drive, or an evicted cloud placeholder does.
        const bad = {
            name: 'gone.bin',
            size: 4096,
            slice: () => ({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) }),
        } as unknown as File;

        // The sender blocks on the ack before it reads anything, so the harness
        // has to answer it or the test just waits out the ack timeout.
        let senderDataHandler: ((d: string | Uint8Array | ArrayBuffer) => void) | null = null;

        const deps: SenderDeps = {
            send: (d) => {
                if (typeof d !== 'string') return;
                if (d.includes('"end"')) sawEnd = true;
                const parsed = JSON.parse(d) as { type: string; id?: string };
                if (parsed.type === 'metadata' && parsed.id) {
                    const ack = enc.encode(ackMessage(parsed.id, 0));
                    queueMicrotask(() => senderDataHandler?.(ack));
                }
            },
            onData: (handler) => {
                senderDataHandler = handler;
                return () => { senderDataHandler = null; };
            },
            channel: makeBufferChannel(),
            sctpMaxMessageSize: null,
        };

        await sendFiles(deps, [{ file: bad, id: 'x' }], {
            onError: (m) => errors.push(m),
            onAllSent: () => { allSent = true; },
        });

        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('gone.bin');
        // The bug: this used to be true, so the receiver was told the file was
        // finished after a short byte count.
        expect(sawEnd).toBe(false);
        expect(allSent).toBe(false);
    });
});

/**
 * One control listener for the whole session (P0-18). The per-file ack wait used
 * to be the only listener, so a refusal that arrived after `end` or between
 * chunks was never seen, and a closed channel left the ack wait running for its
 * full 120 s.
 */
describe('sender: session control listener', () => {
    // Loopback deps whose receiver acks every metadata and lets a test script
    // react to later frames. `deliver` pushes a receiver-to-sender frame the
    // way a Go receiver sends it (binary).
    function sessionDeps(opts: {
        onEnd?: (deliver: (frame: string) => void) => void;
        onChunk?: (n: number, deliver: (frame: string) => void) => void;
        ack?: boolean;
    } = {}) {
        let handler: ((d: string | Uint8Array | ArrayBuffer) => void) | null = null;
        let offs = 0;
        const closeHandlers: Array<() => void> = [];
        const sent = { strings: [] as string[], chunks: 0 };
        const deliver = (frame: string) => queueMicrotask(() => handler?.(enc.encode(frame)));
        const channel = {
            bufferedAmount: 0,
            bufferedAmountLowThreshold: 0,
            addEventListener: (type: string, h: () => void) => { if (type === 'close') closeHandlers.push(h); },
            removeEventListener: (type: string, h: () => void) => {
                const i = closeHandlers.indexOf(h);
                if (type === 'close' && i >= 0) closeHandlers.splice(i, 1);
            },
        };
        const deps: SenderDeps = {
            send: (d) => {
                if (typeof d !== 'string') {
                    sent.chunks += 1;
                    opts.onChunk?.(sent.chunks, deliver);
                    return;
                }
                sent.strings.push(d);
                const parsed = JSON.parse(d) as { type: string; id?: string };
                if (parsed.type === 'metadata' && parsed.id && opts.ack !== false) deliver(ackMessage(parsed.id, 0));
                if (parsed.type === 'end') opts.onEnd?.(deliver);
            },
            onData: (h) => {
                handler = h;
                return () => { handler = null; offs += 1; };
            },
            channel,
            sctpMaxMessageSize: null,
        };
        return {
            deps,
            sent,
            // A frame delivered after sendFiles resolved, which is what a CLI
            // receiver's late refusal and its `received` both are.
            deliver,
            // How many times the session's own unsubscribe ran.
            offs: () => offs,
            close: () => closeHandlers.slice().forEach((h) => h()),
        };
    }

    const refusal = (fields: Record<string, unknown>) =>
        JSON.stringify({ type: 'incompatible', reason: 'receiver stopped', pv: 1, pvMin: 1, ...fields });

    it('incompatible after end surfaces', async () => {
        const errors: string[] = [];
        let allSent = false;
        const s = sessionDeps({ onEnd: (deliver) => deliver(refusal({ code: 'write-failed', saved: 0 })) });
        await sendFiles(s.deps, [{ id: 'a', file: makeFile(16, 'a.bin') }], {
            onError: (m) => errors.push(m),
            onAllSent: () => { allSent = true; },
        });
        expect(errors).toEqual(['receiver stopped']);
        expect(allSent).toBe(false);
    });

    it('incompatible during chunks stops the loop', async () => {
        // Two read slabs: the refusal lands while the loop awaits the second
        // slab, so no chunk of it may be sent and no end marker either.
        const size = READ_SLAB + 3 * DEFAULT_CHUNK;
        const chunksInFirstSlab = Math.ceil(READ_SLAB / DEFAULT_CHUNK);
        const errors: string[] = [];
        let allSent = false;
        const s = sessionDeps({
            onChunk: (n, deliver) => { if (n === 1) deliver(refusal({ code: 'hash-mismatch', saved: 0 })); },
        });
        await sendFiles(s.deps, [{ id: 'a', file: makeFile(size, 'big.bin') }], {
            onError: (m) => errors.push(m),
            onAllSent: () => { allSent = true; },
        });
        expect(s.sent.chunks).toBe(chunksInFirstSlab);
        expect(s.sent.strings.some((f) => JSON.parse(f).type === 'end')).toBe(false);
        expect(errors).toEqual(['receiver stopped']);
        expect(allSent).toBe(false);
    });

    it('a closed channel ends the ack wait promptly', async () => {
        vi.useFakeTimers();
        try {
            const errors: string[] = [];
            const s = sessionDeps({ ack: false });
            let settled = false;
            const p = sendFiles(s.deps, [{ id: 'a', file: makeFile(16, 'a.bin') }], {
                onError: (m) => errors.push(m),
            }).then(() => { settled = true; });
            await vi.advanceTimersByTimeAsync(0);
            expect(settled).toBe(false);
            s.close();
            await vi.advanceTimersByTimeAsync(10);
            await p;
            expect(settled).toBe(true);
            expect(errors).toEqual(['Connection lost. The other device may have closed the tab.']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('onStopped reports an allowlisted code and a clamped saved count', async () => {
        const stops: Array<{ code: string | null; saved: number }> = [];
        const files = [
            { id: 'a', file: makeFile(16, 'a.bin') },
            { id: 'b', file: makeFile(16, 'b.bin') },
        ];
        const hostile = sessionDeps({ onEnd: (deliver) => deliver(refusal({ code: 'hash-mismatch', saved: 99 })) });
        await sendFiles(hostile.deps, files, { onStopped: (s) => stops.push(s), onError: () => {} });
        const unknown = sessionDeps({ onEnd: (deliver) => deliver(refusal({ code: '__proto__', saved: '3' })) });
        await sendFiles(unknown.deps, files, { onStopped: (s) => stops.push(s), onError: () => {} });
        expect(stops).toEqual([
            { code: 'hash-mismatch', saved: 2 },
            { code: null, saved: 0 },
        ]);
    });

    it('reads the count on a received frame only through the validator', async () => {
        let received = 0;
        const delivered: Array<{ files: number; verified: number | null; allVerified: boolean }> = [];
        const s = sessionDeps({ onEnd: (deliver) => deliver(JSON.stringify({ type: 'received', verified: 'x' })) });
        await sendFiles(s.deps, [{ id: 'a', file: makeFile(16, 'a.bin') }], {
            onReceived: () => { received += 1; },
            onDelivered: (d) => { delivered.push(d); },
        });
        expect(received).toBe(1);
        expect(delivered).toEqual([{ files: 1, verified: null, allVerified: false }]);
    });

    // The received frame arrives after the last file's end marker.
    async function deliveredFor(verified: unknown, fileCount: number) {
        const delivered: Array<{ files: number; verified: number | null; allVerified: boolean }> = [];
        let ends = 0;
        const s = sessionDeps({
            onEnd: (deliver) => {
                ends += 1;
                if (ends === fileCount) deliver(JSON.stringify({ type: 'received', verified }));
            },
        });
        const files = Array.from({ length: fileCount }, (_, i) => ({ id: 'f' + i, file: makeFile(8, 'f' + i + '.bin') }));
        await sendFiles(s.deps, files, { onDelivered: (d) => { delivered.push(d); } });
        return delivered;
    }

    it('verified below the count is not reported as matched', async () => {
        expect(await deliveredFor(2, 3)).toEqual([{ files: 3, verified: 2, allVerified: false }]);
        expect(await deliveredFor(3, 3)).toEqual([{ files: 3, verified: 3, allVerified: true }]);
    });

    it('verified above the count is absent', async () => {
        expect(await deliveredFor(999, 3)).toEqual([{ files: 3, verified: null, allVerified: false }]);
    });

    // F-SHA-4. sendFiles resolves at onAllSent and hands the session to
    // lingerUntilDone, so the one control listener outlives the send. Before
    // this the finally called session.close() the moment the last byte was
    // acknowledged, and a CLI receiver's refusal (about CONTROL_FLUSH_MS later)
    // was dropped while the page went on saying "All Files Sent!".
    const settleTick = () => new Promise((r) => setTimeout(r, 20));

    it('reports a refusal that lands after onAllSent through onError and onStopped', async () => {
        const errors: string[] = [];
        const stops: Array<{ code: string | null; saved: number }> = [];
        const s = sessionDeps();
        let allSent = false;
        await sendFiles(s.deps, [{ id: 'a', file: makeFile(16, 'a.bin') }], {
            onError: (m) => errors.push(m),
            onStopped: (st) => stops.push(st),
            onAllSent: () => { allSent = true; },
        });
        expect(allSent).toBe(true);
        expect(stops).toEqual([]);

        await settleTick();
        s.deliver(refusal({ code: 'hash-mismatch', saved: 0 }));
        await settleTick();
        expect(stops).toEqual([{ code: 'hash-mismatch', saved: 0 }]);
        expect(errors).toEqual(['receiver stopped']);
    });

    it('detaches the lingering listener on received, on close and once destroyed', async () => {
        const file = () => [{ id: 'a', file: makeFile(16, 'a.bin') }];

        const onReceived = sessionDeps();
        await sendFiles(onReceived.deps, file(), {});
        expect(onReceived.offs()).toBe(0);
        onReceived.deliver('{"type":"received"}');
        await settleTick();
        expect(onReceived.offs()).toBe(1);

        const onClose = sessionDeps();
        await sendFiles(onClose.deps, file(), {});
        expect(onClose.offs()).toBe(0);
        onClose.close();
        await settleTick();
        expect(onClose.offs()).toBe(1);

        // Nothing fires on a destroyed peer, so this arm is the poll's.
        const onDestroy = sessionDeps();
        let gone = false;
        await sendFiles(onDestroy.deps, file(), { isDestroyed: () => gone });
        expect(onDestroy.offs()).toBe(0);
        gone = true;
        // Longer than DIGEST_STOP_POLL_MS (200 ms), which is not exported.
        await new Promise((r) => setTimeout(r, 300));
        expect(onDestroy.offs()).toBe(1);
    });

    it('a refusal after onAllSent never reaches onStopped twice', async () => {
        const stops: Array<{ code: string | null; saved: number }> = [];
        const errors: string[] = [];
        const s = sessionDeps();
        await sendFiles(s.deps, [{ id: 'a', file: makeFile(16, 'a.bin') }], {
            onStopped: (st) => stops.push(st),
            onError: (m) => errors.push(m),
        });
        s.deliver(refusal({ code: 'hash-mismatch', saved: 0 }));
        s.deliver(refusal({ code: 'write-failed', saved: 1 }));
        await settleTick();
        expect(stops).toEqual([{ code: 'hash-mismatch', saved: 0 }]);
        expect(errors).toEqual(['receiver stopped']);
    });
});

describe('sender: per-file SHA-256 on end', () => {
    const DIGEST = 'ab'.repeat(32);

    // A loopback receiver that acks every metadata at `ackOffset` and lets a test
    // react to chunks. Records every string frame the sender sends.
    function hashDeps(opts: {
        ackOffset?: number;
        hashBlob?: SenderDeps['hashBlob'];
        hashBoundMs?: SenderDeps['hashBoundMs'];
        onChunk?: (n: number, deliver: (frame: string) => void) => void;
    } = {}) {
        let handler: ((d: string | Uint8Array | ArrayBuffer) => void) | null = null;
        const strings: string[] = [];
        let chunks = 0;
        const deliver = (frame: string) => queueMicrotask(() => handler?.(enc.encode(frame)));
        const deps: SenderDeps = {
            send: (d) => {
                if (typeof d !== 'string') {
                    chunks += 1;
                    opts.onChunk?.(chunks, deliver);
                    return;
                }
                strings.push(d);
                const parsed = JSON.parse(d) as { type: string; id?: string };
                if (parsed.type === 'metadata' && parsed.id) deliver(ackMessage(parsed.id, opts.ackOffset ?? 0));
            },
            onData: (h) => {
                handler = h;
                return () => { handler = null; };
            },
            channel: makeBufferChannel(),
            sctpMaxMessageSize: null,
            hashBlob: opts.hashBlob,
            hashBoundMs: opts.hashBoundMs,
        };
        const ends = () => strings.map((s) => JSON.parse(s) as { type: string; sha256?: string }).filter((m) => m.type === 'end');
        return { deps, ends, strings };
    }

    it('awaits the digest before end', async () => {
        const h = hashDeps({
            hashBlob: () => new Promise((resolve) => setTimeout(() => resolve(DIGEST), 20)),
        });
        await sendFiles(h.deps, [{ id: 'a', file: makeFile(16, 'a.bin') }], {}, { sendHashes: true });
        expect(h.ends()).toEqual([{ type: 'end', sha256: DIGEST }]);
        // type stays first on the wire.
        expect(h.strings.find((s) => s.includes('"end"'))!.startsWith('{"type":"end","sha256":"')).toBe(true);
    });

    it('omits sha256 when the hasher returns null', async () => {
        for (const hashBlob of [
            async () => null,
            async () => { throw new Error('worker died'); },
            () => { throw new Error('sync'); },
            async () => 'NOT-A-DIGEST',
        ] as Array<SenderDeps['hashBlob']>) {
            const h = hashDeps({ hashBlob });
            await sendFiles(h.deps, [{ id: 'a', file: makeFile(16, 'a.bin') }], {}, { sendHashes: true });
            expect(h.ends()).toEqual([{ type: 'end' }]);
        }
    });

    // CP0-F2. A hasher that never answers used to leave the digest wait pending
    // for the life of the page, so no end frame ever went out and the receiver
    // sat on a file it could not finish.
    it('sends end without a digest when the hasher outruns its bound', async () => {
        const h = hashDeps({
            hashBlob: () => new Promise<string | null>(() => {}),
            hashBoundMs: () => 10,
        });
        await sendFiles(h.deps, [{ id: 'a', file: makeFile(16, 'a.bin') }], {}, { sendHashes: true });
        // Exactly what an absent digest has always been, so both receivers fall
        // back to their byte-count check.
        expect(h.ends()).toEqual([{ type: 'end' }]);
        expect(h.strings.filter((s) => s.includes('"end"'))).toEqual(['{"type":"end"}']);
    });

    it('omits sha256 when hashing is off', async () => {
        let calls = 0;
        const h = hashDeps({ hashBlob: async () => { calls += 1; return DIGEST; } });
        await sendFiles(h.deps, [{ id: 'a', file: makeFile(16, 'a.bin') }], {}, { sendHashes: false });
        expect(calls).toBe(0);
        expect(h.ends()).toEqual([{ type: 'end' }]);
    });

    it('omits sha256 at a nonzero ack offset', async () => {
        let signal: AbortSignal | undefined;
        const h = hashDeps({
            ackOffset: 8,
            hashBlob: (_blob, s) => {
                signal = s;
                return Promise.resolve(DIGEST);
            },
        });
        await sendFiles(h.deps, [{ id: 'a', file: makeFile(16, 'a.bin') }], {}, { sendHashes: true });
        expect(h.ends()).toEqual([{ type: 'end' }]);
        expect(signal?.aborted).toBe(true);
    });

    it('sends no end after a refusal that arrives while the digest is pending', async () => {
        const errors: string[] = [];
        const h = hashDeps({
            hashBlob: () => new Promise((resolve) => setTimeout(() => resolve(DIGEST), 30)),
            // The last and only chunk draws a refusal, which lands during the digest wait.
            onChunk: (n, deliver) => {
                if (n === 1) deliver(JSON.stringify({ type: 'incompatible', reason: 'receiver stopped', pv: 1, pvMin: 1 }));
            },
        });
        await sendFiles(h.deps, [{ id: 'a', file: makeFile(16, 'a.bin') }], { onError: (m) => errors.push(m) }, { sendHashes: true });
        expect(errors).toHaveLength(1);
        expect(h.ends()).toEqual([]);
    });

    it('ends the send when a refusal lands after the last chunk and the digest never finishes', async () => {
        // The refusal rides the file's only chunk, so no loop iteration is left
        // to notice it, and the hash never resolves on its own: a plain await
        // here would hold the send open for the life of the page while the
        // worker read the rest of the file.
        let signal: AbortSignal | undefined;
        const errors: string[] = [];
        const h = hashDeps({
            hashBlob: (_blob, s) => {
                signal = s;
                return new Promise(() => { });
            },
            onChunk: (n, deliver) => {
                if (n === 1) deliver(JSON.stringify({ type: 'incompatible', reason: 'receiver stopped', pv: 1, pvMin: 1 }));
            },
        });
        const started = Date.now();
        await sendFiles(h.deps, [{ id: 'a', file: makeFile(16, 'a.bin') }], { onError: (m) => errors.push(m) }, { sendHashes: true });
        expect(errors).toHaveLength(1);
        expect(h.ends()).toEqual([]);
        expect(signal?.aborted).toBe(true);
        // The wait polls every 200 ms; a plain await would never return here.
        expect(Date.now() - started).toBeLessThan(3000);
    });

    it('aborts hashing when the transfer stops', async () => {
        let signal: AbortSignal | undefined;
        const errors: string[] = [];
        const h = hashDeps({
            // A hash that would never finish on its own.
            hashBlob: (_blob, s) => {
                signal = s;
                return new Promise(() => { });
            },
            onChunk: (n, deliver) => {
                if (n === 1) deliver(JSON.stringify({ type: 'incompatible', reason: 'receiver stopped', pv: 1, pvMin: 1 }));
            },
        });
        const size = READ_SLAB + 3 * DEFAULT_CHUNK;
        await sendFiles(h.deps, [{ id: 'a', file: makeFile(size, 'big.bin') }], { onError: (m) => errors.push(m) }, { sendHashes: true });
        expect(errors).toHaveLength(1);
        expect(h.ends()).toEqual([]);
        expect(signal?.aborted).toBe(true);
    });
});
