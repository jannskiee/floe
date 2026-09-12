import { describe, it, expect } from 'vitest';
import { createReceiver } from './receiver';
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
 * These tests model the wire, which is what the loopback harness above now
 * does too.
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
        // metadataMessage always writes a fileSize, so build the frame by hand.
        const h = harness();
        h.rx.handleMessage(JSON.stringify({
                type: 'metadata', id: 'a', fileName: 'a.bin', index: 1, total: 1, totalBytes: 0,
            })
        );
        const chunk = new Uint8Array(50);
        for (let i = 0; i < 50; i++) chunk[i] = (i + 1) % 256;
        h.rx.handleMessage(chunk);
        h.rx.handleMessage(endMessage());
        expect(h.completed).toEqual(['a.bin']);
        expect(h.errors).toEqual([]);
    });

    it('treats an unusable announced size as unknown rather than failing', () => {
        for (const bad of ['100', -1, 1.5, null, Number.MAX_SAFE_INTEGER + 2]) {
            const h = harness();
            h.rx.handleMessage(JSON.stringify({
                    type: 'metadata', id: 'a', fileName: 'a.bin',
                    fileSize: bad, index: 1, total: 1, totalBytes: 0,
                })
            );
            const chunk = new Uint8Array(10);
            for (let i = 0; i < 10; i++) chunk[i] = (i + 1) % 256;
            h.rx.handleMessage(chunk);
            h.rx.handleMessage(endMessage());
            expect(h.completed).toEqual(['a.bin']);
            expect(h.errors).toEqual([]);
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
