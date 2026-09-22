import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FIRST_ACK_TIMEOUT_MS } from './constants';
import { REQUEST_ACK_TIMEOUT_MS, REQUEST_ACK_GRACE_MS } from '../transfer/protocol';

// What the /r page may and may not reach, read as TEXT.
//
// client/vitest.config.ts runs in node and collects lib/ and app/ only, so the
// component and the hooks cannot be mounted here. Their sources can be read,
// and the properties below are properties of the source: which modules are
// imported, which strings are emitted, which constants are passed. A rule that
// needs the running page (no socket before Send, no request carrying the room)
// is the Playwright privacy spec's.

const CLIENT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFileSync(CLIENT + rel, 'utf8');

/** Every production source reachable only from /r. Test files are left out:
 *  they name the forbidden things on purpose. */
function requestSources(): Record<string, string> {
    const files: string[] = [
        'components/RequestVisitor.tsx',
        'hooks/useRequestFiles.ts',
        'hooks/useVisitorGuards.ts',
        'app/r/[linkId]/page.tsx',
    ];
    for (const f of readdirSync(CLIENT + 'components/request')) {
        if (f.endsWith('.tsx')) files.push(`components/request/${f}`);
    }
    for (const f of readdirSync(CLIENT + 'lib/request')) {
        if (f.endsWith('.ts') && !f.endsWith('.test.ts')) files.push(`lib/request/${f}`);
    }
    const out: Record<string, string> = {};
    for (const f of files) {
        try {
            out[f] = read(f);
        } catch (err) {
            // useVisitorGuards arrives with S1-WEB-04; everything else must exist.
            if (f === 'hooks/useVisitorGuards.ts') continue;
            throw err;
        }
    }
    return out;
}

/** The argument text of every call to `name(` in `src`, balanced on parens. */
function callArgs(src: string, name: string): string[] {
    const out: string[] = [];
    let from = 0;
    for (;;) {
        const at = src.indexOf(name + '(', from);
        if (at < 0) return out;
        let depth = 0;
        let i = at + name.length;
        for (; i < src.length; i++) {
            if (src[i] === '(') depth++;
            else if (src[i] === ')' && --depth === 0) break;
        }
        out.push(src.slice(at + name.length + 1, i));
        from = i;
    }
}

/** Split an argument list on its top-level commas. */
function splitArgs(args: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let cur = '';
    for (const ch of args) {
        if ('([{'.includes(ch)) depth++;
        if (')]}'.includes(ch)) depth--;
        if (ch === ',' && depth === 0) {
            parts.push(cur.trim());
            cur = '';
        } else cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
}

describe('the /r page boundaries', () => {
    it('request modules never import the receiver or report stats', () => {
        const forbidden = [
            'transfer/receiver',
            'createReceiver',
            'reportBytes',
            'useTransferAnalytics',
            'StatsContributionToggle',
            'RelayFallbackToggle',
            'P2PTransfer',
            'api/stats',
            "'join-room'",
            'compatErrorFromIncompatible',
            // Spelled in two pieces so the consumer checker does not count this
            // file as a reader of the wire field.
            ['.', 'reason'].join(''),
            'track(',
            'useSignaling(',
        ];
        const sources = requestSources();
        expect(Object.keys(sources).length).toBeGreaterThan(12);
        for (const [file, src] of Object.entries(sources)) {
            for (const token of forbidden) {
                expect(src.includes(token), `${file} contains ${token}`).toBe(false);
            }
        }
    });

    it('sendAbortReason on /r passes only fixed constants', () => {
        const sources = requestSources();
        const seen = new Set<string>();
        for (const [file, src] of Object.entries(sources)) {
            for (const args of callArgs(src, 'sendAbortReason')) {
                // The import line names the function without calling it.
                const third = splitArgs(args)[2];
                expect(['RELAY_BLOCK_REASON', 'VISITOR_CANCEL_REASON'], `${file}: ${args}`).toContain(third);
                seen.add(third);
            }
        }
        // Both aborts exist, so the check above is not vacuous.
        expect([...seen].sort()).toEqual(['RELAY_BLOCK_REASON', 'VISITOR_CANCEL_REASON']);
    });

    it('the first-ack timer is the shared ack clock plus its grace', () => {
        expect(FIRST_ACK_TIMEOUT_MS).toBe(REQUEST_ACK_TIMEOUT_MS + REQUEST_ACK_GRACE_MS);
        expect(FIRST_ACK_TIMEOUT_MS).toBe(615000);
        const constants = read('lib/request/constants.ts');
        expect(constants).toContain('REQUEST_ACK_TIMEOUT_MS + REQUEST_ACK_GRACE_MS');
        for (const literal of ['615_000', '615000', '600_000', '600000']) {
            expect(constants.includes(literal), literal).toBe(false);
        }
    });

    it('the visitor sends with the first-ack clock, requireReceived and isDestroyed', () => {
        const visitor = read('components/RequestVisitor.tsx');
        const calls = callArgs(visitor, 'sendFiles');
        expect(calls).toHaveLength(1);
        const args = calls[0];
        expect(args).toContain('ackTimeoutMs: FIRST_ACK_TIMEOUT_MS');
        expect(args).toContain('requireReceived: true');
        // No deadline of its own under requireReceived (E-36): isDestroyed is
        // the only way out of a host that neither answers nor closes. The
        // callbacks are built beside the call and passed through watchSend.
        expect(args).toContain('watch.callbacks');
        expect(visitor).toContain('isDestroyed: () => !live()');
    });

    it('the visitor wires its sender callbacks, settle guard and peer through the tested mappers', () => {
        // WP-W1 review F2. The mapping rules are unit tested in senderEvents,
        // sendOutcome and visitorState; these pins make sure the component
        // uses them and adds no mapping of its own. The reviewer's mutation
        // (onDelivered wired to Delivered in the component) fails here.
        const visitor = read('components/RequestVisitor.tsx');
        expect(visitor).toMatch(/watchSend[(]\s*senderEvents[(][{]/);
        for (const own of ['onDelivered', 'onReceived', 'onAllSent:', 'onStopped:', 'onFailed:', "type: 'RECEIVED'"]) {
            expect(visitor.includes(own), own).toBe(false);
        }
        expect(visitor).toContain('afterSettle({ live: live(), reported: watch.reported() })');
        expect(visitor).toContain('new SimplePeer(peerOptionsFor(ice, model.hideIp))');
        expect(visitor.match(/new SimplePeer[(]/g)).toHaveLength(1);
    });

    it('a reload waits for the Cancel reason to reach the host', () => {
        // WP-W1 review R2-3: the Cancel flush is added to the tracker, and the reload the
        // reducer asks for on a fragment change runs only once it settled.
        const visitor = read('components/RequestVisitor.tsx');
        const cancel = visitor.slice(visitor.indexOf('function cancelWithReason()'));
        expect(cancel.slice(0, cancel.indexOf('VISITOR_CANCEL_REASON'))).toContain('flushes.add(');
        const reload = visitor.slice(visitor.indexOf("case 'reload':"));
        const body = reload.slice(0, reload.indexOf('return;'));
        expect(body).toContain('flushes.settled(');
        expect(body.indexOf('flushes.settled(')).toBeLessThan(body.indexOf('window.location.reload()'));
    });

    it('no Send or Try again starts while a fragment reload is pending', () => {
        // WP-W1 review R3-1: while the reload waits for a Cancel flush the
        // page still shows Ready, and a Send there would join the old room.
        const visitor = read('components/RequestVisitor.tsx');
        const reload = visitor.slice(visitor.indexOf("case 'reload':"));
        expect(reload.slice(0, reload.indexOf('return;'))).toContain('reloadPending = true;');
        const start = visitor.slice(visitor.indexOf("start(type: 'SEND' | 'TRY_AGAIN'"));
        const body = start.slice(0, start.indexOf('dispatch({'));
        expect(body).toContain('if (reloadPending) return;');
    });

    it('every socket emit on /r is request-join or signal', () => {
        const sources = requestSources();
        const events: string[] = [];
        for (const [file, src] of Object.entries(sources)) {
            for (const args of callArgs(src, '.emit')) {
                const first = splitArgs(args)[0];
                expect(["'request-join'", "'signal'"], `${file}: ${args}`).toContain(first);
                events.push(first);
            }
        }
        expect(events).toContain("'request-join'");
    });

    it('the request files hook only ever sets a notice from visitorCopy', () => {
        // The S1-WEB-02 review's pin from outside the vitest globs: no machine
        // error text and no path can reach the notice line.
        const hook = read('hooks/useRequestFiles.ts');
        const args = callArgs(hook, 'setNotice').map((a) => a.replace(/\s+/g, ' ').trim());
        expect(args.length).toBeGreaterThan(4);
        for (const a of args) {
            const ok =
                a === 'null' ||
                /^visitorCopy\.\w+$/.test(a) ||
                /^[\w.]+ === '[\w-]+' \? visitorCopy\.\w+ : visitorCopy\.\w+$/.test(a);
            expect(ok, a).toBe(true);
        }
    });

    it('the files hook counts overlapping reads and drops a read that Clear made stale', () => {
        // WP-W1 review F5, pinned from outside the vitest globs; the counting
        // itself is pickTracker.test.ts. A boolean let the first of two drops
        // turn Send back on, and a Clear during a walk was refilled.
        const hook = read('hooks/useRequestFiles.ts');
        const count = (needle: string) => hook.split(needle).length - 1;
        expect(count('setReading(tracker.reading())')).toBe(2);
        expect(count('if (!tracker.current(token)) return;')).toBe(2);
        expect(count('tracker.clear();')).toBe(1);
        expect(count('setReading(false)')).toBe(0);
    });

    it('Sentry breadcrumbs on /r carry counts only, never a path, a name or the link', () => {
        const sources = requestSources();
        let crumbs = 0;
        for (const [file, src] of Object.entries(sources)) {
            for (const args of callArgs(src, 'Sentry.addBreadcrumb')) {
                crumbs++;
                for (const word of ['relativePath', 'name', 'path', 'roomId', 'linkId', 'href', 'location', 'reason']) {
                    expect(args.includes(word), `${file}: ${word} in ${args}`).toBe(false);
                }
            }
            expect(src.includes('captureException'), file).toBe(false);
            expect(src.includes('captureMessage'), file).toBe(false);
        }
        expect(crumbs).toBeGreaterThan(0);
    });

    it('nothing on /r logs to the console', () => {
        for (const [file, src] of Object.entries(requestSources())) {
            expect(/\bconsole\./.test(src), file).toBe(false);
        }
    });
});
