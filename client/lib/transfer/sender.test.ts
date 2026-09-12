import { describe, it, expect } from 'vitest';
import { sendFiles, sendAbortReason, CONTROL_FLUSH_MS, type SenderDeps } from './sender';
import { ackMessage, incompatibleMessage, CONTROL_MSG_MAX } from './protocol';

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
        const channel = {
            bufferedAmount: 4096,
            bufferedAmountLowThreshold: 0,
            addEventListener: () => {},
            removeEventListener: () => {},
        };
        // Resolves on the CONTROL_FLUSH_MS deadline rather than never. A peer
        // that stopped acknowledging must not hold the teardown open.
        await Promise.race([
            sendAbortReason(() => {}, channel, 'why'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('sendAbortReason never resolved')), CONTROL_FLUSH_MS + 3000)),
        ]);
    }, CONTROL_FLUSH_MS + 5000);
});

/**
 * The rejection reason and the version string in an ack are peer-supplied and
 * used to land in the error banner verbatim. React escapes HTML, not control
 * characters or bidi marks, so the sender cleans and caps them first.
 */
// Loopback deps whose receiver side is scripted: `reply` builds the frame that
// answers the sender's metadata, delivered on a microtask like the loopback
// harness above so waitForAck is registered before it fires. `sent` collects
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
