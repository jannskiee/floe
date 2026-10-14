import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RELAY_OFF_REASON, SELF_STOP_REASONS, selfStopOf } from './senderSelfStop';
import { classifyControl, incompatibleMessage, isAbortReason, type Incompatible } from './transfer/protocol';
import { createReceiver } from './transfer/receiver';

// The literal frames a browser sender now sends when it stops on its own, and
// what each receiver makes of them. The Go half of the same table is
// cli/engine/transfer/browserstop_test.go, which runs the Go receiver on each
// frame; that receiver's incompatible branch is unchanged since v1.11.0 and
// desktop-v0.3.0, so the table is what released Go peers show too.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

interface Row {
    name: string;
    frame: string;
    browser: string;
    go: string;
}

const ROWS: Row[] = JSON.parse(read('../../cli/engine/transfer/testdata/browser-sender-stops.json'));

const REASON_OF: Record<string, string> = {
    unreadable: SELF_STOP_REASONS.unreadable,
    'ack-timeout': SELF_STOP_REASONS['ack-timeout'],
    internal: SELF_STOP_REASONS.internal,
    'relay-off': RELAY_OFF_REASON,
};

describe('the stop frames a browser sender sends', () => {
    it('covers every reason, and nothing else', () => {
        expect(ROWS.map((r) => r.name).sort()).toEqual(Object.keys(REASON_OF).sort());
    });

    for (const row of ROWS) {
        it(`${row.name}: the page builds exactly the pinned frame`, () => {
            expect(incompatibleMessage(REASON_OF[row.name])).toBe(row.frame);
        });

        it(`${row.name}: every peer reads it as a deliberate stop, not a version mismatch`, () => {
            const msg = classifyControl(row.frame);
            expect(msg?.type).toBe('incompatible');
            expect(isAbortReason(msg as Incompatible)).toBe(true);
        });

        it(`${row.name}: a browser receiver shows the pinned words`, () => {
            const errors: string[] = [];
            const rx = createReceiver({ send: () => {}, onError: (m) => errors.push(m) });
            rx.handleMessage(row.frame);
            expect(errors).toEqual([row.browser]);
        });

        it(`${row.name}: fits a control frame and reads the same on every receiver`, () => {
            expect(new TextEncoder().encode(row.frame).byteLength).toBeLessThanOrEqual(1000);
            // The Go receiver prints the reason through displayText, capped at
            // 300 characters: under that, both show the same sentence.
            expect(REASON_OF[row.name].length).toBeLessThanOrEqual(300);
            expect(row.go).toBe(row.browser);
        });
    }

    it('tells the receiver about every typed failure but a closed channel', () => {
        expect(selfStopOf('unreadable')).toBe('unreadable');
        expect(selfStopOf('ack-timeout')).toBe('ack-timeout');
        expect(selfStopOf('closed')).toBeNull();
    });
});

// Nothing in the suite mounts P2PTransfer, so its wiring is pinned from the
// source, the way lib/relay.test.ts pins the over-limit branch.
describe('P2PTransfer tells the receiver before it closes', () => {
    const src = read('../components/P2PTransfer.tsx');

    function branch(head: string): string {
        const at = src.indexOf(head);
        expect(at, head).toBeGreaterThan(-1);
        let depth = 0;
        for (let i = at + head.length - 1; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
        }
        throw new Error('unbalanced branch');
    }

    it('the relay-off refusal awaits its reason, then destroys the peer', () => {
        const body = branch("if (verdict.action === 'block-relay-disabled') {");
        const abort = body.indexOf('await sendAbortReason(');
        expect(abort).toBeGreaterThan(-1);
        expect(body.indexOf('RELAY_OFF_REASON')).toBeGreaterThan(abort);
        expect(body.indexOf('.destroy()')).toBeGreaterThan(body.indexOf('RELAY_OFF_REASON'));
    });

    it('a send that stops on this side is told and closed through one helper', () => {
        expect(src).toContain('selfStopOf(');
        expect(src).toContain("SELF_STOP_REASONS.internal");
        const helper = branch('const tellAndClose = async (');
        expect(helper.indexOf('await sendAbortReason(')).toBeGreaterThan(-1);
        expect(helper.indexOf('.destroy()')).toBeGreaterThan(helper.indexOf('await sendAbortReason('));
    });
});
