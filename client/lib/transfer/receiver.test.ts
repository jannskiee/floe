import { describe, it, expect, vi, afterEach } from 'vitest';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createReceiver, OUT_OF_MEMORY_MESSAGE, INTERNAL_ERROR_MESSAGE, SPILL_BYTES, type ReceiveFailure } from './receiver';
import { metadataMessage, endMessage, incompatibleMessage, CONTROL_MSG_MAX, PROTOCOL_VERSION, MIN_PROTOCOL_VERSION, checkCompat } from './protocol';

const enc = new TextEncoder();

describe('receiver: stores tight copies of chunk bytes', () => {
    // Regression guard: simple-peer delivers data channel chunks as a Node Buffer,
    // whose `.slice()` is a non-copying VIEW over the (often larger/shared) backing
    // buffer. The receiver must copy out exactly each chunk's bytes, not retain the
    // whole backing buffer. This test feeds Buffer subarray views — exactly the
    // browser-runtime shape — which the old `buf.slice().buffer` code mishandled.
    it('reassembles chunks delivered as Buffer subarray views over a larger buffer', async () => {
        let completedBlob: Blob | null = null;
        const rx = createReceiver({
            send: () => { /* ack — ignored here */ },
            onFileComplete: (f) => { completedBlob = f.blob; },
        });

        const SIZE = 48;
        const fileBytes = new Uint8Array(SIZE);
        for (let i = 0; i < SIZE; i++) fileBytes[i] = i + 1; // never 0x7B at index 0

        // Metadata first so the receiver opens a partial download.
        rx.handleMessage(metadataMessage('rid', 'r.bin', SIZE, 1, 1, SIZE));

        // Place the payload inside a larger backing Buffer at a non-zero offset and
        // hand the receiver subarray VIEWS (16 bytes each) — sharing one backing AB.
        const backing = Buffer.alloc(200);
        for (let i = 0; i < SIZE; i++) backing[20 + i] = fileBytes[i];
        rx.handleMessage(backing.subarray(20, 36));
        rx.handleMessage(backing.subarray(36, 52));
        rx.handleMessage(backing.subarray(52, 68));

        rx.handleMessage(endMessage());

        expect(completedBlob).not.toBeNull();
        const got = new Uint8Array(await completedBlob!.arrayBuffer());
        expect(got.byteLength).toBe(SIZE);
        expect(got).toEqual(fileBytes);
    });
});

describe('receiver: onAllComplete fires once per transfer', () => {
    // Guards the global-counter fix: per-transfer side effects (stats report,
    // analytics, optimistic footer bump) must run exactly once with the summed
    // bytes — never once per file — so multi-file transfers are counted correctly
    // and are not partially dropped by the server's per-IP report rate limit.
    function feedFile(
        rx: { handleMessage: (d: string | Uint8Array | ArrayBuffer) => void },
        id: string,
        size: number,
        index: number,
        total: number,
    ) {
        rx.handleMessage(metadataMessage(id, `${id}.bin`, size, index, total, 0));
        const chunk = new Uint8Array(size);
        for (let i = 0; i < size; i++) chunk[i] = (i + 1) % 256; // never starts with '{'
        if (size > 0) rx.handleMessage(chunk);
        rx.handleMessage(endMessage());
    }

    it('fires a single time with the total bytes and file count for a 3-file transfer', () => {
        const calls: { totalBytes: number; fileCount: number }[] = [];
        const rx = createReceiver({
            send: () => { /* ack — ignored */ },
            onAllComplete: (totalBytes, fileCount) => calls.push({ totalBytes, fileCount }),
        });

        feedFile(rx, 'a', 100, 1, 3);
        expect(calls).toHaveLength(0); // not after the first file
        feedFile(rx, 'b', 200, 2, 3);
        expect(calls).toHaveLength(0); // not after the second file
        feedFile(rx, 'c', 300, 3, 3);

        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual({ totalBytes: 600, fileCount: 3 });
    });

    it('fires once for a single-file transfer (index === total === 1)', () => {
        const calls: { totalBytes: number; fileCount: number }[] = [];
        const rx = createReceiver({
            send: () => {},
            onAllComplete: (totalBytes, fileCount) => calls.push({ totalBytes, fileCount }),
        });

        feedFile(rx, 'only', 512, 1, 1);

        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual({ totalBytes: 512, fileCount: 1 });
    });
});

/**
 * A peer that stops on purpose has to say why, or the other side guesses.
 *
 * The reason travels on the existing `incompatible` frame with an OVERLAPPING
 * pv range, so no new message type and no ProtocolVersion bump. A peer reads
 * the overlap as "this is not about versions" and prints the reason verbatim
 * rather than replacing it with an update remedy.
 */
describe('receiver: a peer that stops on purpose says why', () => {
    function receiver() {
        const sent: (string | Uint8Array)[] = [];
        const errors: string[] = [];
        const completed: string[] = [];
        const rx = createReceiver({
            send: (d) => sent.push(d),
            onFileComplete: (f) => completed.push(f.fileName),
            onError: (m) => errors.push(m),
        });
        return { rx, sent, errors, completed };
    }

    it('surfaces the reason a sender sent instead of dropping the frame', () => {
        const h = receiver();
        h.rx.handleMessage(incompatibleMessage('Transfer blocked: relay connections are capped at 2 GB.'));
        expect(h.errors).toEqual(['Transfer blocked: relay connections are capped at 2 GB.']);
    });

    it('latches, so nothing that arrives after the reason reopens the transfer', () => {
        // peer.destroy() follows the reason a moment later and surfaces as
        // "User-Initiated Abort"; the component's latch is the other half of
        // this. Here: no later frame may restart the receive.
        const h = receiver();
        h.rx.handleMessage(incompatibleMessage('Transfer blocked: relay connections are capped at 2 GB.'));
        h.rx.handleMessage(metadataMessage('a', 'a.bin', 3, 1, 1, 3));
        h.rx.handleMessage(enc.encode('abc'));
        h.rx.handleMessage(endMessage());
        expect(h.errors).toHaveLength(1);
        expect(h.completed).toEqual([]);
    });

    it('does not print a version-mismatch frame as if it were a reason', () => {
        // A non-overlapping range means the frame IS about versions, and its
        // reason is written from the sender's point of view. Saying it back to
        // the receiver would name the wrong side.
        const h = receiver();
        h.rx.handleMessage(JSON.stringify({
            type: 'incompatible',
            reason: 'Cannot transfer: peer floe is too old.',
            pv: 99,
            pvMin: 99,
        }));
        expect(h.errors).toEqual(['The sender stopped the transfer.']);
    });

    it('tells the sender why a file was discarded', () => {
        // Without this the sender simply stops being acked: with more files to
        // send it waits out the full 120 s ack deadline and then reports a
        // timeout, which is the wrong cause two minutes late.
        const h = receiver();
        h.rx.handleMessage(metadataMessage('a', 'a.bin', 100, 1, 2, 200));
        h.rx.handleMessage(new Uint8Array(40));
        h.rx.handleMessage(endMessage());

        // [0] is the ack. The abort follows it, as BINARY, because nothing
        // travelling receiver to sender is file data.
        const abort = h.sent[h.sent.length - 1];
        expect(abort).toBeInstanceOf(Uint8Array);
        const parsed = JSON.parse(new TextDecoder().decode(abort as Uint8Array));
        expect(parsed.type).toBe('incompatible');
        expect(parsed.reason).toContain('receiver discarded a file');
        expect(parsed.reason).toContain('received 40 of 100 bytes');
        // The pv range has to OVERLAP ours, or the sender rebuilds the message
        // from pv/pvMin and prints an update remedy instead of the reason.
        expect(parsed.pv).toBe(PROTOCOL_VERSION);
        expect(parsed.pvMin).toBe(MIN_PROTOCOL_VERSION);
    });

    it('caps the whole encoded frame, not just the reason', () => {
        // A receiver stops classifying a control message past CONTROL_MSG_MAX
        // and would read the frame as file data.
        const frame = incompatibleMessage('very long prose. '.repeat(500));
        expect(new TextEncoder().encode(frame).byteLength).toBeLessThanOrEqual(CONTROL_MSG_MAX);
        const parsed = JSON.parse(frame);
        expect(parsed.type).toBe('incompatible');
        expect(parsed.reason.length).toBeGreaterThan(0);
    });
});

/**
 * Issue #283. The reason a receiver puts on the wire is read by the OTHER
 * side, so it has to name the sides from that side's point of view. The Go
 * receiver has done this since PR #282; the browser sent the same sentence it
 * showed itself, so a peer that displays the reason verbatim was told the
 * wrong side was old.
 *
 * Unreachable between shipped peers, which all speak protocol 1, so the fixture
 * drives a metadata frame claiming protocol 2.
 */
describe('receiver: the wire reason is written for the peer that reads it', () => {
    function receiver() {
        const sent: (string | Uint8Array)[] = [];
        const errors: string[] = [];
        const rx = createReceiver({
            send: (d) => sent.push(d),
            onError: (m) => errors.push(m),
        });
        return { rx, sent, errors };
    }

    function futureMetadata(): string {
        return JSON.stringify({
            type: 'metadata',
            id: 'a',
            fileName: 'a.bin',
            fileSize: 1,
            index: 1,
            total: 1,
            totalBytes: 1,
            pv: 2,
            pvMin: 2,
            ver: '1.11.0',
        });
    }

    it('sends the peer-perspective reason and shows itself the browser one', () => {
        // The defect, stated as one assertion pair: two different strings out
        // of one mismatch. Before the fix both of these were the same string.
        const h = receiver();
        h.rx.handleMessage(futureMetadata());

        const frame = h.sent[0];
        expect(frame).toBeInstanceOf(Uint8Array);
        const parsed = JSON.parse(new TextDecoder().decode(frame as Uint8Array));
        expect(parsed.type).toBe('incompatible');
        expect(parsed.reason).toContain("peer's floe is too old");
        expect(parsed.reason).toContain('You: protocol 2 (1.11.0)  Peer: protocol 1');
        expect(parsed.reason).toContain('Ask the other side to update Floe.');
        // The trap: a naive perspective flip reuses the browser's local
        // wording, which means nothing to a CLI or desktop reader.
        expect(parsed.reason).not.toContain('browser');
        expect(parsed.reason).not.toContain('Refresh the page');

        // What this browser shows itself is unchanged, and still browser-voiced.
        expect(h.errors).toHaveLength(1);
        expect(h.errors[0]).toContain('your browser is running an older version of Floe');
        expect(h.errors[0]).toContain('Refresh the page to get the latest version.');
    });

    it('names the side a rebuilding peer would name', () => {
        // The round trip, without hardcoding the answer: read the frame back
        // as the protocol-2 peer that sent the metadata, and check the reason
        // agrees with what that peer works out for itself from pv/pvMin.
        const h = receiver();
        h.rx.handleMessage(futureMetadata());
        const parsed = JSON.parse(new TextDecoder().decode(h.sent[0] as Uint8Array));

        const { ok, localTooOld } = checkCompat(2, 2, parsed.pvMin, parsed.pv);
        expect(ok).toBe(false);
        expect(localTooOld).toBe(false); // the reader is NEWER; we are the old one
        expect(parsed.reason).toContain("peer's floe is too old");
    });

    it('still carries our own pv range, so the frame stays classifiable', () => {
        const h = receiver();
        h.rx.handleMessage(futureMetadata());
        const parsed = JSON.parse(new TextDecoder().decode(h.sent[0] as Uint8Array));
        expect(parsed.pv).toBe(PROTOCOL_VERSION);
        expect(parsed.pvMin).toBe(MIN_PROTOCOL_VERSION);
        // Browser peers omit ver by design; docs/reference/transfer-protocol.mdx
        // states it as a wire fact, and a Go peer prints the range without a
        // parenthetical rather than an empty "()".
        expect(parsed.ver).toBeUndefined();
    });
});

/**
 * Framing, not content, decides whether a frame reaching a RECEIVER is control.
 *
 * classifyControl infers a frame's type from its bytes, so a whole small file
 * whose content is a control-shaped JSON object was consumed as control and
 * never written (#316). Before #311 that produced a 0-byte file that looked
 * complete; after it, a hard error and an aborted batch. Both are the same lost
 * bytes.
 *
 * Every Floe sender since v1.0.0 sends metadata and end as a TEXT frame and
 * file chunks as BINARY, so the wire already carried the answer. The browser
 * could not see it until the peer was given readableObjectMode, because
 * simple-peer Buffer.from()s text frames on the way through readable-stream.
 * These tests model the wire, which is what the loopback harness in
 * transfer.test.ts now does too.
 */
describe('receiver: framing decides, not content', () => {
    function receiver() {
        const files: Record<string, string> = {};
        const errors: string[] = [];
        const pending: Promise<void>[] = [];
        const rx = createReceiver({
            send: () => {},
            onFileComplete: (f) => {
                pending.push(
                    f.blob.arrayBuffer().then((ab) => {
                        files[f.fileName] = new TextDecoder().decode(new Uint8Array(ab));
                    }),
                );
            },
            onError: (m) => errors.push(m),
        });
        return { rx, files, errors, settle: () => Promise.all(pending) };
    }

    // Every control type Floe knows, as the entire content of a small file.
    // A binary frame is file data whatever its bytes spell.
    const controlShaped = [
        // The issue's own repro: 14 bytes, and a one-click send from Floe
        // Desktop's Send-text box.
        ['end', '{"type":"end"}'],
        ['received', '{"type":"received"}'],
        ['ack', '{"type":"ack","id":"x","offset":0}'],
        ['incompatible', '{"type":"incompatible","reason":"nope"}'],
        ['metadata', '{"type":"metadata","id":"a","fileName":"x","fileSize":1,"index":1,"total":1}'],
        ['padded end', '   {"type":"end"}'],
    ] as const;

    it.each(controlShaped)('writes a file whose whole content is a %s frame', async (_name, content) => {
        const h = receiver();
        const bytes = enc.encode(content);
        h.rx.handleMessage(metadataMessage('j', 'payload.json', bytes.byteLength, 1, 1, bytes.byteLength));
        h.rx.handleMessage(bytes);
        h.rx.handleMessage(endMessage());
        await h.settle();

        expect(h.errors).toEqual([]);
        expect(h.files['payload.json']).toBe(content);
    });

    it('does not derail the rest of the batch', async () => {
        // The failure people actually hit: one eaten frame also takes down every
        // file queued behind it.
        const h = receiver();
        const trap = enc.encode('{"type":"end"}');
        h.rx.handleMessage(metadataMessage('a', 'end.json', trap.byteLength, 1, 2, trap.byteLength + 3));
        h.rx.handleMessage(trap);
        h.rx.handleMessage(endMessage());
        h.rx.handleMessage(metadataMessage('b', 'after.txt', 3, 2, 2, trap.byteLength + 3));
        h.rx.handleMessage(enc.encode('abc'));
        h.rx.handleMessage(endMessage());
        await h.settle();

        expect(h.errors).toEqual([]);
        expect(Object.keys(h.files).sort()).toEqual(['after.txt', 'end.json']);
        expect(h.files['after.txt']).toBe('abc');
    });

    it('still honors a short end marker, which is what the truncation guard needs', async () => {
        // The reason the fix is framing and not "a control frame is only real
        // once the announced bytes have arrived": a legitimately short end
        // marker arrives while the budget is unsatisfied, and it is the exact
        // frame both truncation guards depend on. A position rule would turn
        // this precise error into a silent hang.
        const h = receiver();
        h.rx.handleMessage(metadataMessage('a', 'a.bin', 100, 1, 1, 100));
        h.rx.handleMessage(new Uint8Array(40));
        h.rx.handleMessage(endMessage());
        await h.settle();

        expect(h.errors).toHaveLength(1);
        expect(h.errors[0]).toContain('received 40 of 100 bytes');
        expect(h.files).toEqual({});
    });

    it('drops an unrecognized control type instead of writing it into the file', async () => {
        // The Go receiver has always done this. The browser used to append the
        // frame to whatever file was open, which is what made adding any new
        // frame type unsafe for a stale tab.
        const h = receiver();
        h.rx.handleMessage(metadataMessage('a', 'a.bin', 3, 1, 1, 3));
        h.rx.handleMessage(JSON.stringify({ type: 'somethingNew', reason: 'from a future Floe' }));
        h.rx.handleMessage(enc.encode('abc'));
        h.rx.handleMessage(endMessage());
        await h.settle();

        expect(h.errors).toEqual([]);
        expect(h.files['a.bin']).toBe('abc');
    });

    it('refuses an over-cap control message instead of appending it to the file', async () => {
        // Mirrors cli/engine/transfer/receiver.go. A deep enough folder path
        // produces a metadata frame past the cap, and the browser used to write
        // it into the file; the Go receiver has always rejected it.
        const h = receiver();
        h.rx.handleMessage(metadataMessage('a', 'a.bin', 3, 1, 1, 3));
        h.rx.handleMessage('{"type":"metadata","pad":"' + 'x'.repeat(CONTROL_MSG_MAX) + '"}');
        await h.settle();

        expect(h.errors).toHaveLength(1);
        expect(h.errors[0]).toContain(String(CONTROL_MSG_MAX));
        expect(h.files).toEqual({});
    });
});

/**
 * The receiver must refuse a file whose byte count does not match the size the
 * sender announced, matching cli/engine/transfer/receiver.go. Before this it
 * labelled the file with however many bytes arrived, so announced and actual
 * could never disagree and a truncated file was handed over as complete.
 */
describe('receiver: truncation guard', () => {
    // Feeds metadata announcing `announced` bytes but only delivers `actual`.
    function feedTruncated(
        rx: { handleMessage: (d: string | Uint8Array | ArrayBuffer) => void },
        id: string,
        announced: number,
        actual: number,
        index = 1,
        total = 1,
    ) {
        rx.handleMessage(metadataMessage(id, `${id}.bin`, announced, index, total, 0));
        if (actual > 0) {
            const chunk = new Uint8Array(actual);
            for (let i = 0; i < actual; i++) chunk[i] = (i + 1) % 256; // never starts with '{'
            rx.handleMessage(chunk);
        }
        rx.handleMessage(endMessage());
    }

    function harness() {
        const completed: string[] = [];
        const errors: string[] = [];
        const allComplete: number[] = [];
        const rx = createReceiver({
            send: () => {},
            onFileComplete: (f) => completed.push(f.fileName),
            onAllComplete: (bytes) => allComplete.push(bytes),
            onError: (m) => errors.push(m),
        });
        return { rx, completed, errors, allComplete };
    }

    it('refuses a file that arrived short', () => {
        const h = harness();
        feedTruncated(h.rx, 'a', 100, 60);
        expect(h.completed).toEqual([]);
        expect(h.errors).toHaveLength(1);
        expect(h.errors[0]).toContain('60');
        expect(h.errors[0]).toContain('100');
    });

    it('refuses a file that arrived long, so the guard is equality not a floor', () => {
        const h = harness();
        feedTruncated(h.rx, 'a', 50, 80);
        expect(h.completed).toEqual([]);
        expect(h.errors).toHaveLength(1);
        // Over-count is a frame-boundary problem, not a truncation, so the
        // message must not tell the user the transfer was cut short.
        expect(h.errors[0]).toContain('More data arrived');
        expect(h.errors[0]).not.toContain('cut short');
    });

    it('says the file was cut short only when it actually was', () => {
        const h = harness();
        feedTruncated(h.rx, 'a', 100, 60);
        expect(h.errors[0]).toContain('cut short');
    });

    it('does not report truncated bytes to the global counter', () => {
        const h = harness();
        feedTruncated(h.rx, 'a', 100, 60, 1, 1);
        expect(h.allComplete).toEqual([]);
    });

    it('stops the transfer instead of moving on to the next file', () => {
        const h = harness();
        feedTruncated(h.rx, 'a', 100, 60, 1, 3);
        feedTruncated(h.rx, 'b', 10, 10, 2, 3);
        feedTruncated(h.rx, 'c', 10, 10, 3, 3);
        expect(h.completed).toEqual([]);
        expect(h.errors).toHaveLength(1);
        expect(h.allComplete).toEqual([]);
    });

    it('accepts a file whose count matches exactly', () => {
        const h = harness();
        feedTruncated(h.rx, 'a', 100, 100);
        expect(h.completed).toEqual(['a.bin']);
        expect(h.errors).toEqual([]);
    });

    it('accepts a zero byte file announced as zero', () => {
        const h = harness();
        feedTruncated(h.rx, 'a', 0, 0);
        expect(h.completed).toEqual(['a.bin']);
        expect(h.errors).toEqual([]);
    });

    it('accepts a peer that announces no size at all', () => {
        // metadataMessage always writes a fileSize, so build the frame by hand. A
        // null size reads the same way: unknown, not refused.
        for (const fields of [{}, { fileSize: null }]) {
            const h = harness();
            h.rx.handleMessage(JSON.stringify({
                    type: 'metadata', id: 'a', fileName: 'a.bin', index: 1, total: 1, totalBytes: 0, ...fields,
                })
            );
            const chunk = new Uint8Array(50);
            for (let i = 0; i < 50; i++) chunk[i] = (i + 1) % 256;
            h.rx.handleMessage(chunk);
            h.rx.handleMessage(endMessage());
            expect(h.completed).toEqual(['a.bin']);
            expect(h.errors).toEqual([]);
        }
    });

    it('refuses an unusable announced size before any chunk is kept', () => {
        // These used to read as "unknown" and switch the byte-count guard off.
        // The Go receiver refuses every one of them, and now so does the browser.
        for (const bad of ['100', -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
            const sent: (string | Uint8Array)[] = [];
            const completed: string[] = [];
            const errors: string[] = [];
            const rx = createReceiver({
                send: (d) => sent.push(d),
                onFileComplete: (f) => completed.push(f.fileName),
                onError: (m) => errors.push(m),
            });
            rx.handleMessage(JSON.stringify({
                    type: 'metadata', id: 'a', fileName: 'a.bin',
                    fileSize: bad, index: 1, total: 1, totalBytes: 0,
                })
            );
            const chunk = new Uint8Array(10);
            for (let i = 0; i < 10; i++) chunk[i] = (i + 1) % 256;
            rx.handleMessage(chunk);
            rx.handleMessage(endMessage());
            expect(completed, String(bad)).toEqual([]);
            expect(errors).toEqual(['The sender described a file in a way Floe could not read, so the transfer was stopped. Ask the sender to try again.']);
            // Never acked, and told why in a frame with no code.
            expect(sent.some((s) => typeof s === 'string')).toBe(false);
            const frame = JSON.parse(new TextDecoder().decode(sent[0] as Uint8Array));
            expect(frame.reason).toBe('receiver rejected the file description: the file size is not a byte count');
            expect(frame.code).toBeUndefined();
        }
    });

    it('refuses a file description Go refuses', () => {
        const base = { type: 'metadata', id: 'a', fileName: 'a.bin', fileSize: 4, index: 1, total: 1, totalBytes: 4, pv: 1, pvMin: 1 };
        const refused = [
            { fileSize: 9007199254740992, totalBytes: 9007199254740992 },
            { fileSize: -1 },
            { fileSize: 1.5 },
            { fileSize: '4' },
            { fileSize: 1e300 },
            { index: 0 },
            { total: 0 },
            { totalBytes: 2 },
            { pv: '1' },
            { fileName: 7 },
            { id: 3 },
            { index: null },
        ];
        for (const fields of refused) {
            const sent: (string | Uint8Array)[] = [];
            const errors: string[] = [];
            const rx = createReceiver({ send: (d) => sent.push(d), onError: (m) => errors.push(m) });
            rx.handleMessage(JSON.stringify({ ...base, ...fields }));
            expect(errors, JSON.stringify(fields)).toHaveLength(1);
            expect(sent.some((s) => typeof s === 'string'), JSON.stringify(fields)).toBe(false);
        }
        // What Go accepts stays accepted: a legacy peer with no protocol fields, pv 0, and null name or id.
        for (const fields of [{ pv: undefined, pvMin: undefined }, { pv: 0, pvMin: 0 }, { fileName: null }, { id: null }, { totalBytes: undefined }]) {
            const sent: (string | Uint8Array)[] = [];
            const rx = createReceiver({ send: (d) => sent.push(d) });
            rx.handleMessage(JSON.stringify({ ...base, ...fields }));
            expect(sent.filter((s) => typeof s === 'string'), JSON.stringify(fields)).toHaveLength(1);
        }
    });

    it('accepts a resumed file that reaches the announced size', () => {
        // Metadata for the same id arrives twice; the receiver acks the bytes it
        // already has and the sender continues from there. The sum is against
        // the full announced size, so equality still holds.
        const h = harness();
        const acks: string[] = [];
        const rx = createReceiver({
            send: (d) => acks.push(typeof d === 'string' ? d : new TextDecoder().decode(d)),
            onFileComplete: (f) => h.completed.push(f.fileName),
            onError: (m) => h.errors.push(m),
        });
        const part = (n: number) => {
            const c = new Uint8Array(n);
            for (let i = 0; i < n; i++) c[i] = (i + 1) % 256;
            return c;
        };
        rx.handleMessage(metadataMessage('a', 'a.bin', 100, 1, 1, 0));
        rx.handleMessage(part(40));
        rx.handleMessage(metadataMessage('a', 'a.bin', 100, 1, 1, 0));
        rx.handleMessage(part(60));
        rx.handleMessage(endMessage());

        expect(JSON.parse(acks[1]).offset).toBe(40);
        expect(h.completed).toEqual(['a.bin']);
        expect(h.errors).toEqual([]);
    });

    it('shows a display-safe name in the incomplete-file error', () => {
        // A bidi override in the announced name would reorder the words of
        // the banner around it exactly as it does in a file manager, so the
        // error carries the display form of the name, not the wire string.
        const h = harness();
        h.rx.handleMessage(JSON.stringify({
                type: 'metadata', id: 'a', fileName: 'photo\u202egnp.exe',
                fileSize: 100, index: 1, total: 1, totalBytes: 100,
            })
        );
        const chunk = new Uint8Array(60);
        for (let i = 0; i < 60; i++) chunk[i] = (i + 1) % 256;
        h.rx.handleMessage(chunk);
        h.rx.handleMessage(endMessage());
        expect(h.errors).toHaveLength(1);
        expect(h.errors[0]).toContain('Incomplete file "photognp.exe"');
        expect(h.errors[0]).not.toContain('\u202e');
    });
});

/**
 * FLOE-M: a tab that ran out of memory threw from the chunk copy, nothing
 * caught it, and nothing latched, so every later chunk threw again (3,871
 * uncaught events in six minutes from one receiver) while the bytes already
 * held stayed held (FLOE-N: the next load of the link could not start).
 *
 * The chunk copy itself cannot be made to throw from a test without replacing
 * Uint8Array for the whole process, so these throw from the two places that
 * share its catch: a callback the frame calls, and the Blob built at `end`.
 */
describe('receiver: a throw stops the transfer once', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function harness(throwOnProgress?: () => unknown) {
        const sent: (string | Uint8Array)[] = [];
        const errors: string[] = [];
        const failures: (ReceiveFailure | undefined)[] = [];
        const completed: string[] = [];
        const rx = createReceiver({
            send: (d) => sent.push(d),
            onProgress: () => {
                if (throwOnProgress) throw throwOnProgress();
            },
            onFileComplete: (f) => completed.push(f.fileName),
            onError: (m, f) => {
                errors.push(m);
                failures.push(f);
            },
        });
        return { rx, sent, errors, failures, completed };
    }

    function lastFrame(sent: (string | Uint8Array)[]) {
        const frame = sent[sent.length - 1];
        expect(frame).toBeInstanceOf(Uint8Array);
        return JSON.parse(new TextDecoder().decode(frame as Uint8Array));
    }

    it('reports running out of memory once, and drops every later frame', () => {
        const h = harness(() => new RangeError('Array buffer allocation failed'));
        h.rx.handleMessage(metadataMessage('a', 'a.bin', 6, 1, 1, 6));
        // The first chunk completes the announced size, so onProgress runs
        // and throws; nothing may escape into the emitter.
        expect(() => h.rx.handleMessage(enc.encode('abcdef'))).not.toThrow();
        expect(() => h.rx.handleMessage(enc.encode('ghi'))).not.toThrow();
        expect(() => h.rx.handleMessage(endMessage())).not.toThrow();

        expect(h.errors).toEqual([OUT_OF_MEMORY_MESSAGE]);
        expect(h.failures[0]).toMatchObject({ code: 'out-of-memory', received: 6, expected: 6, senderSentVersion: false });
        expect(h.failures[0]?.cause).toBeInstanceOf(RangeError);
        expect(h.completed).toEqual([]);
    });

    it('tells the sender, as an abort reason it prints rather than an update remedy', () => {
        const h = harness(() => new RangeError('Array buffer allocation failed'));
        h.rx.handleMessage(metadataMessage('a', 'a.bin', 6, 1, 1, 6));
        h.rx.handleMessage(enc.encode('abcdef'));

        const parsed = lastFrame(h.sent);
        expect(parsed.type).toBe('incompatible');
        expect(parsed.reason).toBe('receiver ran out of memory after receiving 6 of 6 bytes');
        expect(parsed.pv).toBe(PROTOCOL_VERSION);
        expect(parsed.pvMin).toBe(MIN_PROTOCOL_VERSION);
        // Exactly the ack and the abort: one frame each, never one per chunk.
        expect(h.sent).toHaveLength(2);
    });

    it('recognizes the bare string Firefox throws', () => {
        const h = harness(() => 'out of memory');
        h.rx.handleMessage(metadataMessage('a', 'a.bin', 3, 1, 1, 3));
        h.rx.handleMessage(enc.encode('abc'));
        expect(h.failures[0]?.code).toBe('out-of-memory');
    });

    it('catches the Blob built at the end of a file too', () => {
        const h = harness();
        h.rx.handleMessage(metadataMessage('a', 'a.bin', 3, 1, 1, 3));
        h.rx.handleMessage(enc.encode('abc'));
        vi.stubGlobal(
            'Blob',
            class {
                constructor() {
                    throw new RangeError('Array buffer allocation failed');
                }
            }
        );
        expect(() => h.rx.handleMessage(endMessage())).not.toThrow();
        expect(h.errors).toEqual([OUT_OF_MEMORY_MESSAGE]);
        expect(h.failures[0]).toMatchObject({ code: 'out-of-memory', received: 3, expected: 3 });
        expect(h.completed).toEqual([]);
    });

    it('stops on any other throw as well, and hands the cause over for a report', () => {
        const bug = new TypeError("Cannot read properties of undefined (reading 'x')");
        const h = harness(() => bug);
        h.rx.handleMessage(metadataMessage('a', 'a.bin', 3, 1, 1, 3));
        expect(() => h.rx.handleMessage(enc.encode('abc'))).not.toThrow();
        h.rx.handleMessage(enc.encode('def'));

        expect(h.errors).toEqual([INTERNAL_ERROR_MESSAGE]);
        expect(h.failures[0]?.code).toBe('internal');
        expect(h.failures[0]?.cause).toBe(bug);
        expect(lastFrame(h.sent).reason).toBe('receiver stopped because of an internal error');
    });

    it('reports no size when no file was open', () => {
        // A throw on a control frame before any metadata: nothing was held.
        const h = harness();
        vi.stubGlobal(
            'TextEncoder',
            class {
                encode(): Uint8Array {
                    throw new RangeError('Array buffer allocation failed');
                }
            }
        );
        expect(() => h.rx.handleMessage(endMessage())).not.toThrow();
        expect(h.failures[0]).toMatchObject({ code: 'out-of-memory', received: 0, expected: null });
        // The abort frame needed a TextEncoder too and could not be built;
        // that is swallowed, and the person still gets the message.
        expect(h.sent).toEqual([]);
        expect(h.errors).toEqual([OUT_OF_MEMORY_MESSAGE]);
    });

    it('stays silent when its own frame cannot go out because the channel is closing', () => {
        // The connection is what failed, and the peer's close handler says so.
        // Reporting it as a receiver bug would only add noise.
        const errors: string[] = [];
        const rx = createReceiver({
            send: () => {
                throw new DOMException("RTCDataChannel.readyState is not 'open'", 'InvalidStateError');
            },
            onError: (m) => errors.push(m),
        });
        expect(() => rx.handleMessage(metadataMessage('a', 'a.bin', 3, 1, 1, 3))).not.toThrow();
        expect(() => rx.handleMessage(enc.encode('abc'))).not.toThrow();
        expect(errors).toEqual([]);
    });

    it('lets go of a partial file when the connection closes mid-file', () => {
        const h = harness();
        h.rx.handleMessage(metadataMessage('a', 'a.bin', 6, 1, 1, 6));
        h.rx.handleMessage(enc.encode('abc'));
        h.rx.dispose();
        // Nothing reopens: the rest of the file and its end are ignored.
        h.rx.handleMessage(enc.encode('def'));
        h.rx.handleMessage(endMessage());
        expect(h.completed).toEqual([]);
        expect(h.errors).toEqual([]);
    });

    it('says whether the sender announced a version, which only Go senders do', () => {
        const h = harness(() => new RangeError('Array buffer allocation failed'));
        h.rx.handleMessage(metadataMessage('a', 'a.bin', 3, 1, 1, 3, '1.10.11'));
        h.rx.handleMessage(enc.encode('abc'));
        expect(h.failures[0]?.senderSentVersion).toBe(true);
    });

    it('reports no sizes for a throw after the file was handed over', () => {
        // The file is complete; the sizes would describe nothing in progress.
        const errors: string[] = [];
        const failures: (ReceiveFailure | undefined)[] = [];
        const rx = createReceiver({
            send: () => {},
            onFileComplete: () => {
                throw new TypeError('render failed');
            },
            onError: (m, f) => {
                errors.push(m);
                failures.push(f);
            },
        });
        rx.handleMessage(metadataMessage('a', 'a.bin', 3, 1, 1, 3));
        rx.handleMessage(enc.encode('abc'));
        expect(() => rx.handleMessage(endMessage())).not.toThrow();
        expect(errors).toEqual([INTERNAL_ERROR_MESSAGE]);
        expect(failures[0]).toMatchObject({ code: 'internal', received: 0, expected: null });
    });

    it('still explains a version mismatch when the peer is already gone', () => {
        // The incompatible frame cannot be sent; the person still has to
        // learn why, and nothing may escape into the emitter.
        const errors: string[] = [];
        const rx = createReceiver({
            send: () => {
                throw new Error('cannot send');
            },
            onError: (m) => errors.push(m),
        });
        const tooNew = JSON.stringify({
            type: 'metadata', id: 'a', fileName: 'a.bin', fileSize: 3, index: 1, total: 1, totalBytes: 3,
            pv: PROTOCOL_VERSION + 5, pvMin: PROTOCOL_VERSION + 5,
        });
        expect(() => rx.handleMessage(tooNew)).not.toThrow();
        expect(errors).toHaveLength(1);
    });

    it('lets a throw from a frame that already stopped the transfer surface once, unreworded', () => {
        // The sender's own abort reason is the account the person should read.
        // A broken onError callback is a bug of ours, so it reaches the global
        // handler, once, instead of being replaced by a second message.
        const errors: string[] = [];
        const rx = createReceiver({
            send: () => {},
            onError: (m) => {
                errors.push(m);
                throw new Error('callback bug');
            },
        });
        expect(() => rx.handleMessage(incompatibleMessage('Transfer blocked.'))).toThrow('callback bug');
        expect(() => rx.handleMessage(endMessage())).not.toThrow();
        expect(errors).toEqual(['Transfer blocked.']);
    });
});

/**
 * The tab holds at most SPILL_BYTES of a file as chunk copies; the rest goes
 * into Blob parts, whose bytes Chromium moves out of the renderer.
 */
describe('receiver: holds a bounded amount of a file in the tab', () => {
    const RealBlob = Blob;

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // Bytes no chunk starts with '{', and that differ along the file so an
    // out-of-order part would show.
    function pattern(size: number): Uint8Array {
        const out = new Uint8Array(size);
        for (let i = 0; i < size; i++) out[i] = (i * 7 + (i >>> 16)) % 251 + 1;
        return out;
    }

    function feed(rx: { handleMessage: (d: string | Uint8Array | ArrayBuffer) => void }, bytes: Uint8Array, chunk: number) {
        rx.handleMessage(metadataMessage('big', 'big.bin', bytes.byteLength, 1, 1, bytes.byteLength));
        for (let off = 0; off < bytes.byteLength; off += chunk) {
            rx.handleMessage(bytes.subarray(off, Math.min(off + chunk, bytes.byteLength)));
        }
        rx.handleMessage(endMessage());
    }

    it('reassembles a file that crossed several spills, in order, byte for byte', async () => {
        // 300 KiB chunks do not divide 16 MiB, so a spill lands mid-chunk
        // boundary arithmetic, and the tail is a partial part.
        const size = 2 * SPILL_BYTES + 12345;
        const bytes = pattern(size);
        let blob: Blob | null = null;
        const rx = createReceiver({ send: () => {}, onFileComplete: (f) => { blob = f.blob; } });
        feed(rx, bytes, 300 * 1024);
        expect(blob).not.toBeNull();
        const got = new Uint8Array(await blob!.arrayBuffer());
        expect(got.byteLength).toBe(size);
        expect(Buffer.compare(Buffer.from(got), Buffer.from(bytes))).toBe(0);
    });

    it('spills each time SPILL_BYTES gather, not once at the end', () => {
        const built: number[] = [];
        vi.stubGlobal(
            'Blob',
            class extends RealBlob {
                constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
                    super(parts, options);
                    built.push(this.size);
                }
            }
        );
        const rx = createReceiver({ send: () => {} });
        feed(rx, pattern(2 * SPILL_BYTES + 100), 256 * 1024);
        // Two full parts, the 100-byte tail, then the file composed of them.
        expect(built).toEqual([SPILL_BYTES, SPILL_BYTES, 100, 2 * SPILL_BYTES + 100]);
    });

    function counting(): number[] {
        const built: number[] = [];
        vi.stubGlobal(
            'Blob',
            class extends RealBlob {
                constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
                    super(parts, options);
                    built.push(this.size);
                }
            }
        );
        return built;
    }

    function brokenParts(): void {
        // Chromium's shape when its blob storage is full: the constructor
        // returns, the size is right, and only a read fails.
        vi.stubGlobal(
            'Blob',
            class extends RealBlob {
                slice(): Blob {
                    return { arrayBuffer: () => Promise.reject(new DOMException('', 'NotReadableError')) } as unknown as Blob;
                }
            }
        );
    }

    function recorder() {
        const sent: (string | Uint8Array)[] = [];
        const errors: string[] = [];
        const failures: (ReceiveFailure | undefined)[] = [];
        const completed: Blob[] = [];
        const rx = createReceiver({
            send: (d) => sent.push(d),
            onFileComplete: (f) => completed.push(f.blob),
            onError: (m, f) => {
                errors.push(m);
                failures.push(f);
            },
        });
        return { rx, sent, errors, failures, completed };
    }

    const tick = () => new Promise((r) => setTimeout(r, 0));

    it('builds nothing for a zero-byte file', () => {
        const built = counting();
        const h = recorder();
        h.rx.handleMessage(metadataMessage('z', 'z.bin', 0, 1, 1, 0));
        h.rx.handleMessage(endMessage());
        expect(h.completed).toHaveLength(1);
        expect(h.completed[0].size).toBe(0);
        expect(built).toEqual([0]);
    });

    it('hands over the single part itself for a file of exactly SPILL_BYTES', () => {
        const built = counting();
        const h = recorder();
        feed(h.rx, pattern(SPILL_BYTES), 256 * 1024);
        expect(built).toEqual([SPILL_BYTES]);
        expect(h.completed[0].size).toBe(SPILL_BYTES);
    });

    it('starts the next file clean after a spill', async () => {
        const first = pattern(SPILL_BYTES + 5);
        const second = pattern(777).map((b) => (b % 200) + 2);
        const h = recorder();
        h.rx.handleMessage(metadataMessage('a', 'a.bin', first.byteLength, 1, 2, first.byteLength + 777));
        for (let off = 0; off < first.byteLength; off += 256 * 1024) h.rx.handleMessage(first.subarray(off, off + 256 * 1024));
        h.rx.handleMessage(endMessage());
        h.rx.handleMessage(metadataMessage('b', 'b.bin', 777, 2, 2, first.byteLength + 777));
        h.rx.handleMessage(second);
        h.rx.handleMessage(endMessage());
        expect(h.completed).toHaveLength(2);
        expect(Buffer.compare(Buffer.from(await h.completed[0].arrayBuffer()), Buffer.from(first))).toBe(0);
        expect(Buffer.compare(Buffer.from(await h.completed[1].arrayBuffer()), Buffer.from(second))).toBe(0);
        expect(h.errors).toEqual([]);
    });

    it('reports a part found broken after its file was handed over, with that file\'s sizes', async () => {
        brokenParts();
        const h = recorder();
        h.rx.handleMessage(metadataMessage('a', 'a.bin', 3, 1, 1, 3));
        h.rx.handleMessage(enc.encode('abc'));
        h.rx.handleMessage(endMessage());
        expect(h.completed).toHaveLength(1);
        await tick();
        expect(h.errors).toEqual([OUT_OF_MEMORY_MESSAGE]);
        expect(h.failures[0]).toMatchObject({ code: 'out-of-memory', received: 3, expected: 3 });
        const abort = JSON.parse(new TextDecoder().decode(h.sent[h.sent.length - 1] as Uint8Array));
        expect(abort.reason).toBe('receiver ran out of memory after receiving 3 of 3 bytes');
    });

    it('still reports it when the connection closed first', async () => {
        // A Go sender closes as soon as its last bytes are out, which can be
        // before the read-back of the last part settles.
        brokenParts();
        const h = recorder();
        h.rx.handleMessage(metadataMessage('a', 'a.bin', 3, 1, 1, 3));
        h.rx.handleMessage(enc.encode('abc'));
        h.rx.handleMessage(endMessage());
        h.rx.dispose();
        await tick();
        expect(h.errors).toEqual([OUT_OF_MEMORY_MESSAGE]);
    });

    it('stays quiet about a broken part once a failure was reported', async () => {
        // A size mismatch after a spill already told the person; the part it
        // left behind must not say it a second time.
        brokenParts();
        const h = recorder();
        h.rx.handleMessage(metadataMessage('a', 'a.bin', SPILL_BYTES * 2, 1, 1, SPILL_BYTES * 2));
        h.rx.handleMessage(pattern(SPILL_BYTES));
        h.rx.handleMessage(endMessage());
        h.rx.dispose();
        await tick();
        expect(h.errors).toHaveLength(1);
        expect(h.errors[0]).toContain('Incomplete file');
    });

    it('stops with the out-of-memory message when a part cannot be read back', async () => {
        // Chromium's shape when its blob storage is full: the constructor
        // returns, the size is right, and only a read fails.
        vi.stubGlobal(
            'Blob',
            class extends RealBlob {
                slice(): Blob {
                    return { arrayBuffer: () => Promise.reject(new DOMException('', 'NotReadableError')) } as unknown as Blob;
                }
            }
        );
        const sent: (string | Uint8Array)[] = [];
        const errors: string[] = [];
        const failures: (ReceiveFailure | undefined)[] = [];
        const rx = createReceiver({
            send: (d) => sent.push(d),
            onError: (m, f) => {
                errors.push(m);
                failures.push(f);
            },
        });
        rx.handleMessage(metadataMessage('a', 'a.bin', SPILL_BYTES * 2, 1, 1, SPILL_BYTES * 2));
        rx.handleMessage(pattern(SPILL_BYTES));
        await new Promise((r) => setTimeout(r, 0));

        expect(errors).toEqual([OUT_OF_MEMORY_MESSAGE]);
        expect(failures[0]).toMatchObject({ code: 'out-of-memory', received: SPILL_BYTES, expected: SPILL_BYTES * 2 });
        const abort = JSON.parse(new TextDecoder().decode(sent[sent.length - 1] as Uint8Array));
        expect(abort.reason).toContain('ran out of memory');
        // And nothing after it reopens the transfer.
        rx.handleMessage(pattern(SPILL_BYTES));
        await new Promise((r) => setTimeout(r, 0));
        expect(errors).toHaveLength(1);
    });
});

/**
 * The bound above, against a sender that does not follow the protocol (review
 * R0-06-H6 L1). A byte line alone let one-byte frames keep millions of chunk
 * copies before the first spill, empty frames keep copies that never reach it,
 * and a metadata for a new id leave the previous file's copies in the tab.
 */
describe('receiver: holds a bounded amount in the tab whatever the sender does', () => {
    const RealBlob = Blob;
    // The bound under test: at most about one chunk copy per 16 KiB of a file,
    // which is what a sender writing 16 KiB frames already produced.
    const COPY_BYTES = 16 * 1024;

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function pattern(size: number): Uint8Array {
        const out = new Uint8Array(size);
        for (let i = 0; i < size; i++) out[i] = (i * 7 + (i >>> 16)) % 251 + 1;
        return out;
    }

    // Every Blob the receiver builds, with how many pieces it was built from:
    // a spill's piece count is the number of chunk copies the tab held.
    function recordBuilds(): Array<{ size: number; parts: number }> {
        const builds: Array<{ size: number; parts: number }> = [];
        vi.stubGlobal(
            'Blob',
            class extends RealBlob {
                constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
                    super(parts, options);
                    builds.push({ size: this.size, parts: parts?.length ?? 0 });
                }
            }
        );
        return builds;
    }

    function recorder() {
        const sent: (string | Uint8Array)[] = [];
        const errors: string[] = [];
        const completed: Blob[] = [];
        const rx = createReceiver({
            send: (d) => sent.push(d),
            onFileComplete: (f) => completed.push(f.blob),
            onError: (m) => errors.push(m),
        });
        return { rx, sent, errors, completed };
    }

    function feedFrames(rx: { handleMessage: (d: string | Uint8Array | ArrayBuffer) => void }, bytes: Uint8Array, sizes: number[]) {
        rx.handleMessage(metadataMessage('m', 'm.bin', bytes.byteLength, 1, 1, bytes.byteLength));
        let off = 0;
        for (const n of sizes) {
            rx.handleMessage(bytes.subarray(off, off + n));
            off += n;
        }
        rx.handleMessage(endMessage());
    }

    async function same(blob: Blob, bytes: Uint8Array): Promise<boolean> {
        return Buffer.compare(Buffer.from(await blob.arrayBuffer()), Buffer.from(bytes)) === 0;
    }

    it('keeps one-byte frames in one chunk copy per 16 KiB, not one per frame', async () => {
        const builds = recordBuilds();
        const h = recorder();
        const n = 100_000;
        const bytes = pattern(n);
        feedFrames(h.rx, bytes, new Array<number>(n).fill(1));
        expect(h.errors).toEqual([]);
        // One part at the end, as for any file under the line: no new spill.
        expect(builds.map((b) => b.size)).toEqual([n]);
        expect(builds[0].parts).toBeLessThanOrEqual(Math.ceil(n / COPY_BYTES));
        expect(await same(h.completed[0], bytes)).toBe(true);
    });

    it('spills 1 KiB frames at the same byte line, from one copy per 16 KiB', async () => {
        const builds = recordBuilds();
        const h = recorder();
        const size = 2 * SPILL_BYTES + 100;
        const bytes = pattern(size);
        const sizes: number[] = [];
        for (let off = 0; off < size; off += 1024) sizes.push(Math.min(1024, size - off));
        feedFrames(h.rx, bytes, sizes);
        expect(h.errors).toEqual([]);
        expect(builds).toEqual([
            { size: SPILL_BYTES, parts: SPILL_BYTES / COPY_BYTES },
            { size: SPILL_BYTES, parts: SPILL_BYTES / COPY_BYTES },
            { size: 100, parts: 1 },
            { size, parts: 3 },
        ]);
        expect(await same(h.completed[0], bytes)).toBe(true);
    });

    it('keeps no copy for an empty frame', async () => {
        const builds = recordBuilds();
        const h = recorder();
        h.rx.handleMessage(metadataMessage('e', 'e.bin', 3, 1, 1, 3));
        const empty = new Uint8Array(0);
        for (let i = 0; i < 50_000; i++) h.rx.handleMessage(empty);
        h.rx.handleMessage(enc.encode('abc'));
        h.rx.handleMessage(endMessage());
        expect(h.errors).toEqual([]);
        expect(builds).toEqual([{ size: 3, parts: 1 }]);
        expect(await same(h.completed[0], enc.encode('abc'))).toBe(true);
    });

    // Live ArrayBuffer memory, the chunk copies' own. V8 frees collected
    // buffers on a background sweeper, so a count waits for the garbage
    // earlier tests left to be freed first: without the wait it was freed
    // during the measured loop and hid a 125 MiB growth in one of two runs.
    async function liveArrayBuffers(): Promise<number> {
        setFlagsFromString('--expose-gc');
        const gc = runInNewContext('gc') as () => void;
        for (let i = 0; i < 4; i++) {
            gc();
            await new Promise((r) => setTimeout(r, 25));
        }
        return process.memoryUsage().arrayBuffers;
    }

    it('lets go of a file left open when a metadata names another id', async () => {
        const h = recorder();
        const frame = pattern(16 * 1024);
        const per = SPILL_BYTES / frame.byteLength - 1; // one frame under the line
        const before = await liveArrayBuffers();
        for (let k = 0; k < 8; k++) {
            h.rx.handleMessage(metadataMessage(`f${k}`, `f${k}.bin`, SPILL_BYTES, 1, 2, 2 * SPILL_BYTES));
            for (let i = 0; i < per; i++) h.rx.handleMessage(frame);
        }
        const grown = (await liveArrayBuffers()) - before;
        expect(h.errors).toEqual([]);
        // The open file's copies, just under SPILL_BYTES; kept for a resume,
        // the seven files left behind held seven times that again.
        expect(grown).toBeLessThan(2 * SPILL_BYTES);
    });

    it('resumes the open file under the same id, and starts over one it left', async () => {
        const builds = recordBuilds();
        const h = recorder();
        const a = pattern(100);
        const b = pattern(10).map((x) => (x % 200) + 2);
        h.rx.handleMessage(metadataMessage('a', 'a.bin', 100, 1, 2, 110));
        h.rx.handleMessage(a.subarray(0, 40));
        // The same id again is a resume: the 40 bytes stay, nothing is built.
        h.rx.handleMessage(metadataMessage('a', 'a.bin', 100, 1, 2, 110));
        expect(builds).toEqual([]);
        // Another id abandons a, as the Go receiver does, so a starts over.
        h.rx.handleMessage(metadataMessage('b', 'b.bin', 10, 2, 2, 110));
        h.rx.handleMessage(b.subarray(0, 4));
        h.rx.handleMessage(metadataMessage('a', 'a.bin', 100, 1, 2, 110));
        h.rx.handleMessage(a);
        h.rx.handleMessage(endMessage());
        const acks = h.sent.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d));
        expect(acks.map((m) => [m.id, m.offset])).toEqual([['a', 0], ['a', 40], ['b', 0], ['a', 0]]);
        expect(h.errors).toEqual([]);
        expect(h.completed).toHaveLength(1);
        expect(await same(h.completed[0], a)).toBe(true);
    });

    it.each([16 * 1024, 64 * 1024, 256 * 1024])('spills %i-byte frames exactly where it always has', async (chunk) => {
        const builds = recordBuilds();
        const h = recorder();
        const size = 2 * SPILL_BYTES + 100;
        const bytes = pattern(size);
        const sizes: number[] = [];
        for (let off = 0; off < size; off += chunk) sizes.push(Math.min(chunk, size - off));
        feedFrames(h.rx, bytes, sizes);
        expect(h.errors).toEqual([]);
        // A part per SPILL_BYTES, each from one copy per frame, then the tail
        // and the file composed of the three.
        expect(builds).toEqual([
            { size: SPILL_BYTES, parts: SPILL_BYTES / chunk },
            { size: SPILL_BYTES, parts: SPILL_BYTES / chunk },
            { size: 100, parts: 1 },
            { size, parts: 3 },
        ]);
        expect(await same(h.completed[0], bytes)).toBe(true);
    });

    it('reassembles any mix of frame sizes in order, spilling at the same byte line', async () => {
        const builds = recordBuilds();
        const h = recorder();
        const cycle = [1, 16383, 16384, 7, 65536, 0, 100, 16385, 262144, 3, 5000, 12000];
        const sizes: number[] = [];
        let total = 0;
        for (let i = 0; total < 2 * SPILL_BYTES + 777; i++) {
            const n = cycle[i % cycle.length];
            sizes.push(n);
            total += n;
        }
        const bytes = pattern(total);
        feedFrames(h.rx, bytes, sizes);
        expect(h.errors).toEqual([]);
        // Where a byte line alone spills: each time SPILL_BYTES have gathered.
        const spills: number[] = [];
        let held = 0;
        for (const n of sizes) {
            held += n;
            if (held >= SPILL_BYTES) {
                spills.push(held);
                held = 0;
            }
        }
        if (held > 0) spills.push(held);
        expect(builds.map((b) => b.size)).toEqual([...spills, total]);
        for (const b of builds.slice(0, -1)) expect(b.parts).toBeLessThanOrEqual(2 * Math.ceil(b.size / COPY_BYTES) + 1);
        expect(await same(h.completed[0], bytes)).toBe(true);
    });
});
