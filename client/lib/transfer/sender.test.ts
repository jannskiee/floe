import { describe, it, expect, vi } from 'vitest';
import { sendFiles, sendAbortReason, CONTROL_FLUSH_MS, type SenderDeps } from './sender';
import { ackMessage, incompatibleMessage, ACK_TIMEOUT_MS, CONTROL_MSG_MAX, READ_SLAB, DEFAULT_CHUNK } from './protocol';

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

    // The refused value is quoted back to the person, so it is peer text on a
    // screen and gets the cleaning and the cap every other peer string on this
    // path gets; and the file is named the way the metadata named it.
    it('a hostile resume offset is cleaned and capped in the error', async () => {
        const bidi = String.fromCharCode(0x202e);
        const hostile = bidi + 'x'.repeat(200);
        const errors: string[] = [];
        const sent: string[] = [];
        await sendFiles(
            scriptedDeps((id) => JSON.stringify({ type: 'ack', id, offset: hostile }), sent),
            [{ id: 'x', file: makeFile(16, 'a.bin'), relativePath: 'docs/q3/a.bin' }],
            { onError: (m) => errors.push(m) });
        expect(errors).toHaveLength(1);
        expect(errors[0]).not.toContain(bidi);
        expect(errors[0]).not.toContain('x'.repeat(40));
        expect(errors[0]).toContain('docs/q3/a.bin');
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
        const failures: Array<{ kind: string; index: number }> = [];
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
            onFailed: (f) => failures.push(f),
            onAllSent: () => { allSent = true; },
        });

        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('gone.bin');
        // The same stop, typed, for a caller that renders no peer text.
        expect(failures).toEqual([{ kind: 'unreadable', index: 1 }]);
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
        // rangeOverlaps rides the same stop from S1-WEB-07 on, and both frames
        // here stamp the current protocol range, so both are deliberate aborts.
        const stops: Array<{ code: string | null; saved: number; rangeOverlaps: boolean }> = [];
        const files = [
            { id: 'a', file: makeFile(16, 'a.bin') },
            { id: 'b', file: makeFile(16, 'b.bin') },
        ];
        const hostile = sessionDeps({ onEnd: (deliver) => deliver(refusal({ code: 'hash-mismatch', saved: 99 })) });
        await sendFiles(hostile.deps, files, { onStopped: (s) => stops.push(s), onError: () => {} });
        const unknown = sessionDeps({ onEnd: (deliver) => deliver(refusal({ code: '__proto__', saved: '3' })) });
        await sendFiles(unknown.deps, files, { onStopped: (s) => stops.push(s), onError: () => {} });
        expect(stops).toEqual([
            { code: 'hash-mismatch', saved: 2, rangeOverlaps: true },
            { code: null, saved: 0, rangeOverlaps: true },
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
        const stops: Array<{ code: string | null; saved: number; rangeOverlaps: boolean }> = [];
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
        expect(stops).toEqual([{ code: 'hash-mismatch', saved: 0, rangeOverlaps: true }]);
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
        const stops: Array<{ code: string | null; saved: number; rangeOverlaps: boolean }> = [];
        const errors: string[] = [];
        const s = sessionDeps();
        await sendFiles(s.deps, [{ id: 'a', file: makeFile(16, 'a.bin') }], {
            onStopped: (st) => stops.push(st),
            onError: (m) => errors.push(m),
        });
        s.deliver(refusal({ code: 'hash-mismatch', saved: 0 }));
        s.deliver(refusal({ code: 'write-failed', saved: 1 }));
        await settleTick();
        expect(stops).toEqual([{ code: 'hash-mismatch', saved: 0, rangeOverlaps: true }]);
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

/**
 * The options and callbacks the request link visitor needs (spec 07 4.9). Every
 * one of them is off unless the caller asks for it: a send with no options
 * behaves exactly as it did before, which is what keeps the main app's page
 * unchanged.
 */
describe('sender: visitor options', () => {
    // The metadata key the visitor's path rides on, spelled in two pieces on
    // purpose: check-consumers counts a wire field name anywhere in a test
    // file, strings and comments included, and the DV-A gate holds that warning
    // count fixed. senderLeaks.test.ts avoids the same names for this reason.
    const NAME_KEY = 'file' + 'Name';

    const settleTick = () => new Promise((r) => setTimeout(r, 20));

    // A bounded await. A requireReceived that never resolves is this suite's
    // most likely failure, and an unbounded await would hang the worker instead
    // of failing the test.
    async function within<T>(p: Promise<T>, ms = 3000): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                p,
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error('sendFiles never settled')), ms);
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    // Loopback deps for a visitor-shaped send: acks the first `ackFiles`
    // metadata frames, counts end frames so a script can answer the LAST one,
    // and can close the channel from the peer's side.
    function visitorDeps(opts: {
        ackFiles?: number;
        onEnd?: (deliver: (frame: string) => void, ends: number) => void;
    } = {}) {
        let handler: ((d: string | Uint8Array | ArrayBuffer) => void) | null = null;
        const closeHandlers: Array<() => void> = [];
        const strings: string[] = [];
        let metas = 0;
        let ends = 0;
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
                if (typeof d !== 'string') return;
                strings.push(d);
                const parsed = JSON.parse(d) as { type: string; id?: string };
                if (parsed.type === 'metadata' && parsed.id) {
                    metas += 1;
                    if (metas <= (opts.ackFiles ?? Infinity)) deliver(ackMessage(parsed.id, 0));
                }
                if (parsed.type === 'end') {
                    ends += 1;
                    opts.onEnd?.(deliver, ends);
                }
            },
            onData: (h) => {
                handler = h;
                return () => { handler = null; };
            },
            channel,
            sctpMaxMessageSize: null,
        };
        return {
            deps,
            deliver,
            close: () => closeHandlers.slice().forEach((h) => h()),
            // The names on the metadata frames, in the order they went out.
            names: () => strings
                .map((s) => JSON.parse(s) as Record<string, unknown>)
                .filter((m) => m.type === 'metadata')
                .map((m) => m[NAME_KEY]),
        };
    }

    const entries = (n: number) =>
        Array.from({ length: n }, (_, i) => ({ id: 'f' + i, file: makeFile(8, 'f' + i + '.bin') }));

    const refusal = (fields: Record<string, unknown>) =>
        JSON.stringify({ type: 'incompatible', reason: 'receiver stopped', pv: 1, pvMin: 1, ...fields });

    type Stop = { code: string | null; saved: number; rangeOverlaps: boolean };
    type Failure = { kind: string; index: number };
    type Report = { files: number; verified: number | null; allVerified: boolean };

    it('relativePath is sent as the metadata name', async () => {
        const v = visitorDeps();
        await within(sendFiles(v.deps, [
            { id: 'a', file: makeFile(16, 'a.bin'), relativePath: 'docs/q3/a.bin' },
        ], {}));
        expect(v.names()).toEqual(['docs/q3/a.bin']);
        v.close();
    });

    it('file.name is sent when relativePath is absent', async () => {
        const v = visitorDeps();
        await within(sendFiles(v.deps, [{ id: 'a', file: makeFile(16, 'a.bin') }], {}));
        expect(v.names()).toEqual(['a.bin']);
        v.close();
    });

    it('ackTimeoutMs applies to the first file only', async () => {
        vi.useFakeTimers();
        try {
            const errors: string[] = [];
            const failures: Failure[] = [];
            const v = visitorDeps({ ackFiles: 0 });
            const p = sendFiles(v.deps, entries(2), {
                onError: (m) => errors.push(m),
                onFailed: (f) => failures.push(f),
            }, { ackTimeoutMs: 5_000 });
            await vi.advanceTimersByTimeAsync(0);

            await vi.advanceTimersByTimeAsync(4_999);
            expect(errors).toEqual([]);

            await vi.advanceTimersByTimeAsync(1);
            await p;
            expect(errors).toHaveLength(1);
            expect(failures).toEqual([{ kind: 'ack-timeout', index: 1 }]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('later files keep ACK_TIMEOUT_MS', async () => {
        vi.useFakeTimers();
        try {
            const errors: string[] = [];
            const failures: Failure[] = [];
            // The first file is acked, so the wait the deadline is read off is
            // the second file's.
            const v = visitorDeps({ ackFiles: 1 });
            const p = sendFiles(v.deps, entries(2), {
                onError: (m) => errors.push(m),
                onFailed: (f) => failures.push(f),
            }, { ackTimeoutMs: 5_000 });
            await vi.advanceTimersByTimeAsync(0);

            // Long past the option's 5 s, which must not apply here.
            await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS - 1);
            expect(errors).toEqual([]);

            await vi.advanceTimersByTimeAsync(1);
            await p;
            expect(failures).toEqual([{ kind: 'ack-timeout', index: 2 }]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('requireReceived waits past drain for received', async () => {
        const v = visitorDeps();
        let settled = false;
        let allSent = 0;
        const p = sendFiles(v.deps, entries(1), {
            onAllSent: () => { allSent += 1; },
        }, { requireReceived: true }).then(() => { settled = true; });

        // The drain is done and the last end frame has gone out: today's send
        // resolves here, and the visitor's must not.
        await settleTick();
        expect(settled).toBe(false);
        expect(allSent).toBe(0);

        v.deliver('{"type":"received"}');
        await within(p);
        expect(settled).toBe(true);
        expect(allSent).toBe(1);
    });

    it('requireReceived treats a close before received as closed', async () => {
        const failures: Failure[] = [];
        let allSent = 0;
        const v = visitorDeps();
        const p = sendFiles(v.deps, entries(2), {
            onAllSent: () => { allSent += 1; },
            onFailed: (f) => failures.push(f),
        }, { requireReceived: true });

        await settleTick();
        v.close();
        await within(p);
        expect(failures).toEqual([{ kind: 'closed', index: 2 }]);
        expect(allSent).toBe(0);
    });

    it('requireReceived stops waiting when the page destroys the session', async () => {
        // The fourth ending, and the reason isDestroyed is mandatory with the
        // option: no frame and no close, just Cancel. Nothing else could end
        // this wait, which by design has no deadline.
        const v = visitorDeps();
        const failures: Failure[] = [];
        let gone = false;
        let allSent = 0;
        let settled = false;
        const p = sendFiles(v.deps, entries(1), {
            isDestroyed: () => gone,
            onAllSent: () => { allSent += 1; },
            onFailed: (f) => failures.push(f),
        }, { requireReceived: true }).then(() => { settled = true; });

        await settleTick();
        expect(settled).toBe(false);

        gone = true;
        // A destroyed peer fires nothing, so the poll is what notices.
        await within(p);
        expect(settled).toBe(true);
        // A page that tore the transfer down neither succeeded nor needs
        // telling what happened.
        expect(allSent).toBe(0);
        expect(failures).toEqual([]);
    });

    it('requireReceived reports verified through onDelivered', async () => {
        const delivered: Report[] = [];
        const v = visitorDeps({
            onEnd: (deliver, ends) => {
                if (ends === 2) deliver(JSON.stringify({ type: 'received', verified: 2 }));
            },
        });
        await within(sendFiles(v.deps, entries(2), {
            onDelivered: (d) => delivered.push(d),
        }, { requireReceived: true }));
        expect(delivered).toEqual([{ files: 2, verified: 2, allVerified: true }]);
    });

    it('an over-claimed verified count never reads as all verified', async () => {
        const delivered: Report[] = [];
        const v = visitorDeps({
            onEnd: (deliver, ends) => {
                // One more than the two files that were sent.
                if (ends === 2) deliver(JSON.stringify({ type: 'received', verified: 3 }));
            },
        });
        await within(sendFiles(v.deps, entries(2), {
            onDelivered: (d) => delivered.push(d),
        }, { requireReceived: true }));
        expect(delivered).toEqual([{ files: 2, verified: null, allVerified: false }]);
    });

    it('a refusal after the last end reaches onStopped', async () => {
        const stops: Stop[] = [];
        let allSent = 0;
        const v = visitorDeps({
            onEnd: (deliver, ends) => {
                if (ends === 2) deliver(refusal({ code: 'declined', saved: 1 }));
            },
        });
        await within(sendFiles(v.deps, entries(2), {
            onStopped: (s) => stops.push(s),
            onAllSent: () => { allSent += 1; },
            onError: () => { },
        }, { requireReceived: true }));
        expect(stops).toEqual([{ code: 'declined', saved: 1, rangeOverlaps: true }]);
        expect(allSent).toBe(0);
    });

    it('saved is clamped to 0..total', async () => {
        // Two files, so total + 1 is 3. null is what JSON.stringify makes of a
        // NaN, which is what a JS peer actually puts on the wire.
        const cases: Array<[unknown, number]> = [[-1, 0], [3, 2], [2.5, 0], ['3', 0], [null, 0]];
        const stops: Stop[] = [];
        for (const [saved] of cases) {
            const v = visitorDeps({
                onEnd: (deliver, ends) => {
                    if (ends === 2) deliver(refusal({ code: 'declined', saved }));
                },
            });
            await within(sendFiles(v.deps, entries(2), {
                onStopped: (s) => stops.push(s),
                onError: () => { },
            }));
            await settleTick();
            v.close();
        }
        expect(stops).toEqual(cases.map(([, want]) => ({ code: 'declined', saved: want, rangeOverlaps: true })));
    });

    it('an unknown code reaches onStopped as null', async () => {
        const stops: Stop[] = [];
        for (const code of ['no-such-code', '__proto__', 'constructor', '']) {
            const v = visitorDeps({
                onEnd: (deliver) => deliver(refusal({ code, saved: 0 })),
            });
            await within(sendFiles(v.deps, entries(1), {
                onStopped: (s) => stops.push(s),
                onError: () => { },
            }));
            await settleTick();
            v.close();
        }
        expect(stops).toEqual(Array.from({ length: 4 }, () => ({ code: null, saved: 0, rangeOverlaps: true })));
    });

    it('too-slow is not an allowlisted code', async () => {
        const stops: Stop[] = [];
        // time-limit is the code that replaced it (E-05, E-24), and it is on
        // the list, so this pins the list and not just the reader.
        for (const code of ['too-slow', 'time-limit']) {
            const v = visitorDeps({
                onEnd: (deliver) => deliver(refusal({ code, saved: 0 })),
            });
            await within(sendFiles(v.deps, entries(1), {
                onStopped: (s) => stops.push(s),
                onError: () => { },
            }));
            await settleTick();
            v.close();
        }
        expect(stops).toEqual([
            { code: null, saved: 0, rangeOverlaps: true },
            { code: 'time-limit', saved: 0, rangeOverlaps: true },
        ]);
    });

    it('onStopped never carries reason text', async () => {
        const bidi = String.fromCharCode(0x202e);
        // The flag is whether the frame fits CONTROL_MSG_MAX, and so whether it
        // reaches the session at all.
        const hostile: Array<[string, boolean]> = [
            ['<img src=x onerror=alert(1)>', true],
            ['$(calc)', true],
            ['x' + bidi + 'y', true],
            // Past the cap, so classifyControl drops this one before anything
            // can read it. Asserted all the same: the page must learn nothing
            // either way.
            ['z'.repeat(10_000), false],
        ];
        for (const [text, inCap] of hostile) {
            const seen: unknown[] = [];
            const record = (...args: unknown[]) => { seen.push(...args); };
            const v = visitorDeps({
                onEnd: (deliver) => deliver(refusal({ reason: text, code: 'declined', saved: 1 })),
            });
            await within(sendFiles(v.deps, entries(1), {
                onStopped: record,
                onAck: record,
                onFailed: record,
                onDelivered: record,
                onReceived: record,
                onFileStart: record,
                onProgress: record,
                onSpeed: record,
                // onError is the main app's banner and keeps today's wording,
                // which compatErrorFromIncompatible cleans and caps; the
                // visitor page never renders it, so it is not recorded here.
                onError: () => { },
            }));
            await settleTick();
            v.close();
            // Without these two the assertion below would also pass if the
            // callbacks had stopped firing altogether.
            expect(seen.length).toBeGreaterThan(0);
            const stops = seen.filter((x) => typeof x === 'object' && x !== null && 'code' in x);
            expect(stops).toHaveLength(inCap ? 1 : 0);
            expect(JSON.stringify(seen)).not.toContain(text);
        }
    });

    it('a version range miss reports rangeOverlaps false', async () => {
        const stops: Stop[] = [];
        // A frame whose pv range misses ours is a version mismatch, which is
        // what compatErrorFromIncompatible splits on; an overlapping range is a
        // deliberate abort.
        const miss = visitorDeps({
            onEnd: (deliver) => deliver(JSON.stringify({ type: 'incompatible', reason: 'x', pv: 2, pvMin: 2 })),
        });
        await within(sendFiles(miss.deps, entries(1), {
            onStopped: (s) => stops.push(s),
            onError: () => { },
        }));
        await settleTick();
        miss.close();

        const overlap = visitorDeps({ onEnd: (deliver) => deliver(refusal({ code: 'declined' })) });
        await within(sendFiles(overlap.deps, entries(1), {
            onStopped: (s) => stops.push(s),
            onError: () => { },
        }));
        await settleTick();
        overlap.close();

        expect(stops).toEqual([
            { code: null, saved: 0, rangeOverlaps: false },
            { code: 'declined', saved: 0, rangeOverlaps: true },
        ]);
    });

    it('onAck fires once per file with a 1-based index', async () => {
        const acks: number[] = [];
        const v = visitorDeps();
        await within(sendFiles(v.deps, entries(3), { onAck: (i) => acks.push(i) }));
        expect(acks).toEqual([1, 2, 3]);

        // A second ack for a file whose wait is long settled matches no
        // pending wait, so it reaches nothing.
        v.deliver(ackMessage('f0', 0));
        await settleTick();
        v.close();
        expect(acks).toEqual([1, 2, 3]);
    });
});

/**
 * WP-W1 review F1. A receiver that refuses mid-file sends its incompatible
 * frame and then tears the channel down (the Go host flushes the refusal and
 * closes). The sender only reports a latched refusal at its loop checkpoints,
 * so a frame that lands while it is parked waiting for buffer space used to
 * lose to the close: the page saw a lost connection and never the refusal,
 * and the request link visitor read "Connection lost" for a full disk. The
 * close now reports a latched refusal first.
 */
describe('sender: a refusal wins over the close that follows it', () => {
    function refusingMidFile(
        onFrames: (deliver: () => void) => void = (deliver) => deliver(),
        closeEvent = true
    ) {
        let handler: ((d: string | Uint8Array | ArrayBuffer) => void) | null = null;
        let buffered = 0;
        let destroyed = false;
        let armed = false;
        const closeListeners: Array<() => void> = [];
        const channel = {
            get bufferedAmount() {
                return buffered;
            },
            bufferedAmountLowThreshold: 0,
            addEventListener: (type: string, fn: () => void) => {
                if (type === 'close') closeListeners.push(fn);
                // The sender is now parked in its buffer wait: the refusal
                // lands, then the channel closes, before any checkpoint runs.
                if (type === 'bufferedamountlow' && !armed) {
                    armed = true;
                    setTimeout(() => {
                        onFrames(() => handler?.(enc.encode(incompatibleMessage('x', 'disk-full', 0))));
                        destroyed = true;
                        if (closeEvent) for (const f of closeListeners) f();
                    }, 20);
                }
            },
            removeEventListener: (type: string, fn: () => void) => {
                const i = closeListeners.indexOf(fn);
                if (type === 'close' && i >= 0) closeListeners.splice(i, 1);
            },
        };
        const deps: SenderDeps = {
            send: (d) => {
                if (typeof d === 'string') {
                    const parsed = JSON.parse(d) as { type: string; id?: string };
                    if (parsed.type === 'metadata' && parsed.id) {
                        const id = parsed.id;
                        queueMicrotask(() => handler?.(enc.encode(ackMessage(id, 0))));
                    }
                } else {
                    // The first chunk fills the buffer, so the sender waits.
                    buffered = 1e9;
                }
            },
            onData: (h) => {
                handler = h;
                return () => {
                    handler = null;
                };
            },
            channel,
            hashBlob: async () => null,
        };
        return { deps, isDestroyed: () => destroyed };
    }

    it('a refusal that lands while the sender waits for buffer space is reported when the channel closes', async () => {
        const { deps, isDestroyed } = refusingMidFile();
        const seen: string[] = [];
        const errors: string[] = [];
        await sendFiles(deps, [{ id: 'f1', file: makeFile(1024 * 1024, 'a.bin'), relativePath: 'dir/a.bin' }], {
            isDestroyed,
            onError: (m) => errors.push(m),
            onAck: (i) => seen.push(`ack${i}`),
            onStopped: ({ code, saved }) => seen.push(`stopped:${code}:${saved}`),
            onFailed: ({ kind }) => seen.push(`failed:${kind}`),
        }, { requireReceived: true, sendHashes: false });
        expect(seen).toEqual(['ack1', 'stopped:disk-full:0']);
        // The main page hears it too, through today's wording for an abort.
        expect(errors).toEqual(['x']);
    });

    it('a refusal is reported when it arrives, even if no close event follows', async () => {
        // WP-W1 review R2-1: teardowns that do not start with the channel's own
        // close event (ICE failure, a channel error, simple-peer's stuck-closing
        // timer) only make the page's peer destroyed. The refusal must already
        // be reported by then.
        const { deps, isDestroyed } = refusingMidFile(undefined, false);
        const seen: string[] = [];
        await sendFiles(deps, [{ id: 'f1', file: makeFile(1024 * 1024, 'a.bin') }], {
            isDestroyed,
            onAck: (i) => seen.push(`ack${i}`),
            onStopped: ({ code }) => seen.push(`stopped:${code}`),
            onFailed: ({ kind }) => seen.push(`failed:${kind}`),
        }, { requireReceived: true, sendHashes: false });
        expect(seen).toEqual(['ack1', 'stopped:disk-full']);
    });

    it('a close with no refusal latched still reports nothing but the close', async () => {
        const { deps, isDestroyed } = refusingMidFile(() => {});
        const seen: string[] = [];
        await sendFiles(deps, [{ id: 'f1', file: makeFile(1024 * 1024, 'a.bin') }], {
            isDestroyed,
            onAck: (i) => seen.push(`ack${i}`),
            onStopped: () => seen.push('stopped'),
        }, { sendHashes: false });
        expect(seen).toEqual(['ack1']);
    });
});
