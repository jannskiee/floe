import {describe, expect, it} from 'vitest';
import * as copy from './requestCopy';
import {
    answerWithin,
    doneHeading,
    endedLine,
    errorLine,
    etaLongLine,
    fmtClock,
    fmtEnds,
    linkHeading,
    promptHeading,
    promptSize,
    receivingHeading,
    renamedLine,
    reopenLine,
    savedOf,
    scopeLine,
    stoppedCard,
    stoppedFull,
    stoppedShowsFolder,
    warningLine,
} from './requestCopy';

// The approved mock values (copy table D-3): label Acme footage, save folder
// D:\Footage\Floe requests, link end 2:05 PM, missed request 2:14 PM. Local
// times, built from components, so the clock formatting is what is tested.
const END = new Date(2026, 8, 14, 14, 5).getTime();
const MISSED = new Date(2026, 8, 14, 14, 14).getTime();
const NOW = new Date(2026, 8, 14, 9, 30).getTime();
const GB = 1024 ** 3;

describe('error codes', () => {
    it.each([
        ['disabled', 'Request links are turned off on this server right now.'],
        ['limited', 'This network made too many request links today. Try again tomorrow.'],
        ['unknown', 'Floe could not make a link. Try again later.'],
        ['already-open', 'You already have a request link open. Close it to make a new one.'],
        ['no-relay', 'Hide my IP needs a TURN relay and this server has none. Turn off Hide my IP, or add a relay to the server.'],
        ['relay-unknown', "Hide my IP needs a TURN relay, and this server's connection details could not be read. Check the server address, or turn off Hide my IP."],
    ])('maps %s to fixed copy', (code, want) => {
        expect(errorLine(code)).toBe(want);
    });

    it('maps off to fixed copy (E4: the switch-off refusal has no sentence of its own)', () => {
        expect(errorLine('off')).toBe('Floe could not make a link. Try again later.');
    });

    it('maps web-address to E4: nothing sends it since D-118 allowed one-domain self-hosts, and E8 is cut', () => {
        expect(errorLine('web-address')).toBe('Floe could not make a link. Try again later.');
    });

    it('an unrecognized error code such as denied maps to the E4 sentence', () => {
        for (const code of ['denied', 'role-sender', '', 'toString', '__proto__', 'constructor']) {
            expect(errorLine(code), code).toBe('Floe could not make a link. Try again later.');
        }
    });
});

describe('waiting, reconnecting and ended lines', () => {
    it('maps setup-failed to fixed copy', () => {
        expect(reopenLine({code: 'setup-failed', suggestClose: false})).toBe('The sender could not connect.');
    });

    it('maps missedAt to fixed copy', () => {
        expect(reopenLine({code: '', missedAt: MISSED, suggestClose: false})).toBe('You missed a request at 2:14 PM.');
    });

    it('suggestClose shows the Close this link line', () => {
        expect(reopenLine({code: '', missedAt: MISSED, suggestClose: true})).toBe('2 requests ended without Accept in the last 10 minutes. Close this link?');
    });

    it('maps visitor-left to no line', () => {
        expect(reopenLine({code: 'visitor-left', missedAt: MISSED, suggestClose: false})).toBe('');
        expect(reopenLine({code: '', suggestClose: false})).toBe('');
    });

    it('maps reconnecting to fixed copy (C1, two lines)', () => {
        expect(copy.RECONNECTING_LINE).toBe('No connection to the Floe server.');
        expect(copy.RECONNECTING_NOTE).toBe('Floe keeps trying.');
    });

    it('maps expired to fixed copy', () => {
        expect(endedLine('expired', END)).toBe('Link ended at 2:05 PM.');
    });

    it('maps closed to fixed copy', () => {
        expect(endedLine('closed', END)).toBe('Link closed.');
    });

    it('maps app-closed to fixed copy', () => {
        expect(endedLine('app-closed', END)).toBe('Link stopped when Floe closed.');
    });

    it('has no network or server-restart ending (E-34)', () => {
        expect(endedLine('network', END)).toBe('Link closed.');
        expect(endedLine('server-restart', END)).toBe('Link closed.');
    });

    it('writes the scope line with the link end, today or on a later date', () => {
        expect(scopeLine(END, NOW)).toBe('For one person. Ends today, 2:05 PM.');
        expect(fmtEnds(new Date(2026, 8, 21, 9, 0).getTime(), NOW)).toBe('Sep 21, 9:00 AM');
        expect(fmtClock(new Date(2026, 8, 14, 0, 7).getTime())).toBe('12:07 AM');
        expect(fmtClock(new Date(2026, 8, 14, 12, 0).getTime())).toBe('12:00 PM');
    });

    it('headings use the label in uppercase or the fallback', () => {
        expect(linkHeading('Acme footage')).toBe('ACME FOOTAGE');
        expect(linkHeading('')).toBe('REQUEST LINK');
    });
});

describe('the prompt', () => {
    it('reads count, size and whose request (P1, P2)', () => {
        expect(promptHeading('Acme footage')).toBe('ACME FOOTAGE WANTS TO SEND YOU FILES');
        expect(promptHeading('')).toBe('SOMEONE WANTS TO SEND YOU FILES');
        expect(promptSize(12, 38 * GB)).toBe('12 files, 38.0 GB');
        expect(promptSize(1, 1024)).toBe('1 file, 1.0 KB');
    });

    it.each([
        ['low-space', 'Only 31.0 GB free on D:. The drop will stop when the drive fills.'],
        ['file-too-large-for-drive', 'This drive cannot save files over 4 GB, so this drop will stop.'],
        ['relay-over-cap', 'Hide my IP is on, so this 38.0 GB drop will stop before any file.'],
        ['laptop-power', 'On a laptop, plug in and keep the lid open.'],
    ])('maps %s to fixed copy', (code, want) => {
        expect(warningLine(code, {freeBytes: 31 * GB, totalBytes: 38 * GB}, 'D:\\Footage\\Floe requests')).toBe(want);
    });

    it('drops a warning code it does not know', () => {
        expect(warningLine('battery-standby', {freeBytes: 0, totalBytes: 0}, 'C:\\x')).toBe('');
        expect(warningLine('<img src=x onerror=alert(1)>', {freeBytes: 0, totalBytes: 0}, 'C:\\x')).toBe('');
    });

    it('counts the answer window in whole minutes', () => {
        expect(answerWithin(NOW + 9 * 60000, NOW)).toBe('Answer within 9 min');
        expect(answerWithin(NOW + 8 * 60000 + 1, NOW)).toBe('Answer within 9 min');
        expect(answerWithin(NOW + 1000, NOW)).toBe('Answer within 1 min');
        expect(answerWithin(NOW - 1000, NOW)).toBe('Answer within 1 min');
    });
});

describe('receiving and done', () => {
    it('reads the receiving heading (V1)', () => {
        expect(receivingHeading(4, 12, 'Acme footage')).toBe('RECEIVING 4 OF 12 FROM ACME FOOTAGE');
        expect(receivingHeading(4, 12, '')).toBe('RECEIVING 4 OF 12');
    });

    it('reads the long-drop line in days (V6)', () => {
        expect(etaLongLine(3 * 86400)).toBe('This drop would take about 3 days on this connection and will stop at 24 hours.');
    });

    it('reads the done heading and the renamed lines (DN1, DN4, DN4p)', () => {
        expect(doneHeading(12, 38 * GB)).toBe('RECEIVED 12 FILES, 38.0 GB');
        expect(renamedLine(1)).toBe('1 file was renamed to end in .floe-blocked because Windows can open it by itself.');
        expect(renamedLine(2)).toBe('2 files were renamed to end in .floe-blocked because Windows can open that kind of file by itself.');
    });

    it('shows the SHA-256 line only when every file verified', () => {
        expect(copy.verifiedAll({files: 12, saved: 12, verified: 12})).toBe(true);
        expect(copy.verifiedAll({files: 12, saved: 12, verified: 11})).toBe(false);
        expect(copy.verifiedAll({files: 12, saved: 11, verified: 12})).toBe(false);
        expect(copy.verifiedAll({files: 0, saved: 0, verified: 0})).toBe(false);
    });
});

describe('stop codes', () => {
    it.each([
        ['disk-full', 'The drive ran out of space. 4 of 12 files were saved.'],
        ['hash-mismatch', 'A file did not match what was sent, so Floe deleted it. 4 of 12 files were saved.'],
        ['path-too-long', 'A folder path was too long for Windows. 4 of 12 files were saved.'],
        ['over-approved', 'More data arrived than you accepted. 4 of 12 files were saved.'],
        ['relay-cap', 'Over the 2 GB relay limit. Nothing was saved.'],
        ['file-too-large-for-folder', 'A file is too large for this drive. 4 of 12 files were saved.'],
        ['write-failed', 'Windows could not write to the folder. 4 of 12 files were saved.'],
        ['save-blocked', 'Windows would not let Floe finish saving a file. 4 of 12 files were saved.'],
        ['stopped', 'You stopped this drop. 4 of 12 files were saved.'],
        ['peer-abort', 'The sender stopped this drop. 4 of 12 files were saved.'],
        ['time-limit', 'The drop reached the 24-hour limit. 4 of 12 files were saved.'],
    ])('maps %s to fixed copy', (code, want) => {
        expect(stoppedCard(code, 4, 12)).toBe(want);
    });

    it('unknown code maps to ST14', () => {
        for (const code of ['', 'unknown', 'too-slow', 'declined', 'toString', '__proto__', 'Drop stopped: $(calc)']) {
            expect(stoppedCard(code, 4, 12), code).toBe('4 of 12 files were saved.');
            expect(stoppedFull(code, 4, 12), code).toBe('Drop stopped. 4 of 12 files were saved.');
        }
    });

    it('keeps the History form of each stop (DH-02)', () => {
        expect(stoppedFull('disk-full', 4, 12)).toBe('Drop stopped: the drive ran out of space. 4 of 12 files were saved.');
        expect(stoppedFull('hash-mismatch', 4, 12)).toBe('Drop stopped: a file did not match what was sent, so Floe deleted it.');
        expect(stoppedFull('relay-cap', 0, 12)).toBe('Drop stopped before any file: over 2 GB through the relay.');
        expect(stoppedFull('peer-abort', 4, 12)).toBe('Drop stopped: the sender left. 4 of 12 files arrived.');
        expect(stoppedFull('time-limit', 4, 12)).toBe('Drop stopped: it reached the 24-hour limit. 4 of 12 files were saved.');
        expect(stoppedFull('stopped', 4, 12)).toBe('You stopped this drop. 4 of 12 files were saved.');
    });

    it('peer-abort is the only code that blames the sender', () => {
        const codes = ['disk-full', 'hash-mismatch', 'path-too-long', 'over-approved', 'relay-cap', 'file-too-large-for-folder',
            'write-failed', 'save-blocked', 'stopped', 'peer-abort', 'time-limit', 'unknown', ''];
        const blaming = codes.filter((c) => /sender/i.test(stoppedCard(c, 4, 12)) || /sender/i.test(stoppedFull(c, 4, 12)));
        expect(blaming).toEqual(['peer-abort']);
    });

    it('shows the folder only when a file was saved', () => {
        expect(stoppedShowsFolder('disk-full', 4)).toBe(true);
        expect(stoppedShowsFolder('disk-full', 0)).toBe(false);
        expect(stoppedShowsFolder('relay-cap', 3)).toBe(false);
    });

    it('counts saved files in the web grammar: a singular form, and Nothing was saved (ST16, D-136)', () => {
        expect(savedOf(4, 12)).toBe('4 of 12 files were saved.');
        expect(savedOf(1, 12)).toBe('1 of 12 files were saved.');
        expect(savedOf(1, 1)).toBe('1 of 1 file was saved.');
        for (const files of [0, 1, 12]) expect(savedOf(0, files), `0 of ${files}`).toBe('Nothing was saved.');
        // Every stop that carries a count inherits the forms, card and History.
        expect(stoppedCard('disk-full', 1, 1)).toBe('The drive ran out of space. 1 of 1 file was saved.');
        expect(stoppedCard('disk-full', 0, 12)).toBe('The drive ran out of space. Nothing was saved.');
        expect(stoppedCard('path-too-long', 0, 1)).toBe('A folder path was too long for Windows. Nothing was saved.');
        expect(stoppedCard('unknown', 0, 0)).toBe('Nothing was saved.');
        expect(stoppedFull('unknown', 1, 1)).toBe('Drop stopped. 1 of 1 file was saved.');
        expect(stoppedFull('time-limit', 0, 3)).toBe('Drop stopped: it reached the 24-hour limit. Nothing was saved.');
        // ST11's History form says "arrived", with the numbers and the singular.
        expect(stoppedFull('peer-abort', 1, 1)).toBe('Drop stopped: the sender left. 1 of 1 file arrived.');
        expect(stoppedFull('peer-abort', 3, 12)).toBe('Drop stopped: the sender left. 3 of 12 files arrived.');
        expect(stoppedCard('peer-abort', 1, 1)).toBe('The sender stopped this drop. 1 of 1 file was saved.');
    });

    it('the save-blocked card carries a count only when a file was saved (ST9 beside ST17)', () => {
        // "Nothing was saved." next to "The complete file was kept" would
        // contradict itself: the file is whole and verified, under its .part.
        expect(stoppedCard('save-blocked', 0, 12)).toBe('Windows would not let Floe finish saving a file.');
        expect(stoppedCard('save-blocked', 0, 1)).toBe('Windows would not let Floe finish saving a file.');
        expect(stoppedCard('save-blocked', 3, 12)).toBe('Windows would not let Floe finish saving a file. 3 of 12 files were saved.');
        expect(stoppedCard('save-blocked', 1, 1)).toBe('Windows would not let Floe finish saving a file. 1 of 1 file was saved.');
        // History keeps its own sentence, without a count, whatever was saved.
        expect(stoppedFull('save-blocked', 0, 12)).toBe('Drop stopped: Windows would not let Floe save a file.');
        expect(stoppedFull('save-blocked', 3, 12)).toBe('Drop stopped: Windows would not let Floe save a file.');
        // Every other stop still says it when nothing was saved.
        expect(stoppedCard('write-failed', 0, 12)).toBe('Windows could not write to the folder. Nothing was saved.');
        expect(stoppedCard('relay-cap', 0, 12)).toBe('Over the 2 GB relay limit. Nothing was saved.');
    });

    it('a save-blocked stop shows the folder and the kept-file line whatever was saved (D-128)', () => {
        // The one exception to DT-05's rule for the folder: the engine keeps
        // the file it could not move into place, complete and verified, as a
        // .part in the drop folder (E-36).
        expect(stoppedShowsFolder('save-blocked', 0)).toBe(true);
        expect(stoppedShowsFolder('save-blocked', 3)).toBe(true);
        // ST17 (D-136), RX10's second sentence with "folder" for "save
        // folder"; the code receive keeps RX10 (errors.ts COMMIT_KEPT_PART).
        expect(copy.SAVE_BLOCKED_KEPT_LINE).toBe('The complete file was kept in the folder with a .part ending.');
        expect(copy.keptPartLine('save-blocked')).toBe(copy.SAVE_BLOCKED_KEPT_LINE);
        expect(Object.values(copy)).not.toContain('Received a file in full but could not finish saving it. The complete file was kept in the save folder with a .part ending.');
        for (const code of ['disk-full', 'write-failed', 'relay-cap', 'stopped', 'peer-abort', 'unknown', '', '<img src=x onerror=alert(1)>']) {
            expect(copy.keptPartLine(code), code).toBe('');
        }
    });
});

describe('the whole table', () => {
    // Every string the module can produce, over every code the lane names and
    // a set of hostile ones, with a hostile value in every slot a value can
    // reach.
    const HOSTILE = ['$(calc)', ']]><![CDATA[', '<img src=x onerror=alert(1)>', '\u202Etxt.exe', 'x'.repeat(5000)];
    const CODES = ['off', 'disabled', 'limited', 'unknown', 'already-open', 'no-relay', 'relay-unknown', 'expired',
        'closed', 'app-closed', 'setup-failed', 'visitor-left', 'disk-full', 'hash-mismatch', 'path-too-long', 'over-approved',
        'relay-cap', 'file-too-large-for-folder', 'write-failed', 'save-blocked', 'stopped', 'peer-abort', 'time-limit',
        'low-space', 'file-too-large-for-drive', 'relay-over-cap', 'laptop-power', 'denied', 'too-slow', ...HOSTILE];

    function everyOutput(): string[] {
        const out: string[] = [];
        for (const v of Object.values(copy)) if (typeof v === 'string') out.push(v);
        for (const code of CODES) {
            out.push(errorLine(code), endedLine(code, END), stoppedCard(code, 4, 12), stoppedFull(code, 4, 12), copy.keptPartLine(code));
            out.push(warningLine(code, {freeBytes: 31 * GB, totalBytes: 38 * GB}, 'D:\\Footage\\Floe requests'));
            out.push(reopenLine({code, missedAt: MISSED, suggestClose: false}), reopenLine({code, suggestClose: false}));
        }
        return out;
    }

    it('a hostile reason never appears in any output', () => {
        // Codes are the only input, and a code is looked up, never printed.
        for (const s of everyOutput()) {
            for (const h of HOSTILE) expect(s.includes(h), `${s} carries ${h.slice(0, 20)}`).toBe(false);
        }
    });

    it('no too-slow copy exists', () => {
        for (const s of everyOutput()) {
            expect(s).not.toMatch(/minimum speed/i);
        }
        expect(stoppedCard('too-slow', 4, 12)).toBe('4 of 12 files were saved.');
    });

    it('no string contains an en dash or em dash', () => {
        for (const s of everyOutput()) {
            expect(s).not.toMatch(/[\u2013\u2014]/);
        }
    });

    it('carries no pending-rename, QR or denied copy', () => {
        const all = everyOutput().join('\n');
        // DN10, the pending-rename line, stays cut (E-36): it named the kept
        // file ("It is kept as A001_C002.mov.part"). The one .part sentence
        // the module may produce is RX10's, which names none (D-128).
        expect(all).not.toMatch(/keep trying for 5 minutes|would not let Floe rename|kept as \S*\.part|QR|scans this|turned off request links for this network/);
        expect(all.match(/\.part\b/g) ?? []).toHaveLength(all.split(copy.SAVE_BLOCKED_KEPT_LINE).length - 1);
    });
});
