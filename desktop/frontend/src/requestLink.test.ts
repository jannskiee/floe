import {describe, expect, it} from 'vitest';
import {
    OFF_SNAPSHOT,
    acceptedPrompt,
    acceptStale,
    canMake,
    DEFAULT_LIFETIME,
    errorCode,
    etaLines,
    guardActive,
    initialRequestUI,
    isLifetime,
    LIFETIMES,
    linkOpen,
    noticeVisible,
    normalizeSnapshot,
    phase,
    reduce,
    requestLinkKind,
    showLaptopLine,
    type RequestEvent,
    type RequestLinkSnapshot,
    type RequestUI,
} from './requestLink';
import {LIFETIME_1H, LIFETIME_24H, LIFETIME_30M, LIFETIME_3D, LIFETIME_7D, LIFETIME_8H} from './requestCopy';

// A request link or a drop link pasted into Receive > CODE (S1-DSK-07). String
// inputs only: nothing here opens or fetches anything, and the floe.one form
// appears only as a string (L-10).
describe('requestLinkKind', () => {
    const room = '6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';

    it('requestLinkKind recognizes /r/, /d/ and /drop including a self-hosted base path', () => {
        expect(requestLinkKind(`https://floe.one/r/Xk3p9Q0aB1c#${room}`)).toBe('request');
        expect(requestLinkKind(`https://www.floe.one/r/Xk3p9Q0aB1c/#${room}`)).toBe('request');
        expect(requestLinkKind(`http://localhost:3000/r/Xk3p9Q0aB1c#${room}`)).toBe('request');
        expect(requestLinkKind(`https://files.example.com/floe/r/Xk3p9Q0aB1c#${room}`)).toBe('request');
        // Surrounding whitespace from a paste, and no fragment at all.
        expect(requestLinkKind(`  https://floe.one/r/Xk3p9Q0aB1c  `)).toBe('request');
        expect(requestLinkKind('https://floe.one/d/aBcD1234#k=s3cr3t')).toBe('drop');
        expect(requestLinkKind('https://floe.one/drop/aBcD1234')).toBe('drop');
        expect(requestLinkKind('https://files.example.com/floe/drop/aBcD1234/')).toBe('drop');
    });

    it('requestLinkKind rejects a 10-character id, a #room= link and non-http schemes', () => {
        expect(requestLinkKind(`https://floe.one/r/Xk3p9Q0aB1#${room}`)).toBeNull(); // 10 characters
        expect(requestLinkKind(`https://floe.one/r/Xk3p9Q0aB1cc#${room}`)).toBeNull(); // 12 characters
        expect(requestLinkKind(`https://floe.one/?s=abc#room=${room}`)).toBeNull();
        expect(requestLinkKind(`https://floe.one/#room=${room}`)).toBeNull();
        expect(requestLinkKind('file:///C:/r/Xk3p9Q0aB1c')).toBeNull();
        expect(requestLinkKind('javascript:alert(1)//r/Xk3p9Q0aB1c')).toBeNull();
        expect(requestLinkKind('floe://x/r/Xk3p9Q0aB1c')).toBeNull();
        expect(requestLinkKind('amber-otter-cloud')).toBeNull();
        expect(requestLinkKind('')).toBeNull();
        // The id in a query or the fragment is not a path.
        expect(requestLinkKind(`https://floe.one/?r=Xk3p9Q0aB1c#/r/Xk3p9Q0aB1c`)).toBeNull();
        expect(requestLinkKind('https://floe.one/rr/Xk3p9Q0aB1c')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// The reducer, one case per remaining transition of spec 06 6.3 (T11 and T25
// were removed by E-34; T8 also covers reconnecting reaching the link end).

const snap = (over: Partial<RequestLinkSnapshot>): RequestLinkSnapshot => ({...OFF_SNAPSHOT, ...over});
const run = (ui: RequestUI, ...events: RequestEvent[]) => events.reduce(reduce, ui);
const at = (state: string, over: Partial<RequestLinkSnapshot> = {}) => (ui: RequestUI) =>
    reduce(ui, {type: 'SNAPSHOT', snap: snap({state, gen: ui.snap.gen, ...over})});

// An idle lane, nothing probed: the Ready baseline most transitions start from.
const ready = initialRequestUI;
const waiting = run(ready, {type: 'MAKE'}, {type: 'SNAPSHOT', snap: snap({state: 'waiting', gen: 1, link: 'l', expiresAt: 9})}, {type: 'MAKE_DONE'});
const deciding = at('deciding', {promptGen: 1, prompt: {files: 12, totalBytes: 1, folder: 'f', freeBytes: 1, warnings: [], answerBy: 1}})(waiting);
const receiving = at('receiving', {route: 'direct'})(deciding);
const result = {files: 12, saved: 12, bytes: 1, verified: 12, renamed: 0, folder: 'D:\\f', names: []};

describe('an idle lane (H7 S-1)', () => {
    it('an idle lane is ready with no switch and no probe', () => {
        expect(phase(initialRequestUI)).toBe('ready');
        for (const state of ['off', 'ready']) {
            expect(phase(reduce(initialRequestUI, {type: 'SNAPSHOT', snap: snap({state})})), state).toBe('ready');
        }
    });

    it('a result put away returns to ready, not off', () => {
        const refused = run(initialRequestUI, {type: 'MAKE'}, {type: 'SNAPSHOT', snap: snap({state: 'error', code: 'disabled', gen: 1})}, {type: 'MAKE_DONE'});
        expect(phase(refused)).toBe('error');
        expect(phase(reduce(refused, {type: 'MAKE_ANOTHER'}))).toBe('ready');
        const done = run(initialRequestUI, {type: 'MAKE'}, {type: 'SNAPSHOT', snap: snap({state: 'done', gen: 1, result})}, {type: 'MAKE_DONE'});
        expect(phase(done)).toBe('done');
        expect(phase(reduce(done, {type: 'MAKE_ANOTHER'}))).toBe('ready');
    });

    it('an unknown state from the bridge reads as an idle lane, never as a link', () => {
        const odd = reduce(initialRequestUI, {type: 'SNAPSHOT', snap: normalizeSnapshot({state: 'pwned'})});
        expect(odd.snap.state).toBe('off');
        expect(phase(odd)).toBe('ready');
    });
});

describe('the request lane reducer', () => {
    it('T3 Make link then a waiting snapshot shows Waiting with the link open', () => {
        const making = reduce(ready, {type: 'MAKE'});
        expect(phase(making)).toBe('making');
        expect(phase(waiting)).toBe('waiting');
        expect(linkOpen(waiting.snap.state)).toBe(true);
    });

    it('T4 a refusal snapshot shows Error with its code', () => {
        const e = run(ready, {type: 'MAKE'}, {type: 'SNAPSHOT', snap: snap({state: 'error', code: 'limited', gen: 1})}, {type: 'MAKE_DONE'});
        expect(phase(e)).toBe('error');
        expect(errorCode(e)).toBe('limited');
    });

    it('T4 a Make link call that fails outright shows the unknown error', () => {
        const e = run(ready, {type: 'MAKE'}, {type: 'MAKE_FAILED'});
        expect(phase(e)).toBe('error');
        expect(errorCode(e)).toBe('unknown');
    });

    it('T5 an edit or ACK_ERROR returns Error to Ready', () => {
        const e = run(ready, {type: 'SNAPSHOT', snap: snap({state: 'error', code: 'disabled', gen: 1})});
        expect(phase(reduce(e, {type: 'ACK_ERROR'}))).toBe('ready');
        // A re-emitted copy of the same refusal stays put away.
        const again = reduce(reduce(e, {type: 'ACK_ERROR'}), {type: 'SNAPSHOT', snap: snap({state: 'error', code: 'disabled', gen: 1})});
        expect(phase(again)).toBe('ready');
    });

    it('T6 waiting to connecting', () => {
        expect(phase(at('connecting')(waiting))).toBe('connecting');
    });

    it('T7 waiting to reconnecting', () => {
        const r = at('reconnecting', {reconnectUntil: 9})(waiting);
        expect(phase(r)).toBe('reconnecting');
        expect(linkOpen(r.snap.state)).toBe(true);
    });

    it('T8 waiting ends as expired at the link end', () => {
        const x = at('ended', {code: 'expired'})(waiting);
        expect(phase(x)).toBe('ended');
        expect(linkOpen(x.snap.state)).toBe(false);
    });

    it('reconnecting ends as expired at the link end (E-34)', () => {
        const x = at('ended', {code: 'expired'})(at('reconnecting')(waiting));
        expect(phase(x)).toBe('ended');
        expect(x.snap.code).toBe('expired');
    });

    it('T9 Close link then an ended closed snapshot', () => {
        const c = run(waiting, {type: 'CLOSE'});
        expect(c).toBe(waiting); // nothing changes until Go answers
        expect(phase(at('ended', {code: 'closed'})(c))).toBe('ended');
    });

    it('T10 reconnecting back to waiting', () => {
        expect(phase(at('waiting')(at('reconnecting')(waiting)))).toBe('waiting');
    });

    it('T12 connecting to deciding with the prompt', () => {
        expect(phase(deciding)).toBe('deciding');
        expect(noticeVisible(deciding.snap, false, false)).toBe(true);
    });

    it('T13 a setup failure reopens the link as waiting with its code', () => {
        const w = at('waiting', {code: 'setup-failed'})(at('connecting')(waiting));
        expect(phase(w)).toBe('waiting');
        expect(w.snap.code).toBe('setup-failed');
    });

    it('T14 Accept then a receiving snapshot', () => {
        const a = reduce(deciding, {type: 'ANSWER', answer: 'accept'});
        expect(a).toBe(deciding);
        expect(phase(receiving)).toBe('receiving');
    });

    it('T15 Decline then a declined snapshot', () => {
        const d = at('declined')(reduce(deciding, {type: 'ANSWER', answer: 'decline'}));
        expect(phase(d)).toBe('declined');
    });

    it('T16 a missed or abandoned request reopens the link as waiting', () => {
        expect(phase(at('waiting', {missedAt: 5})(deciding))).toBe('waiting');
        expect(phase(at('waiting', {code: 'visitor-left'})(deciding))).toBe('waiting');
    });

    it('T17 Keep waiting after a decline', () => {
        const d = at('declined')(deciding);
        expect(phase(at('waiting')(reduce(d, {type: 'ANSWER', answer: 'keep-waiting'})))).toBe('waiting');
    });

    it('T18 Close link after a decline', () => {
        const d = at('declined')(deciding);
        expect(phase(at('ended', {code: 'closed'})(reduce(d, {type: 'ANSWER', answer: 'close'})))).toBe('ended');
    });

    it('T19 receiving to done with the result', () => {
        const done = at('done', {result})(receiving);
        expect(phase(done)).toBe('done');
        expect(done.snap.result?.verified).toBe(12);
    });

    it('T20 Cancel drop, or a stop, ends as stopped with its code', () => {
        const c = reduce(receiving, {type: 'CANCEL_DROP'});
        expect(c).toBe(receiving);
        const s = at('stopped', {code: 'stopped', result: {...result, saved: 4}})(c);
        expect(phase(s)).toBe('stopped');
        expect(s.snap.code).toBe('stopped');
    });

    it('T21 Make another link after done or stopped returns to Ready', () => {
        expect(phase(reduce(at('done', {result})(receiving), {type: 'MAKE_ANOTHER'}))).toBe('ready');
        expect(phase(reduce(at('stopped', {code: 'disk-full', result})(receiving), {type: 'MAKE_ANOTHER'}))).toBe('ready');
    });

    it('T22 Make another link after an ended link returns to Ready', () => {
        expect(phase(reduce(at('ended', {code: 'expired'})(waiting), {type: 'MAKE_ANOTHER'}))).toBe('ready');
    });

    it('T23 guard ticks and focus changes leave the state alone', () => {
        for (const ui of [deciding, at('declined')(deciding), waiting]) {
            expect(reduce(ui, {type: 'GUARD_TICK'})).toBe(ui);
            expect(reduce(ui, {type: 'WINDOW_FOCUS'})).toBe(ui);
        }
    });

    it('T24 the kill switch while waiting shows the disabled error', () => {
        const e = at('error', {code: 'disabled'})(waiting);
        expect(phase(e)).toBe('error');
        expect(errorCode(e)).toBe('disabled');
    });

    it('T26 the link end passing mid-prompt or mid-drop changes nothing locally', () => {
        // The frontend keeps no clock of its own for the link: Go decides.
        expect(phase(deciding)).toBe('deciding');
        expect(phase(receiving)).toBe('receiving');
    });

    it('stale snapshot with a lower gen is ignored', () => {
        const later = reduce(waiting, {type: 'SNAPSHOT', snap: snap({state: 'waiting', gen: 5})});
        const stale = reduce(later, {type: 'SNAPSHOT', snap: snap({state: 'ended', code: 'closed', gen: 4})});
        expect(stale).toBe(later);
        expect(acceptStale(snap({gen: 5}), snap({gen: 4}))).toBe(false);
        expect(acceptStale(snap({gen: 5}), snap({gen: 5}))).toBe(true);
        expect(acceptStale(snap({gen: 5}), snap({gen: 6}))).toBe(true);
    });

    it('a same-gen answer older than an adopted event is ignored', () => {
        // D-115: AnswerRequest(accept) returns the snapshot as it stood when
        // the answer was queued (deciding) while the lane emits receiving; if
        // the event lands first, the late reply must not bring the prompt back.
        const r = reduce(deciding, {type: 'SNAPSHOT', snap: snap({state: 'receiving', gen: 1, seq: 6})});
        const late = reduce(r, {type: 'SNAPSHOT', snap: snap({state: 'deciding', gen: 1, seq: 5, promptGen: 1, prompt: deciding.snap.prompt})});
        expect(late).toBe(r);
        expect(phase(late)).toBe('receiving');
        // A later snapshot of the same gen is adopted; the same one again is
        // a re-delivery and changes nothing that matters.
        expect(phase(reduce(r, {type: 'SNAPSHOT', snap: snap({state: 'done', gen: 1, seq: 7, result})}))).toBe('done');
        expect(phase(reduce(r, {type: 'SNAPSHOT', snap: snap({state: 'receiving', gen: 1, seq: 6})}))).toBe('receiving');
        expect(acceptStale(snap({gen: 1, seq: 6}), snap({gen: 1, seq: 5}))).toBe(false);
        expect(acceptStale(snap({gen: 1, seq: 6}), snap({gen: 2, seq: 0}))).toBe(true);
    });

    it('T28 Make another link puts the result away and returns to Ready (the only way since D-169)', () => {
        const done = at('done', {result})(receiving);
        const dismissed = reduce(done, {type: 'MAKE_ANOTHER'});
        expect(phase(dismissed)).toBe('ready');
        // Go re-emitting the same terminal snapshot does not bring it back.
        expect(phase(at('done', {result})(dismissed))).toBe('ready');
        // It means nothing while a link is live.
        expect(reduce(waiting, {type: 'MAKE_ANOTHER'})).toBe(waiting);
    });

    it('a new Make link hides the previous result at once', () => {
        const done = at('done', {result})(receiving);
        const making = reduce(done, {type: 'MAKE'});
        expect(phase(making)).toBe('making');
        expect(phase(reduce(making, {type: 'MAKE_DONE'}))).toBe('ready');
    });

    it('keeps the accepted prompt count and folder for this generation only (D-136)', () => {
        // Receiving names them before the first progress event, from the
        // prompt the owner answered, since the receiving snapshot need not
        // carry it.
        expect(acceptedPrompt(waiting)).toBeNull();
        expect(acceptedPrompt(deciding)).toEqual({files: 12, folder: 'f'});
        expect(receiving.snap.prompt).toBeUndefined();
        expect(acceptedPrompt(receiving)).toEqual({files: 12, folder: 'f'});
        // A later prompt of the same link replaces it.
        const second = at('deciding', {promptGen: 2, prompt: {files: 3, totalBytes: 1, folder: 'g', freeBytes: 1, warnings: [], answerBy: 1}})(at('waiting')(deciding));
        expect(acceptedPrompt(at('receiving')(second))).toEqual({files: 3, folder: 'g'});
        // A new link generation forgets it: the reducer drops it from the
        // state, and the selector never hands out another generation's.
        const next = reduce(receiving, {type: 'SNAPSHOT', snap: snap({state: 'waiting', gen: 2})});
        expect(next.accepted).toBeNull();
        expect(acceptedPrompt(next)).toBeNull();
        expect(acceptedPrompt(reduce(next, {type: 'SNAPSHOT', snap: snap({state: 'receiving', gen: 2})}))).toBeNull();
        expect(acceptedPrompt({...next, accepted: {gen: 1, files: 12, folder: 'f'}})).toBeNull();
        // A stale snapshot changes nothing, the kept prompt included.
        const stale = snap({state: 'deciding', gen: 0, prompt: {files: 99, totalBytes: 1, folder: 'x', freeBytes: 1, warnings: [], answerBy: 1}});
        expect(reduce(receiving, {type: 'SNAPSHOT', snap: stale})).toBe(receiving);
    });
});

describe('the request lane selectors', () => {
    it('guardActive is true for 1 s after render and after focus returns', () => {
        expect(guardActive(1000, 1000, null)).toBe(true);
        expect(guardActive(1999, 1000, null)).toBe(true);
        expect(guardActive(2000, 1000, null)).toBe(false);
        expect(guardActive(5000, 1000, 4500)).toBe(true);
        expect(guardActive(5500, 1000, 4500)).toBe(false);
    });

    it('etaLines shows nothing before 60 s', () => {
        const r = receiving.snap;
        expect(etaLines(r, 30 * 3600, 59)).toEqual([]);
        expect(etaLines(r, 3 * 3600, 0)).toEqual([]);
        expect(etaLines(r, Infinity, 120)).toEqual([]);
        // Only a receiving drop has a time left.
        expect(etaLines(waiting.snap, 30 * 3600, 600)).toEqual([]);
    });

    it('etaLines thresholds at 2 h and 24 h', () => {
        const r = receiving.snap;
        expect(etaLines(r, 2 * 3600, 60)).toEqual([]);
        expect(etaLines(r, 2 * 3600 + 1, 60)).toEqual([
            'If the connection drops, the current file starts over',
        ]);
        expect(etaLines(r, 24 * 3600, 60)).toHaveLength(1);
        expect(etaLines(r, 3 * 86400, 60)).toEqual([
            'About 3 days at this speed, past the 24-hour limit',
        ]);
    });

    it('showLaptopLine needs a battery, a receiving drop, 60 s of data and more than 5 min left (P11)', () => {
        const on = {...receiving.snap, battery: true};
        const off = {...receiving.snap, battery: false};
        expect(showLaptopLine(on, 5 * 60 + 1, 60)).toBe(true);
        expect(showLaptopLine(on, 5 * 60, 60)).toBe(false);
        expect(showLaptopLine(on, 3 * 86400, 600)).toBe(true);
        // The same noise guard as etaLines: nothing in the first minute.
        expect(showLaptopLine(on, 3600, 59)).toBe(false);
        expect(showLaptopLine(on, Infinity, 120)).toBe(false);
        expect(showLaptopLine(on, NaN, 120)).toBe(false);
        // A PC with no battery never sees it, and only a receiving drop has a time left.
        expect(showLaptopLine(off, 3600, 120)).toBe(false);
        expect(showLaptopLine({...waiting.snap, battery: true}, 3600, 120)).toBe(false);
    });

    it('a link is open from Waiting to Receiving only (the close guard and the Receive tab description)', () => {
        for (const s of ['waiting', 'reconnecting', 'connecting', 'deciding', 'declined', 'receiving']) {
            expect(linkOpen(s), s).toBe(true);
        }
        for (const s of ['off', 'ready', 'making', 'error', 'done', 'stopped', 'ended']) {
            expect(linkOpen(s), s).toBe(false);
        }
    });

    it('the notice hides only when the prompt is in view on REQUEST LINK', () => {
        expect(noticeVisible(deciding.snap, true, true)).toBe(false);
        expect(noticeVisible(deciding.snap, true, false)).toBe(true);
        expect(noticeVisible(deciding.snap, false, true)).toBe(true);
        expect(noticeVisible(waiting.snap, false, false)).toBe(false);
    });

    it('Make link is offered only with nothing open', () => {
        expect(canMake('ready')).toBe(true);
        expect(canMake('error')).toBe(true);
        for (const p of ['making', 'waiting', 'deciding', 'receiving', 'done'] as const) expect(canMake(p)).toBe(false);
    });

    it('normalizeSnapshot reads the battery fact as a boolean and nothing else as true', () => {
        expect(OFF_SNAPSHOT.battery).toBe(false);
        expect(normalizeSnapshot({state: 'receiving', battery: true}).battery).toBe(true);
        for (const junk of [undefined, null, 0, 1, 'true', 'yes', {}, []]) {
            expect(normalizeSnapshot({state: 'receiving', battery: junk}).battery, String(junk)).toBe(false);
        }
    });

    it('normalizeSnapshot hides the not-scanned line only for an explicit false: absent or junk shows it (S-7, RC-2)', () => {
        const result = (v: unknown) => normalizeSnapshot({state: 'done', result: {files: 1, saved: 1, noNamedStreams: v}}).result;
        expect(result(false)?.noNamedStreams).toBe(false);
        expect(result(true)?.noNamedStreams).toBe(true);
        for (const junk of [undefined, null, 0, 1, 'true', 'false', {}, []]) {
            expect(result(junk)?.noNamedStreams, String(junk)).toBe(true);
        }
        // The key missing altogether reads the same way as junk.
        expect(normalizeSnapshot({state: 'done', result: {files: 1, saved: 1}}).result?.noNamedStreams).toBe(true);
    });

    it('normalizeSnapshot turns junk from the bridge into a renderable off snapshot', () => {
        expect(normalizeSnapshot(null)).toEqual(OFF_SNAPSHOT);
        expect(normalizeSnapshot({state: 'pwned', gen: 'x', prompt: {warnings: [1, 'low-space']}, result: {names: ['a', 2]}})).toMatchObject({
            state: 'off',
            gen: 0,
            prompt: {warnings: ['low-space'], files: 0},
            result: {names: ['a'], files: 0},
        });
    });
});

describe('the saved files beside their sizes (D-171)', () => {
    it('normalizeSnapshot keeps sizes beside names, and a junk name drops with its size', () => {
        const s = normalizeSnapshot({state: 'done', result: {saved: 3, names: ['a', 7, 'b', 'c'], sizes: [1, 2, 'x', -5]}});
        expect(s.result!.names).toEqual(['a', 'b', 'c']);
        expect(s.result!.sizes).toEqual([1, -1, -1]);
        // A result without sizes (an older build) reads -1 for every name.
        expect(normalizeSnapshot({state: 'done', result: {names: ['a', 'b']}}).result!.sizes).toEqual([-1, -1]);
        expect(normalizeSnapshot({state: 'done', result: {names: 'a', sizes: 3}}).result!).toMatchObject({names: [], sizes: []});
    });
});

describe('the Link ends choices (D-173)', () => {
    it('LIFETIMES lists the six keys in the approved order, each with its own label', () => {
        // R24, R25, R26, R12, R27, R13: the keys Go's requestLifetime takes.
        expect(LIFETIMES.map((l) => l.key)).toEqual(['30m', '1h', '8h', '24h', '3d', '7d']);
        expect(LIFETIMES.map((l) => l.label)).toEqual([LIFETIME_30M, LIFETIME_1H, LIFETIME_8H, LIFETIME_24H, LIFETIME_3D, LIFETIME_7D]);
        expect(LIFETIMES.map((l) => l.label)).toEqual(['In 30 minutes', 'In 1 hour', 'In 8 hours', 'In 24 hours', 'In 3 days', 'In 7 days']);
        expect(Object.isFrozen(LIFETIMES)).toBe(true);
    });

    it('the default is 24h, one of the six', () => {
        expect(DEFAULT_LIFETIME).toBe('24h');
        expect(isLifetime(DEFAULT_LIFETIME)).toBe(true);
    });

    it('isLifetime takes the six keys and nothing else', () => {
        for (const {key} of LIFETIMES) expect(isLifetime(key), key).toBe(true);
        // "" means 24h to Go, but the frontend always sends a key of its own.
        for (const junk of ['', '15m', '1d', '24H', ' 24h', '720h', '-1h', '8d', '12h', 'In 24 hours', 24, null, undefined, {}, ['24h']]) {
            expect(isLifetime(junk), String(junk)).toBe(false);
        }
    });
});

describe('Auto-accept on the bridge (D-173)', () => {
    it('normalizeSnapshot reads the link\'s switch as true only when the bridge says true (G1)', () => {
        expect(OFF_SNAPSHOT.autoAccept).toBe(false);
        expect(normalizeSnapshot({state: 'waiting', autoAccept: true}).autoAccept).toBe(true);
        for (const junk of [false, 'true', 1, null, undefined, {}, []]) {
            expect(normalizeSnapshot({state: 'waiting', autoAccept: junk}).autoAccept, String(junk)).toBe(false);
        }
        expect(normalizeSnapshot({state: 'waiting'}).autoAccept).toBe(false);
    });

    it('normalizeSnapshot reads the drop\'s own mark just as strictly (HA1)', () => {
        expect(normalizeSnapshot({state: 'done', result: {autoAccepted: true}}).result?.autoAccepted).toBe(true);
        for (const junk of [false, 'true', 1, null, undefined, {}, []]) {
            expect(normalizeSnapshot({state: 'done', result: {autoAccepted: junk}}).result?.autoAccepted, String(junk)).toBe(false);
        }
    });
});
