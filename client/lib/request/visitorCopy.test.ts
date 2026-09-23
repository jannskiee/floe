import { describe, it, expect } from 'vitest';
import {
    visitorCopy,
    countLine,
    sendLabel,
    relayCapNotice,
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

// The visitor page never renders a peer-supplied string. Everything it shows
// comes from the frozen Checkpoint C table (work/16-design/cp-3/
// approved-copy-web.md, D-091, with the stop confirmation from D-096), chosen
// by an allowlisted code or a state, with only clamped counts and the
// visitor's OWN relative paths filled in.

const ROOM = '6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f';
const CTX: StatusContext = {
    pathAt: (i) => ['shoot/A001_C002.mov', 'shoot/A001_C003.mov', 'shoot/A002_C001.mov'][i - 1],
    route: 'direct',
    now: 0,
};

const TWELVE = [
    'declined', 'disk-full', 'expired', 'file-too-large-for-folder', 'hash-mismatch', 'over-approved',
    'path-too-long', 'relay-cap', 'save-blocked', 'stopped', 'time-limit', 'write-failed',
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
        const titles: Record<(typeof TWELVE)[number], string> = {
            declined: 'They declined. Nothing was sent.',
            expired: 'They did not answer in time. Nothing was sent.',
            'disk-full': 'Their computer ran out of space',
            'write-failed': 'Their computer could not save a file',
            'hash-mismatch': 'A file changed or was damaged on the way, so their Floe deleted it',
            'relay-cap': 'Relayed drops are capped at 2 GB',
            'path-too-long': 'A folder path is too long for their computer. Zip deeply nested folders first.',
            'file-too-large-for-folder': 'A file is too large for the drive they save to.',
            'save-blocked': 'A file arrived but their computer blocked saving it.',
            'over-approved':
                'More data arrived than they accepted. If files changed after you chose them, ask them for a new link.',
            stopped: 'They stopped this drop.',
            'time-limit': 'This drop reached the 24-hour limit, so their Floe stopped it.',
        };
        for (const code of TWELVE) {
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
        expect(refusalCopy('relay-cap', 0, 12).lines).toEqual(['Nothing was sent. Send under 2 GB.']);
        expect(refusalCopy('relay-cap', 3, 12).lines).toEqual(['3 of 12 files were saved.']);
        expect(refusalCopy('disk-full', 4, 12).showArrived).toBe(true);
        expect(refusalCopy('disk-full', 0, 12).showArrived).toBe(false);
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
        expect(copy?.title).toBe('Their Floe needs an update to receive from this page.');
        expect(copy?.lines).toEqual([]);
        expect(announcement(r.model, CTX)).toBe('Their Floe needs an update to receive from this page.');
    });
});

describe('visitor copy: server answers and the attempt states', () => {
    it('host-absent, room-full, disabled and no answer have fixed copy', () => {
        const v4 = statusCopy(model('V4'), CTX);
        expect(v4).toMatchObject({
            title: 'Their computer is not connected right now',
            lines: ['The person who made this link may have closed Floe. Your files stay selected.'],
            action: 'try-again',
        });
        expect(statusCopy(model('V5a'), CTX)).toMatchObject({
            title: 'This link has already been used',
            lines: ['Ask the person who made it for a new one.'],
            action: null,
        });
        expect(statusCopy(model('V5b'), CTX)).toMatchObject({ title: 'Request links are turned off right now', lines: [] });
        expect(statusCopy(model('V5c'), CTX)).toMatchObject({
            title: 'Request links are not available on this Floe server.',
            lines: [],
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
        expect(statusCopy(model('V9'), CTX)).toMatchObject({
            title:
                'Transfer limit exceeded. Relay connections are capped at 2 GB. Remove files to proceed, or switch to a network that supports a direct connection.',
            learnMore: true,
            action: 'back-to-files',
        });
        expect(statusCopy(model('V12a'), CTX)).toMatchObject({
            title: 'Connection lost. Nothing was sent.', action: 'try-again',
        });
        // Screen reader lines for the same states are the titles (SR-07).
        expect(announcement(model('V4'), CTX)).toBe('Their computer is not connected right now');
        expect(announcement(model('V5a'), CTX)).toBe('This link has already been used');
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
            lines: ['They have 9 min to answer. Nothing is saved until they accept. Keep this page open.'],
            action: 'cancel',
        });
        expect(announcement(model('V6'), CTX)).toBe('Connecting to their computer.');
        expect(announcement(waiting, CTX)).toBe('Waiting for them to accept.');
    });

    it('the countdown never says 0 min', () => {
        expect(countdownLine(9)).toBe(
            'They have 9 min to answer. Nothing is saved until they accept. Keep this page open.'
        );
        expect(countdownLine(1)).toBe(
            'They have 1 min to answer. Nothing is saved until they accept. Keep this page open.'
        );
        expect(countdownLine(0)).toBe(
            'They have less than 1 min to answer. Nothing is saved until they accept. Keep this page open.'
        );
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
        // count, and SR-05 announces the title that is on screen.
        const sending = model('V10', { ackIndex: 2, channelOpen: true, sendStarted: true, acceptedAt: 0 });
        const m = reduce(sending, { type: 'UNREADABLE', index: 2 }).model;
        const copy = statusCopy(m, CTX);
        expect(copy?.title).toBe(
            'Could not read "shoot/A001_C003.mov". It may have been moved, renamed, or on a drive or folder that is no longer available. Nothing further was sent.'
        );
        expect(copy?.lines).toEqual(['1 of 12 files were saved.']);
        expect(copy?.showArrived).toBe(true);
        expect(announcement(m, CTX)).toBe(copy?.title);
        // The first file itself unreadable: nothing was saved.
        const first = reduce(model('V10', { ackIndex: 1, channelOpen: true, sendStarted: true }), {
            type: 'UNREADABLE', index: 1,
        }).model;
        expect(statusCopy(first, CTX)?.lines).toEqual(['Nothing was sent.']);
        expect(announcement(first, CTX)).toBe(statusCopy(first, CTX)?.title);
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
                let m = reduce(initialModel, { type: 'LINK_OK', roomId: ROOM }).model;
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
        expect(relayCapNotice(38 * 1024 ** 3)).toBe(
            'This drop is 38 GB, so it cannot go through the relay. Turn off Hide my IP, or send under 2 GB.'
        );
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
            hideIpNeedsRelay:
                'Hide my IP needs a relay, and this Floe server has none right now. Turn off Hide my IP to send directly.',
            tryAgain: 'Try again',
            cancel: 'Cancel',
            backToFiles: 'Back to files',
            learnMore: 'Learn more',
            arrivedHeading: 'ARRIVED (saved on their computer)',
            keepInFront: 'Keep this tab in front until the last file arrives. For long drops, pin this tab.',
            badgeDirect: 'Direct',
            badgeRelay: 'Relay',
            stopTitle: 'Stop sending?',
            stopBody: 'Files that already arrived stay on their computer. This link cannot be used again.',
            keepSending: 'Keep sending',
            stop: 'Stop',
            reportLink: 'Report this link',
            pluggedIn: 'Keep this computer plugged in and awake. Pin this tab so Chrome does not put it to sleep.',
            startsOver: 'If the connection drops, the file that was moving starts over.',
            mayHaveSlept:
                'This computer may have slept. If the connection drops, the file that was moving starts over.',
        });
    });

    it('no copy string contains an em or en dash', () => {
        const all: string[] = [];
        const walk = (v: unknown) => {
            if (typeof v === 'string') all.push(v);
            else if (v && typeof v === 'object') Object.values(v).forEach(walk);
        };
        walk(visitorCopy);
        for (const code of [...TWELVE, null]) walk(refusalCopy(code, 3, 12));
        for (const s of ['V4', 'V5a', 'V5b', 'V5c', 'V6', 'V6a', 'V6c', 'V7', 'V8a', 'V8b', 'V9', 'V11a', 'V11b', 'V12', 'V12a', 'V13'] as const) {
            walk(statusCopy(model(s, { ackIndex: 3, stop: { refusal: 'disk-full', savedCount: 2 }, verifiedCount: 12 }), CTX));
            walk(announcement(model(s), CTX));
        }
        walk([countLine(2, 10), sendLabel(2), relayCapNotice(10), countdownLine(0), sendingHeader(1, 2)]);
        expect(all.length).toBeGreaterThan(60);
        for (const s of all) {
            expect(s, s).not.toMatch(new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']'));
        }
    });
});
