import { describe, it, expect } from 'vitest';
import {
    visitorCopy,
    countLine,
    sendLabel,
    countdownLine,
    sendingHeader,
    progressParts,
    refusalCopy,
    statusCopy,
    announcement,
    displayPath,
    type StatusContext,
} from './visitorCopy';
import { reduce, initialModel, type VisitorModel, type VisitorEvent } from './visitorState';
import { checkPick } from './metadataBudget';

// The visitor page never renders a peer-supplied string. Everything it shows
// comes from the frozen Checkpoint C web copy table (D-091, with the stop
// confirmation from D-096 and the /r polish rows from D-136), chosen by an
// allowlisted code or a state, with only clamped counts and the visitor's OWN
// relative paths filled in.

const ROOM = '6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';
const CTX: StatusContext = {
    pathAt: (i) => ['shoot/A001_C002.mov', 'shoot/A001_C003.mov', 'shoot/A002_C001.mov'][i - 1],
    route: 'direct',
    now: 0,
};

const THIRTEEN = [
    'declined', 'disk-full', 'expired', 'file-too-large-for-folder', 'hash-mismatch', 'over-approved',
    'path-too-long', 'relay-cap', 'save-blocked', 'stopped', 'time-limit', 'unverified', 'write-failed',
] as const;

const UNKNOWN = 'The drop stopped on their computer.';

function model(state: VisitorModel['state'], patch: Partial<VisitorModel> = {}): VisitorModel {
    return { ...initialModel, state, roomId: ROOM, attempt: 1, total: 12, size: 1000, ...patch };
}

/** Every string a status card, its announcement and the Ready controls can
 *  put on screen for this model. */
function everythingShown(m: VisitorModel): string {
    return JSON.stringify([statusCopy(m, CTX), announcement(m, CTX)]);
}

describe('visitor copy: the refusal table (spec 07 4.15.2)', () => {
    it('every refusal code has fixed copy', () => {
        const titles: Record<(typeof THIRTEEN)[number], string> = {
            declined: 'They declined. Nothing was sent.',
            expired: 'They did not answer in time. Nothing was sent.',
            'disk-full': 'Their computer ran out of space',
            'write-failed': 'Their computer could not save a file',
            'hash-mismatch': 'A file changed or was damaged on the way, so their Floe deleted it',
            'relay-cap': 'Relayed drops are capped at 2 GB',
            'path-too-long': 'A file name or folder path is too long for their computer',
            'file-too-large-for-folder': 'A file is too large for the drive they save to',
            'save-blocked': 'Their computer blocked saving a file',
            'over-approved': 'More data arrived than they accepted',
            stopped: 'They stopped this drop.',
            'time-limit': 'This drop reached the 24-hour limit',
            unverified: "Their computer couldn't confirm this link",
        };
        for (const code of THIRTEEN) {
            const copy = refusalCopy(code, 4, 12);
            expect(copy.title, code).toBe(titles[code]);
            // No code falls through to the generic sentence.
            expect(copy.title).not.toBe(UNKNOWN);
        }
        // The two answers before accept carry no saved line.
        expect(refusalCopy('declined', 4, 12).lines).toEqual([]);
        expect(refusalCopy('expired', 4, 12).lines).toEqual([]);
        // The saved line, and the one code that adds the ask.
        expect(refusalCopy('disk-full', 4, 12).lines).toEqual(['4 of 12 files were saved.']);
        expect(refusalCopy('disk-full', 0, 12).lines).toEqual(['Nothing was sent.']);
        expect(refusalCopy('hash-mismatch', 4, 12).lines).toEqual([
            '4 of 12 files were saved.',
            'Ask them for a new link to send the rest.',
        ]);
        // "2 GB or less", not "under 2 GB": the gate is strictly greater-than,
        // so a drop of exactly 2 GB goes through a relay.
        expect(refusalCopy('relay-cap', 0, 12).lines).toEqual(['Nothing was sent. Send 2 GB or less.']);
        expect(refusalCopy('relay-cap', 3, 12).lines).toEqual(['3 of 12 files were saved.']);
        expect(refusalCopy('disk-full', 4, 12).showArrived).toBe(true);
        expect(refusalCopy('disk-full', 0, 12).showArrived).toBe(false);
    });

    it('a heading names what happened, and the fix is a line after the saved line (D-136)', () => {
        // The two titles that used to carry their fix are split: the heading,
        // the saved line, then the fix. No other code gains a line.
        expect(refusalCopy('path-too-long', 4, 12).lines).toEqual([
            '4 of 12 files were saved.',
            'Shorten it or zip it first.',
        ]);
        expect(refusalCopy('path-too-long', 0, 12).lines).toEqual([
            'Nothing was sent.',
            'Shorten it or zip it first.',
        ]);
        expect(refusalCopy('over-approved', 1, 1).lines).toEqual([
            '1 of 1 file was saved.',
            'If files changed after you chose them, ask them for a new link.',
        ]);
        for (const code of ['disk-full', 'write-failed', 'file-too-large-for-folder', 'save-blocked', 'stopped', 'time-limit']) {
            expect(refusalCopy(code, 4, 12).lines, code).toEqual(['4 of 12 files were saved.']);
        }
        // A heading carries no final period; only the sentence titles do
        // (declined, expired, stopped) and the unknown code's.
        for (const code of THIRTEEN) {
            const sentence = ['declined', 'expired', 'stopped'].includes(code);
            expect(refusalCopy(code, 4, 12).title.endsWith('.'), code).toBe(sentence);
        }
    });

    it('a pick refused for long names, one folder deep, is told what to shorten (C-34)', () => {
        // A folder of 100 CJK characters holding a file of 200: one level, each
        // name legal on Windows, and the frame past one control message. The
        // line used to tell this pick to zip deeply nested folders.
        const path = '文'.repeat(100) + '/' + '字'.repeat(200) + '.pdf';
        expect(checkPick([{ relativePath: path, file: { size: 1 } }])).toEqual({
            ok: false,
            cause: 'path-too-long',
        });
        expect(visitorCopy.pathTooLong).toBe(
            'A file name or folder path is too long to send. Shorten it or zip it first.'
        );
    });

    it('too-slow maps to the unknown-code copy', () => {
        expect(refusalCopy('too-slow', 2, 12).title).toBe(UNKNOWN);
        // And so does anything else a peer can put in the field.
        for (const code of [null, '', 'no-such-code', '__proto__', 'constructor', 'toString', 'DISK-FULL']) {
            expect(refusalCopy(code, 2, 12).title).toBe(UNKNOWN);
        }
        expect(refusalCopy(null, 2, 12).lines).toEqual(['2 of 12 files were saved.']);
    });

    it('saved is clamped below 0, above N and non-integer', () => {
        const line = (saved: unknown) => refusalCopy('disk-full', saved as number, 12).lines[0];
        expect(line(-1)).toBe('Nothing was sent.');
        expect(line(13)).toBe('12 of 12 files were saved.');
        expect(line(2.5)).toBe('Nothing was sent.');
        expect(line(Number.NaN)).toBe('Nothing was sent.');
        expect(line(Number.POSITIVE_INFINITY)).toBe('Nothing was sent.');
        expect(line('3')).toBe('Nothing was sent.');
        expect(line(null)).toBe('Nothing was sent.');
        expect(line(12)).toBe('12 of 12 files were saved.');
        expect(line(1)).toBe('1 of 12 files were saved.');
    });

    it('a version range miss maps to the needs-update copy', () => {
        const r = reduce(model('V7', { channelOpen: true, sendStarted: true, firstMetadataAt: 0 }), {
            type: 'INCOMPATIBLE', refusal: 'disk-full', savedCount: 3, rangeOverlaps: false,
        });
        const copy = statusCopy(r.model, CTX);
        expect(copy?.title).toBe('Their Floe needs an update.');
        expect(copy?.lines).toEqual([]);
        expect(announcement(r.model, CTX)).toBe('Their Floe needs an update.');
    });
});

describe('visitor copy: server answers and the attempt states', () => {
    it('host-absent, room-full, disabled and no answer have fixed copy', () => {
        const v4 = statusCopy(model('V4'), CTX);
        expect(v4).toMatchObject({
            title: 'Their computer is not connected right now',
            lines: ['They may have closed Floe. Your files stay selected.'],
            action: 'try-again',
        });
        expect(statusCopy(model('V5a'), CTX)).toMatchObject({
            title: 'This link has already been used',
            lines: ['Ask for a new link.'],
            action: null,
        });
        expect(statusCopy(model('V5d'), CTX)).toMatchObject({
            title: 'This link has ended',
            lines: ['Ask them for a new link.'],
            action: null,
        });
        expect(announcement(model('V5d'), CTX)).toBe('This link has ended');
        // Both say something that can change while the page is open, so
        // both offer Try again (owner answer 18); the words are unchanged.
        expect(statusCopy(model('V5b'), CTX)).toMatchObject({
            title: 'Request links are turned off right now',
            lines: [],
            action: 'try-again',
        });
        expect(statusCopy(model('V5c'), CTX)).toMatchObject({
            title: 'Request links are not available on this Floe server.',
            lines: [],
            action: 'try-again',
        });
        expect(statusCopy(model('V6a'), CTX)).toMatchObject({
            title: "Couldn't connect to their computer. Nothing was sent.",
            action: 'try-again',
        });
        expect(statusCopy(model('V8a'), CTX)).toMatchObject({
            title: 'They declined. Nothing was sent.', action: 'back-to-files',
        });
        expect(statusCopy(model('V8b'), CTX)).toMatchObject({
            title: 'They did not answer in time. Nothing was sent.', action: 'back-to-files',
        });
        // V9 as WV-23 draws it: a two-word title, C-80 as the body (Learn
        // more follows it inline), and a screen reader line that carries the
        // reason with the title.
        expect(statusCopy(model('V9'), CTX)).toMatchObject({
            title: 'Relay limit',
            lines: [
                'This connection needs a relay, and relayed drops are capped at 2 GB. Send 2 GB or less, or try another network.',
            ],
            learnMore: true,
            action: 'back-to-files',
        });
        expect(announcement(model('V9'), CTX)).toBe(
            'Relay limit. This connection needs a relay, and relayed drops are capped at 2 GB.'
        );
        expect(statusCopy(model('V12a'), CTX)).toMatchObject({
            title: 'Connection lost. Nothing was sent.', action: 'try-again',
        });
        // Screen reader lines for the same states are the titles (SR-07).
        expect(announcement(model('V4'), CTX)).toBe('Their computer is not connected right now');
        expect(announcement(model('V5a'), CTX)).toBe('This link has already been used');
    });

    it('a card whose whole message is one sentence takes the one style, and only those (D-136 D5)', () => {
        // WV-14, WV-16, WV-21, WV-22 and WV-44 draw these five in the 15 px
        // medium "one" style; every other title is a heading.
        const ONE = ['V5c', 'V6a', 'V8a', 'V8b', 'V12a'];
        const states = ['V4', 'V5a', 'V5b', 'V5c', 'V6', 'V6a', 'V6c', 'V7', 'V8a', 'V8b', 'V9', 'V11', 'V11a', 'V11b', 'V12', 'V12a', 'V13'] as const;
        for (const s of states) {
            const copy = statusCopy(model(s, { ackIndex: 3, stop: { refusal: 'disk-full', savedCount: 2 } }), CTX);
            expect(copy?.one, s).toBe(ONE.includes(s));
            if (copy?.one) expect(copy.title.endsWith('.'), s).toBe(true);
        }
    });

    it('connecting, waiting and the limiter retry', () => {
        expect(statusCopy(model('V6'), CTX)).toMatchObject({ title: 'Connecting to their computer', action: 'cancel' });
        expect(statusCopy(model('V6c'), CTX)).toMatchObject({
            title: 'Connecting to their computer',
            lines: ['Too many connections from this network. Trying again shortly.'],
            action: 'cancel',
        });
        const waiting = model('V7', { firstMetadataAt: 1000 });
        expect(statusCopy(waiting, { ...CTX, now: 1000 })).toMatchObject({
            title: 'Waiting for them to accept',
            lines: ['They have 9 min to answer. Keep this page open.'],
            action: 'cancel',
        });
        expect(announcement(model('V6'), CTX)).toBe('Connecting to their computer.');
        expect(announcement(waiting, CTX)).toBe('Waiting for them to accept.');
    });

    it('the countdown never says 0 min', () => {
        expect(countdownLine(9)).toBe('They have 9 min to answer. Keep this page open.');
        expect(countdownLine(1)).toBe('They have 1 min to answer. Keep this page open.');
        expect(countdownLine(0)).toBe('They have less than 1 min to answer. Keep this page open.');
    });

    it('lost, stopped by you and delivered', () => {
        const lost = model('V12', { ackIndex: 5, lost: 'closed' });
        expect(statusCopy(lost, CTX)).toMatchObject({
            title: 'Connection lost',
            lines: ['4 of 12 files arrived. Ask them for a new link to send the other 8.'],
            showArrived: true,
        });
        expect(announcement(lost, CTX)).toBe('Connection lost. 4 of 12 files arrived.');

        const stoppedByYou = model('V11a', { ackIndex: 3 });
        expect(statusCopy(stoppedByYou, CTX)).toMatchObject({
            title: 'You stopped this drop.',
            lines: ['2 of 12 files were saved.'],
        });

    });

    it('an unreadable file shows C-130 as a stop, and the screen reader hears the same', () => {
        // WP-W1 review F3: the frozen C-130 row maps an unreadable file to V11
        // after the first ack, with the saved line from the visitor's own
        // count, and SR-05 announces the title that is on screen. Since D-136
        // the title is a heading and the visitor's own path is in the first
        // line, before the saved line.
        const sending = model('V10', { ackIndex: 2, channelOpen: true, sendStarted: true, acceptedAt: 0 });
        const m = reduce(sending, { type: 'UNREADABLE', index: 2 }).model;
        const copy = statusCopy(m, CTX);
        expect(copy?.title).toBe('Could not read a file');
        expect(copy?.lines).toEqual([
            '"shoot/A001_C003.mov" may have been moved or renamed, or its drive disconnected.',
            '1 of 12 files were saved.',
        ]);
        expect(copy?.showArrived).toBe(true);
        expect(announcement(m, CTX)).toBe(copy?.title);
        // The first file itself unreadable, past the host's answer. The read can have failed
        // part of the way through, so the card says nothing about what went (D17).
        const first = reduce(model('V10', { ackIndex: 1, channelOpen: true, sendStarted: true }), {
            type: 'UNREADABLE', index: 1,
        }).model;
        expect(statusCopy(first, CTX)?.lines).toEqual([
            '"shoot/A001_C002.mov" may have been moved or renamed, or its drive disconnected.',
        ]);
        expect(announcement(first, CTX)).toBe(statusCopy(first, CTX)?.title);
        // Before any answer, only an empty file is read, ahead of its metadata, and nothing
        // has gone: the saved line is true there and stays.
        const early = reduce(model('V6', { channelOpen: true, sendStarted: true }), { type: 'UNREADABLE', index: 1 }).model;
        expect(early.ackIndex).toBe(0);
        expect(statusCopy(early, CTX)?.lines).toEqual([
            '"shoot/A001_C002.mov" may have been moved or renamed, or its drive disconnected.',
            'Nothing was sent.',
        ]);
    });

    it('the SHA-256 line appears only when verified equals N', () => {
        const done = (verifiedCount: number | null) =>
            everythingShown(model('V13', { ackIndex: 12, acceptedAt: 0, deliveredAt: 1_024_000, verifiedCount }));
        const LINE = "Their app reports every file's SHA-256 matched.";
        expect(done(12)).toContain(LINE);
        expect(done(11)).not.toContain(LINE);
        expect(done(13)).not.toContain(LINE);
        expect(done(null)).not.toContain(LINE);
        expect(done(0)).not.toContain(LINE);
        expect(done(12.5)).not.toContain(LINE);
        const copy = statusCopy(model('V13', { acceptedAt: 0, deliveredAt: 1_024_000, verifiedCount: 12 }), CTX);
        expect(copy?.title).toBe('ALL 12 FILES ARRIVED');
        expect(copy?.lines).toEqual([`1000 Bytes in 17m 4s, direct. ${LINE}`]);
        expect(announcement(model('V13'), CTX)).toBe('All 12 files arrived.');
    });
});

describe('visitor copy: a drop of one file says file (D-123)', () => {
    // The singular rows of the frozen table as amended by D-123 (C-111, C-120,
    // SR-03, SR-04, SR-06 and the 4.15.2 saved line), each beside its nearest
    // plural neighbor, N = 2, which keeps the plural form.
    const one = (state: VisitorModel['state'], patch: Partial<VisitorModel> = {}) => model(state, { total: 1, ...patch });
    const two = (state: VisitorModel['state'], patch: Partial<VisitorModel> = {}) => model(state, { total: 2, ...patch });
    const DELIVERED = { acceptedAt: 0, deliveredAt: 1000 };

    it('C-120 and SR-04: the delivered title and its announcement', () => {
        expect(statusCopy(one('V13', DELIVERED), CTX)?.title).toBe('1 FILE ARRIVED');
        expect(announcement(one('V13', DELIVERED), CTX)).toBe('1 file arrived.');
        expect(statusCopy(two('V13', DELIVERED), CTX)?.title).toBe('ALL 2 FILES ARRIVED');
        expect(announcement(two('V13', DELIVERED), CTX)).toBe('All 2 files arrived.');
    });

    it('SR-03: the accepted announcement', () => {
        expect(announcement(one('V10', { ackIndex: 1 }), CTX)).toBe('They accepted. Sending 1 file.');
        expect(announcement(two('V10', { ackIndex: 1 }), CTX)).toBe('They accepted. Sending 2 files.');
    });

    it('C-111 and SR-06: connection lost, its line and its announcement', () => {
        const lost = one('V12', { ackIndex: 1, lost: 'closed' });
        expect(statusCopy(lost, CTX)).toMatchObject({
            title: 'Connection lost',
            lines: ['0 of 1 file arrived. Ask them for a new link to send it.'],
            showArrived: false,
        });
        expect(announcement(lost, CTX)).toBe('Connection lost. 0 of 1 file arrived.');
        const lostTwo = two('V12', { ackIndex: 1, lost: 'closed' });
        expect(statusCopy(lostTwo, CTX)?.lines).toEqual([
            '0 of 2 files arrived. Ask them for a new link to send the other 2.',
        ]);
        expect(announcement(lostTwo, CTX)).toBe('Connection lost. 0 of 2 files arrived.');
        // Exactly one left of more than one: "the other one", never
        // "the other 1" (owner answer 22).
        const lastLeft = model('V12', { total: 12, ackIndex: 12, lost: 'closed' });
        expect(statusCopy(lastLeft, CTX)?.lines).toEqual([
            '11 of 12 files arrived. Ask them for a new link to send the other one.',
        ]);
        // The one file acked but the delivery never confirmed: nothing is left
        // to send, so C-111's flow R6 tail, with the singular noun.
        const acked = one('V12', { ackIndex: 2, lost: 'closed' });
        expect(statusCopy(acked, CTX)?.lines).toEqual([
            '1 of 1 file arrived. Ask them for a new link to send the rest.',
        ]);
        expect(announcement(acked, CTX)).toBe('Connection lost. 1 of 1 file arrived.');
    });

    it('the 4.15.2 saved line: 1 of 1 file was saved.', () => {
        expect(refusalCopy('disk-full', 1, 1).lines).toEqual(['1 of 1 file was saved.']);
        expect(refusalCopy('hash-mismatch', 1, 1).lines).toEqual([
            '1 of 1 file was saved.',
            'Ask them for a new link to send the rest.',
        ]);
        expect(refusalCopy('relay-cap', 1, 1).lines).toEqual(['1 of 1 file was saved.']);
        // Clamped to N, and at 0 the line is the same for every N.
        expect(refusalCopy('disk-full', 7, 1).lines).toEqual(['1 of 1 file was saved.']);
        expect(refusalCopy('disk-full', 0, 1).lines).toEqual(['Nothing was sent.']);
        expect(refusalCopy('disk-full', 1, 2).lines).toEqual(['1 of 2 files were saved.']);
        // The same line after the visitor's own Cancel (C-100).
        expect(statusCopy(one('V11a', { ackIndex: 2 }), CTX)?.lines).toEqual(['1 of 1 file was saved.']);
        expect(statusCopy(two('V11a', { ackIndex: 2 }), CTX)?.lines).toEqual(['1 of 2 files were saved.']);
    });

    it('no one-file string contains an em or en dash', () => {
        const dash = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
        for (const s of ['V10', 'V11', 'V11a', 'V12', 'V13'] as const) {
            for (const ackIndex of [1, 2]) {
                const m = one(s, { ackIndex, ...DELIVERED, stop: { refusal: 'disk-full', savedCount: ackIndex - 1 } });
                expect(everythingShown(m)).not.toMatch(dash);
            }
        }
    });
});

describe('visitor copy: hostile peers', () => {
    const HOSTILE = ['<img src=x onerror=alert(1)>', '$(calc)', String.fromCharCode(0x202e), 'x'.repeat(10_000)];

    it('hostile reason never reaches any copy output', () => {
        for (const h of HOSTILE) {
            // The hostile text rides every event, on the fields a hostile host
            // controls (the code) and on fields no event declares (the reason
            // a frame carries), through every path to a terminal state.
            const withHostile = (e: VisitorEvent) =>
                ({ ...e, reason: h, ver: h, name: h, message: h, refusal: 'refusal' in e ? h : undefined }) as unknown as VisitorEvent;
            const paths: VisitorEvent[][] = [
                [
                    { type: 'SEND', count: 12, size: 1000, hideIp: false },
                    { type: 'ICE_READY', hasTurn: true },
                    { type: 'SOCKET_CONNECTED' },
                    { type: 'JOIN_ANSWER', answer: 'request-joined' },
                    { type: 'CHANNEL_OPEN' },
                    { type: 'RELAY_VERDICT', action: 'proceed', isRelay: false },
                    { type: 'FIRST_METADATA_SENT', now: 0 },
                    { type: 'ACK', index: 1, now: 1 },
                    { type: 'VERIFIED_COUNT', verifiedCount: 12 },
                    { type: 'ACK', index: 2, now: 2 },
                    { type: 'INCOMPATIBLE', refusal: null, savedCount: 1, rangeOverlaps: true },
                ],
                [
                    { type: 'SEND', count: 12, size: 1000, hideIp: false },
                    { type: 'ICE_READY', hasTurn: true },
                    { type: 'SOCKET_CONNECTED' },
                    { type: 'JOIN_ANSWER', answer: 'request-joined' },
                    { type: 'CHANNEL_OPEN' },
                    { type: 'RELAY_VERDICT', action: 'proceed', isRelay: false },
                    { type: 'FIRST_METADATA_SENT', now: 0 },
                    { type: 'INCOMPATIBLE', refusal: null, savedCount: 0, rangeOverlaps: true },
                ],
                [
                    { type: 'SEND', count: 12, size: 1000, hideIp: false },
                    { type: 'ICE_READY', hasTurn: true },
                    { type: 'SOCKET_CONNECTED' },
                    { type: 'JOIN_ANSWER', answer: 'request-joined' },
                    { type: 'CHANNEL_OPEN' },
                    { type: 'RELAY_VERDICT', action: 'proceed', isRelay: false },
                    { type: 'FIRST_METADATA_SENT', now: 0 },
                    { type: 'INCOMPATIBLE', refusal: null, savedCount: 0, rangeOverlaps: false },
                ],
                [
                    { type: 'SEND', count: 12, size: 1000, hideIp: false },
                    { type: 'ICE_READY', hasTurn: true },
                    { type: 'SOCKET_CONNECTED' },
                    { type: 'JOIN_ANSWER', answer: 'request-joined' },
                    { type: 'CHANNEL_OPEN' },
                    { type: 'RELAY_VERDICT', action: 'proceed', isRelay: true },
                    { type: 'FIRST_METADATA_SENT', now: 0 },
                    { type: 'ACK', index: 1, now: 1 },
                    { type: 'VERIFIED_COUNT', verifiedCount: 12 },
                    { type: 'RECEIVED', now: 60_000 },
                ],
            ];
            let seenStates = 0;
            for (const path of paths) {
                let m = reduce(initialModel, { type: 'LINK_OK', roomId: ROOM, keyed: false }).model;
                for (const e of path) {
                    m = reduce(m, withHostile(e)).model;
                    const shown = everythingShown(m);
                    expect(shown.includes(h), `${m.state} after ${e.type}`).toBe(false);
                    seenStates += 1;
                }
            }
            // The walk really reached the stopped, needs-update and delivered
            // cards, so the assertion is not vacuous.
            expect(seenStates).toBeGreaterThan(30);
            // And the direct call with the hostile text as the code.
            expect(JSON.stringify(refusalCopy(h, 3, 12)).includes(h)).toBe(false);
            expect(refusalCopy(h, 3, 12).title).toBe(UNKNOWN);
        }
    });

    it('an early received never shows the delivered card', () => {
        let m = model('V10', { ackIndex: 1, channelOpen: true, sendStarted: true });
        m = reduce(m, { type: 'VERIFIED_COUNT', verifiedCount: 12 }).model;
        expect(statusCopy(m, CTX)).toBeNull();
        expect(everythingShown(m)).not.toContain('ARRIVED');
    });
});

describe('visitor copy: Ready and Sending strings', () => {
    it('count, send and relay notice', () => {
        expect(countLine(12, 1024 * 1024 * 1024 * 38)).toBe('12 FILES, 38 GB');
        expect(countLine(1, 620 * 1024 * 1024)).toBe('1 FILE, 620 MB');
        expect(sendLabel(12)).toBe('Send 12 files');
        expect(sendLabel(1)).toBe('Send 1 file');
        // C-31 names the cap and both ways out; the count line above it
        // already carries the size (D-136). The size, not "remove files" or a
        // count: the page has Clear and Add more files and no way to take one
        // file out, and the gate reads bytes, so one file can be over it.
        expect(visitorCopy.relayCapReady).toBe('Relayed drops are capped at 2 GB. Turn off Hide my IP, or send 2 GB or less.');
    });

    it('sending header, progress line and the visitor\'s own path', () => {
        expect(sendingHeader(4, 12)).toBe('SENDING 4 OF 12');
        expect(progressParts(1.2 * 1024 ** 3, 2.5 * 1024 ** 3, 38 * 1024 * 1024, 34).join('   ')).toBe(
            '1.2 GB of 2.5 GB   38.0 MB/s   34s left'
        );
        // No speed yet: the line holds only what is known.
        expect(progressParts(0, 1024, 0, Number.NaN)).toEqual(['0 Bytes of 1 KB']);
        expect(displayPath('shoot/A004_C001.mov', 40)).toBe('shoot/A004_C001.mov');
        const long = 'a'.repeat(30) + '/' + 'b'.repeat(30) + '.mov';
        const shown = displayPath(long, 24);
        expect(shown.length).toBeLessThanOrEqual(24);
        expect(shown.startsWith('aaaa')).toBe(true);
        expect(shown.endsWith('b.mov')).toBe(true);
        expect(shown).toContain('...');
    });

    it('the approved strings are pinned verbatim', () => {
        expect(visitorCopy).toMatchObject({
            whatIsRequestLink: 'What is a request link?',
            dropHere: 'Drop files or folders here',
            chooseFiles: 'Choose files',
            chooseFolder: 'Choose folder',
            hideIp: 'Hide my IP (relay only, 2 GB per drop)',
            clear: 'Clear',
            ipNotice:
                'When you connect, the person who made this link can see your IP address unless you turn on Hide my IP.',
            releaseToAdd: 'Release to add files',
            addMoreFiles: 'Add more files',
            coarsePointer: 'Keep this page open and your screen on.',
            hideIpNeedsRelay: 'This Floe server has no relay right now. Turn off Hide my IP to send directly.',
            relayUnchecked: "Couldn't check for a relay. Try again, or turn off Hide my IP to send directly.",
            tryAgain: 'Try again',
            cancel: 'Cancel',
            backToFiles: 'Back to files',
            learnMore: 'Learn more',
            arrivedHeading: 'ARRIVED',
            keepInFront: 'Keep this tab in front until the last file arrives.',
            badgeDirect: 'Direct',
            badgeRelay: 'Relay',
            stopTitle: 'Stop sending?',
            stopBody: 'Files that already arrived stay on their computer. This link cannot be used again.',
            keepSending: 'Keep sending',
            stop: 'Stop',
            reportLink: 'Report this link',
            pluggedIn: 'Keep this computer plugged in and awake, and pin this tab.',
            startsOver: 'If the connection drops, the file that was moving starts over.',
            mayHaveSlept:
                'This computer may have slept. If the connection drops, the file that was moving starts over.',
        });
    });

    // The one sentence of the in-app browser notice that /r words for itself
    // (app/r/[linkId]/page.tsx hands it to InAppBrowserGuard). The notice's
    // own sentence names Chrome or Safari, which is right on the home page and
    // wrong here: no request link page lists Safari. This row says what the
    // support line under the heading says (C-13), computer included. Approved
    // by the owner on 2026-10-12.
    it('the in-app browser advice names current Chrome or Edge on a computer', () => {
        expect(visitorCopy.inAppAdvice).toBe('Open the link in current Chrome or Edge on a computer.');
        expect(visitorCopy.inAppAdvice).toContain('current Chrome');
        expect(visitorCopy.betaSupport).toBe('Works in current Chrome and Edge on a computer.');
    });

    // The title of the box of steps under that sentence, on /r only. The
    // sentence recommends a computer and the steps open the phone's own
    // browser, so under "How to open in your browser" the steps read as the
    // way to do what the sentence had just asked, and they are not. The title
    // names them as the other choice. Approved by the owner on 2026-10-14.
    it('the steps under the in-app browser advice are titled as the phone option', () => {
        expect(visitorCopy.inAppStepsTitle).toBe('To use this phone instead');
        expect(visitorCopy.inAppAdvice).toContain('on a computer');
    });

    it('the intro, the support line and the safety lines read as D-136 approved them', () => {
        // Each of these is a disclosure or a safety line (C-02 keeps "Floe
        // does not know who", C-11 the IP notice with its timing, C-12 the
        // abuse control, C-03 the way to the docs), so each is pinned whole.
        expect(visitorCopy).toMatchObject({
            readyIntro:
                'Files go to the computer of whoever made this link, not to a Floe server. Floe does not know who that is.',
            betaSupport: 'Works in current Chrome and Edge on a computer.',
            ipNotice:
                'When you connect, the person who made this link can see your IP address unless you turn on Hide my IP.',
            reportLink: 'Report this link',
            whatIsRequestLink: 'What is a request link?',
            hostAbsentBody: 'They may have closed Floe. Your files stay selected.',
            usedBody: 'Ask for a new link.',
            needsUpdate: 'Their Floe needs an update.',
        });
    });

    it('no copy string contains an em or en dash', () => {
        const all: string[] = [];
        const walk = (v: unknown) => {
            if (typeof v === 'string') all.push(v);
            else if (v && typeof v === 'object') Object.values(v).forEach(walk);
        };
        walk(visitorCopy);
        for (const code of [...THIRTEEN, null]) walk(refusalCopy(code, 3, 12));
        for (const s of ['V4', 'V5a', 'V5b', 'V5c', 'V6', 'V6a', 'V6c', 'V6f', 'V6g', 'V7', 'V8a', 'V8b', 'V9', 'V11a', 'V11b', 'V12', 'V12a', 'V13'] as const) {
            walk(statusCopy(model(s, { ackIndex: 3, stop: { refusal: 'disk-full', savedCount: 2 }, verifiedCount: 12 }), CTX));
            walk(announcement(model(s), CTX));
        }
        walk([countLine(2, 10), sendLabel(2), countdownLine(0), sendingHeader(1, 2)]);
        // V11 with an unreadable file of the visitor's own (C-130).
        walk(statusCopy(model('V11', { ackIndex: 3, unreadableIndex: 2 }), CTX));
        expect(all.length).toBeGreaterThan(60);
        for (const s of all) {
            expect(s, s).not.toMatch(new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']'));
        }
    });

    it('no copy string says Beta: request links left Beta at desktop-v1.0.0', () => {
        const all: string[] = [];
        const walk = (v: unknown) => {
            if (typeof v === 'string') all.push(v);
            else if (v && typeof v === 'object') Object.values(v).forEach(walk);
        };
        walk(visitorCopy);
        expect(all.length).toBeGreaterThan(60);
        expect(all.filter((s) => /\bbeta\b/i.test(s))).toEqual([]);
    });
});

describe('visitor copy: the link key (PLAN.md New copy, C-56, C-57, code unverified)', () => {
    const ASK = 'Ask the person who made this link for a new one.';

    it('the frozen rows, byte for byte', () => {
        expect(visitorCopy.keyFailedTitle).toBe("Couldn't confirm their computer");
        expect(visitorCopy.keyFailedBody).toBe('Nothing was sent. Ask the person who made this link for a new one.');
        expect(visitorCopy.askForNewLink).toBe(ASK);
        expect(refusalCopy('unverified', 0, 3).title).toBe("Their computer couldn't confirm this link");
        // C-57 is the two sentences this table already holds, and stays that.
        expect(visitorCopy.keyFailedBody).toBe(`${visitorCopy.nothingSent} ${visitorCopy.askForNewLink}`);
    });

    it('V6f: the card has the title and the line, and nothing to press', () => {
        const copy = statusCopy(model('V6f'), CTX);
        expect(copy).toMatchObject({
            marker: 'ended',
            title: "Couldn't confirm their computer",
            lines: ['Nothing was sent. Ask the person who made this link for a new one.'],
            action: null,
            showArrived: false,
            learnMore: false,
            badge: false,
            one: false,
        });
    });

    it('V6f is announced by its title', () => {
        expect(announcement(model('V6f'), CTX)).toBe("Couldn't confirm their computer");
    });

    it('unverified before accept: the title, the saved line at 0, then the ask', () => {
        expect(refusalCopy('unverified', 0, 3)).toEqual({
            title: "Their computer couldn't confirm this link",
            lines: ['Nothing was sent.', ASK],
            showArrived: false,
        });
    });

    it('unverified with files saved: their count, then the ask, and the list', () => {
        expect(refusalCopy('unverified', 2, 3)).toEqual({
            title: "Their computer couldn't confirm this link",
            lines: ['2 of 3 files were saved.', ASK],
            showArrived: true,
        });
        expect(refusalCopy('unverified', 1, 1).lines).toEqual(['1 of 1 file was saved.', ASK]);
    });

    // The first byte goes right behind the first ack, so from there "Nothing was sent" is
    // false whatever count the frame carries. The refusal is the host's word and the count
    // is its claim: a host that holds the bytes could otherwise make the page say none went.
    it('unverified past the first ack never says nothing was sent', () => {
        expect(refusalCopy('unverified', 0, 3, true)).toEqual({
            title: "Their computer couldn't confirm this link",
            lines: [ASK],
            showArrived: false,
        });
        expect(refusalCopy('unverified', 2, 3, true).lines).toEqual(['2 of 3 files were saved.', ASK]);
    });

    it('the card knows that from the page\'s own count, and from nothing the host sent', () => {
        const stop = { refusal: 'unverified' as const, savedCount: 0 };
        const before = statusCopy(model('V11', { stop, ackIndex: 0, total: 3 }), CTX);
        expect(before?.lines).toEqual(['Nothing was sent.', ASK]);
        const after = statusCopy(model('V11', { stop, ackIndex: 1, total: 3 }), CTX);
        expect(after?.title).toBe("Their computer couldn't confirm this link");
        expect(after?.lines).toEqual([ASK]);
        expect(JSON.stringify(after)).not.toMatch(/nothing was sent/i);
        expect(announcement(model('V11', { stop, ackIndex: 1, total: 3 }), CTX)).toBe(after?.title);
    });

    // The row is a code, the words are ours, and no reason a peer sent has a way in.
    it('every path from the reducer to a refusal of this code reads as above', () => {
        const refused = (from: VisitorModel['state'], patch: Partial<VisitorModel>, event: VisitorEvent) =>
            reduce(model(from, patch), event).model;
        const frame: VisitorEvent = { type: 'INCOMPATIBLE', refusal: 'unverified', savedCount: 0, rangeOverlaps: true };
        const keyed = { keyed: true, keyVerified: true, channelOpen: true, sendStarted: true, total: 3 };

        // Nothing named, nothing sent: the proof was all that went.
        const early = refused('V6', { keyed: true, channelOpen: true, total: 3 }, { type: 'KEY_CHECK_REFUSED' });
        expect(statusCopy(early, CTX)?.lines).toEqual(['Nothing was sent.', ASK]);
        // The metadata went, and no file byte: a byte goes only after an ack.
        const waiting = refused('V7', { ...keyed, firstMetadataAt: 1 }, frame);
        expect(statusCopy(waiting, CTX)?.lines).toEqual(['Nothing was sent.', ASK]);
        // Past the ack.
        const sending = refused('V10', { ...keyed, firstMetadataAt: 1, ackIndex: 1, acceptedAt: 2 }, frame);
        expect(statusCopy(sending, CTX)?.lines).toEqual([ASK]);
        const second = refused('V10', { ...keyed, firstMetadataAt: 1, ackIndex: 2, acceptedAt: 2 }, frame);
        expect(statusCopy(second, CTX)?.lines).toEqual([ASK]);
    });

    it('V6f says nothing was sent only where the reducer has started nothing', () => {
        // A send that started has a proof, and a proof has no way back to V6f.
        const started = model('V6', { keyed: true, keyVerified: true, channelOpen: true, sendStarted: true });
        expect(reduce(started, { type: 'KEY_CHECK_FAILED' }).model.state).toBe('V6');
        const v7 = model('V7', { keyed: true, keyVerified: true, sendStarted: true });
        expect(reduce(v7, { type: 'KEY_CHECK_FAILED' }).model.state).toBe('V7');
        const v10 = model('V10', { keyed: true, keyVerified: true, sendStarted: true, ackIndex: 1 });
        expect(reduce(v10, { type: 'KEY_CHECK_FAILED' }).model.state).toBe('V10');
    });

    it('a keyless visitor whose host refuses reads the V1 card, and hears it, with no new string', () => {
        const v1 = reduce(model('V7', { sendStarted: true, firstMetadataAt: 1 }), {
            type: 'INCOMPATIBLE',
            refusal: 'unverified',
            savedCount: 0,
            rangeOverlaps: true,
        }).model;
        expect(v1.state).toBe('V1');
        // V1 keeps its own card (NoticeCard), so no status card.
        expect(statusCopy(v1, CTX)).toBeNull();
        expect(visitorCopy.incompleteTitle).toBe('This link looks incomplete');
        expect(visitorCopy.incompleteBody).toBe('Copy the whole link again, including everything after the # sign.');
        // It came after an attempt the page announced, so it is announced too.
        expect(announcement(v1, CTX)).toBe('This link looks incomplete');
    });

    it('V1 at load stays as quiet as it was: the first paint, with no attempt behind it', () => {
        const atLoad = reduce(initialModel, { type: 'LINK_INCOMPLETE' }).model;
        expect(atLoad.state).toBe('V1');
        expect(announcement(atLoad, CTX)).toBe('');
    });

    it('the ask stays on its own row', () => {
        for (const code of THIRTEEN.filter((c) => c !== 'unverified')) {
            for (const saved of [0, 2]) {
                expect(refusalCopy(code, saved, 12).lines.join(' '), code).not.toContain(ASK);
                expect(refusalCopy(code, saved, 12, true).lines.join(' '), code).not.toContain(ASK);
            }
        }
    });

    // C-58 and C-59 (D17). A browser that cannot read the connection's certificates has no
    // way to check the host, and a new link will not change that, so this card says what
    // will: it never claims the other side failed (D7).
    it('V6g: the frozen rows, byte for byte', () => {
        expect(visitorCopy.cantCheckTitle).toBe("This browser can't check this link");
        expect(visitorCopy.cantCheckBody).toBe('Nothing was sent. Open this link in a current version of Chrome, Edge, Firefox or Safari.');
    });

    it('V6g: the card has the title and the line, and nothing to press', () => {
        expect(statusCopy(model('V6g'), CTX)).toMatchObject({
            marker: 'ended',
            title: "This browser can't check this link",
            lines: ['Nothing was sent. Open this link in a current version of Chrome, Edge, Firefox or Safari.'],
            action: null,
            showArrived: false,
            learnMore: false,
            badge: false,
            one: false,
        });
    });

    it('V6g is announced by its title', () => {
        expect(announcement(model('V6g'), CTX)).toBe("This browser can't check this link");
    });

    it('V6g says nothing about the host, and does not send the visitor to it for a new link', () => {
        const words = JSON.stringify(statusCopy(model('V6g'), CTX));
        expect(words).not.toContain(visitorCopy.keyFailedTitle);
        expect(words).not.toContain(ASK);
        expect(words).not.toMatch(/their computer/i);
    });

    it('V6g says nothing was sent only where the reducer has started nothing', () => {
        const started = model('V6', { keyed: true, channelOpen: true, sendStarted: true });
        expect(reduce(started, { type: 'KEY_CHECK_UNAVAILABLE' }).model.state).toBe('V6');
        const v7 = model('V7', { keyed: true, sendStarted: true });
        expect(reduce(v7, { type: 'KEY_CHECK_UNAVAILABLE' }).model.state).toBe('V7');
        const v10 = model('V10', { keyed: true, sendStarted: true, ackIndex: 1 });
        expect(reduce(v10, { type: 'KEY_CHECK_UNAVAILABLE' }).model.state).toBe('V10');
    });
});

// D17. The first byte goes right behind the host's first answer, so from there "Nothing was
// sent." would be false whatever count the frame carries, on a host that is honest too:
// "Their computer ran out of space" during file 1 is the usual way here. The card keeps its
// title and drops the line, with no new words.
describe('visitor copy: past the host\'s first answer, with nothing saved', () => {
    const FALSE = /nothing was sent/i;
    const ROWS = THIRTEEN.filter((c) => c !== 'declined' && c !== 'expired');

    it('every refusal row keeps its title and loses the line', () => {
        for (const code of ROWS) {
            const after = refusalCopy(code, 0, 12, true);
            const before = refusalCopy(code, 0, 12);
            expect(after.title, code).toBe(before.title);
            expect(after.lines.join(' '), code).not.toMatch(FALSE);
            expect(after.showArrived, code).toBe(false);
        }
    });

    it('what follows the saved line stays where it is', () => {
        expect(refusalCopy('disk-full', 0, 12, true).lines).toEqual([]);
        expect(refusalCopy('relay-cap', 0, 12, true).lines).toEqual([]);
        expect(refusalCopy('stopped', 0, 12, true).lines).toEqual([]);
        expect(refusalCopy('hash-mismatch', 0, 12, true).lines).toEqual(['Ask them for a new link to send the rest.']);
        expect(refusalCopy('path-too-long', 0, 12, true).lines).toEqual(['Shorten it or zip it first.']);
        expect(refusalCopy('over-approved', 0, 12, true).lines).toEqual(['If files changed after you chose them, ask them for a new link.']);
        expect(refusalCopy('unverified', 0, 12, true).lines).toEqual(['Ask the person who made this link for a new one.']);
    });

    it('a count of files saved reads as it always did', () => {
        for (const code of ROWS) {
            expect(refusalCopy(code, 2, 12, true), code).toEqual(refusalCopy(code, 2, 12));
        }
    });

    it('before the first answer no row moved', () => {
        expect(refusalCopy('disk-full', 0, 12).lines).toEqual(['Nothing was sent.']);
        expect(refusalCopy('stopped', 0, 12).lines).toEqual(['Nothing was sent.']);
        expect(refusalCopy('relay-cap', 0, 12).lines).toEqual(['Nothing was sent. Send 2 GB or less.']);
        expect(refusalCopy('hash-mismatch', 0, 12).lines).toEqual(['Nothing was sent.', 'Ask them for a new link to send the rest.']);
        expect(refusalCopy(null, 0, 12).lines).toEqual(['Nothing was sent.']);
    });

    // Only a hostile host gets here: declining and running out the clock both come before
    // the first answer. Each of those titles holds the claim, so the row is the unknown one.
    it('declined and expired past an answer read as the unknown row, whatever the count', () => {
        for (const code of ['declined', 'expired']) {
            expect(refusalCopy(code, 0, 12, true), code).toEqual({
                title: 'The drop stopped on their computer.',
                lines: [],
                showArrived: false,
            });
            expect(refusalCopy(code, 2, 12, true), code).toEqual({
                title: 'The drop stopped on their computer.',
                lines: ['2 of 12 files were saved.'],
                showArrived: true,
            });
        }
    });

    it('before an answer declined and expired keep their sentences, and nothing under them', () => {
        expect(refusalCopy('declined', 0, 12)).toEqual({ title: 'They declined. Nothing was sent.', lines: [], showArrived: false });
        expect(refusalCopy('expired', 0, 12)).toEqual({ title: 'They did not answer in time. Nothing was sent.', lines: [], showArrived: false });
    });

    it('a code the page does not know, past an answer: the unknown row and no line', () => {
        for (const code of [null, 'too-slow', 'FLOEPEERTEXT']) {
            expect(refusalCopy(code, 0, 12, true), String(code)).toEqual({
                title: 'The drop stopped on their computer.',
                lines: [],
                showArrived: false,
            });
        }
    });

    it('the card reads that from the page\'s own count, on every row', () => {
        for (const code of THIRTEEN) {
            const stop = { refusal: code, savedCount: 0 };
            const card = statusCopy(model('V11', { stop, ackIndex: 1, total: 12 }), CTX);
            expect(JSON.stringify(card), code).not.toMatch(FALSE);
            expect(announcement(model('V11', { stop, ackIndex: 1, total: 12 }), CTX), code).not.toMatch(FALSE);
        }
    });

    it('You stopped this drop: the title alone with no file in, and the count with one', () => {
        const during = statusCopy(model('V11a', { ackIndex: 1, total: 12 }), CTX);
        expect(during).toMatchObject({ title: 'You stopped this drop.', lines: [], showArrived: false });
        expect(statusCopy(model('V11a', { ackIndex: 2, total: 12 }), CTX)?.lines).toEqual(['1 of 12 files were saved.']);
    });

    it('from the reducer: an honest host that runs out of space during file 1', () => {
        const v10 = model('V10', { keyed: true, keyVerified: true, channelOpen: true, sendStarted: true, firstMetadataAt: 1, ackIndex: 1, acceptedAt: 2, total: 1 });
        const stopped = reduce(v10, { type: 'INCOMPATIBLE', refusal: 'disk-full', savedCount: 0, rangeOverlaps: true }).model;
        expect(statusCopy(stopped, CTX)).toMatchObject({ title: 'Their computer ran out of space', lines: [], showArrived: false });
    });
});

describe('visitor copy: the Arrived line names a route only when one was read (owner answer 27)', () => {
    const LINE = "Their app reports every file's SHA-256 matched.";
    const delivered = (patch: Partial<VisitorModel>) =>
        model('V13', { acceptedAt: 0, deliveredAt: 190_000, verifiedCount: 12, ...patch });

    it('keeps the route the badge or the probe read', () => {
        expect(statusCopy(delivered({ route: null }), { ...CTX, route: 'relay' })?.lines).toEqual([
            `1000 Bytes in 3m 10s, relay. ${LINE}`,
        ]);
        expect(statusCopy(delivered({ route: 'direct' }), { ...CTX, route: null })?.lines).toEqual([
            `1000 Bytes in 3m 10s, direct. ${LINE}`,
        ]);
    });

    it('says size and time alone when neither read one', () => {
        expect(statusCopy(delivered({ route: null }), { ...CTX, route: null })?.lines).toEqual([
            `1000 Bytes in 3m 10s. ${LINE}`,
        ]);
        expect(statusCopy(delivered({ route: null, verifiedCount: null }), { ...CTX, route: null })?.lines).toEqual([
            '1000 Bytes in 3m 10s.',
        ]);
    });
});
