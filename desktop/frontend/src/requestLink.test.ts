import {describe, expect, it} from 'vitest';
import {
    OFF_SNAPSHOT,
    acceptStale,
    canMake,
    errorCode,
    etaLines,
    guardActive,
    initialRequestUI,
    markerVisible,
    noticeVisible,
    normalizeSnapshot,
    phase,
    reduce,
    requestLinkKind,
    settingsLocked,
    showRow,
    type RequestEvent,
    type RequestLinkSnapshot,
    type RequestUI,
    viewSnapshot,
} from './requestLink';

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

// Switch on, request-1 listed: the Ready baseline most transitions start from.
const ready = run(initialRequestUI, {type: 'FEATURE', switchOn: true, requestLinks: true});
const waiting = run(ready, {type: 'MAKE'}, {type: 'SNAPSHOT', snap: snap({state: 'waiting', gen: 1, link: 'l', expiresAt: 9})}, {type: 'MAKE_DONE'});
const deciding = at('deciding', {promptGen: 1, prompt: {files: 12, totalBytes: 1, folder: 'f', freeBytes: 1, warnings: [], answerBy: 1}})(waiting);
const receiving = at('receiving', {route: 'direct'})(deciding);
const result = {files: 12, saved: 12, bytes: 1, verified: 12, renamed: 0, folder: 'D:\\f', names: []};

describe('the request lane reducer', () => {
    it('T1 feature on shows Ready', () => {
        expect(phase(initialRequestUI)).toBe('off');
        expect(phase(ready)).toBe('ready');
    });

    it('T2 switch off or feature missing goes back to Off', () => {
        expect(phase(reduce(ready, {type: 'FEATURE', switchOn: false}))).toBe('off');
        expect(phase(reduce(ready, {type: 'FEATURE', requestLinks: false}))).toBe('off');
    });

    it('T3 Make link then a waiting snapshot shows Waiting with the marker', () => {
        const making = reduce(ready, {type: 'MAKE'});
        expect(phase(making)).toBe('making');
        expect(phase(waiting)).toBe('waiting');
        expect(markerVisible(waiting.snap)).toBe(true);
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
        expect(markerVisible(r.snap)).toBe(true);
    });

    it('T8 waiting ends as expired at the link end', () => {
        const x = at('ended', {code: 'expired'})(waiting);
        expect(phase(x)).toBe('ended');
        expect(markerVisible(x.snap)).toBe(false);
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

    it('T28 dismiss returns to Ready', () => {
        const done = at('done', {result})(receiving);
        const dismissed = reduce(done, {type: 'DISMISS'});
        expect(phase(dismissed)).toBe('ready');
        // Go re-emitting the same terminal snapshot does not bring it back.
        expect(phase(at('done', {result})(dismissed))).toBe('ready');
        // Dismiss means nothing while a link is live.
        expect(reduce(waiting, {type: 'DISMISS'})).toBe(waiting);
    });

    it('a new Make link hides the previous result at once', () => {
        const done = at('done', {result})(receiving);
        const making = reduce(done, {type: 'MAKE'});
        expect(phase(making)).toBe('making');
        expect(phase(reduce(making, {type: 'MAKE_DONE'}))).toBe('ready');
    });

    it('the next launch after Floe closed with a link open shows the X5 end once', () => {
        const x = reduce(ready, {type: 'RELAUNCH'});
        expect(phase(x)).toBe('ended');
        expect(viewSnapshot(x)).toMatchObject({state: 'ended', code: 'app-closed', label: ''});
        // Go's first snapshot at launch has nothing to say and does not erase it.
        const pulled = reduce(x, {type: 'SNAPSHOT', snap: snap({state: 'off', gen: 0})});
        expect(phase(pulled)).toBe('ended');
        expect(phase(reduce(pulled, {type: 'MAKE_ANOTHER'}))).toBe('ready');
        expect(viewSnapshot(reduce(pulled, {type: 'MAKE_ANOTHER'})).state).toBe('off');
        // A real link replaces it.
        expect(phase(reduce(x, {type: 'SNAPSHOT', snap: snap({state: 'waiting', gen: 1})}))).toBe('waiting');
        // Never over a lane that has something to say.
        expect(reduce(waiting, {type: 'RELAUNCH'})).toBe(waiting);
    });
});

describe('the request lane selectors', () => {
    it('showRow keeps the row while a drop runs after request-1 disappears', () => {
        for (const s of ['making', 'waiting', 'reconnecting', 'connecting', 'deciding', 'declined', 'receiving', 'done', 'stopped']) {
            expect(showRow(true, false, s), s).toBe(true);
        }
        expect(showRow(true, false, 'off')).toBe(false);
        expect(showRow(true, false, 'ended')).toBe(false);
        expect(showRow(true, true, 'off')).toBe(true);
    });

    it('showRow hides the row when the switch is off', () => {
        for (const s of ['off', 'ready', 'waiting', 'receiving', 'done']) {
            expect(showRow(false, true, s), s).toBe(false);
        }
    });

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
            'If the connection drops, the file that was moving starts over. Windows may restart for updates outside your active hours.',
        ]);
        expect(etaLines(r, 24 * 3600, 60)).toHaveLength(1);
        expect(etaLines(r, 3 * 86400, 60)).toEqual([
            'This drop would take about 3 days on this connection and will stop at 24 hours.',
        ]);
    });

    it('the marker shows from Waiting to Receiving only', () => {
        for (const s of ['waiting', 'reconnecting', 'connecting', 'deciding', 'declined', 'receiving']) {
            expect(markerVisible(snap({state: s})), s).toBe(true);
        }
        for (const s of ['off', 'ready', 'making', 'error', 'done', 'stopped', 'ended']) {
            expect(markerVisible(snap({state: s})), s).toBe(false);
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

    it('the Settings switch locks from making a link until its result is put away', () => {
        for (const p of ['making', 'waiting', 'deciding', 'receiving', 'done', 'stopped'] as const) expect(settingsLocked(p)).toBe(true);
        for (const p of ['off', 'ready', 'error', 'ended'] as const) expect(settingsLocked(p)).toBe(false);
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
