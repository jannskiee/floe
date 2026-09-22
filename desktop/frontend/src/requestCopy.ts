// The Request link's owner-facing copy, verbatim from the approved desktop copy
// table (Checkpoint C, 2026-09-18, D-091): every string here is a row of
// work/16-design/cp-3/approved-copy-desktop.md, named by its row ID, and
// approvedCopy.test.ts byte-matches each one against that file. Codes map to
// fixed sentences; engine text, error text and a visitor's words never render.
// Where a row carries a value (a time, a count, a size), the builder fills it,
// and the approved mock values reproduce the row exactly.
//
// Pure: no DOM, no Wails runtime, no clock except the injected one.

import {fmtBytes} from './incoming';

// ---- A request link pasted into Receive > CODE ----------------------------
export const CODE_PASTE_LINE = 'That is a request link for sending files to someone. Open it in a web browser.'; // CP2
export const OPEN_IN_BROWSER = 'Open in browser'; // CP3

// ---- Receive row and Ready -------------------------------------------------
export const CODE_TAB = 'Code'; // R1, rendered in uppercase
export const REQUEST_TAB = 'Request link'; // R1, rendered in uppercase
export const BETA_CHIP = 'Beta'; // R2, rendered in uppercase
export const REQUEST_TAB_NAME = 'Request link, beta'; // R3 (accessible name)
export const READY_HELPER = 'A link someone can use to send files to this PC. You accept before anything saves.'; // R4
export const LABEL_EYEBROW = 'Label'; // R6, rendered in uppercase
export const LABEL_HINT = 'Optional. Only you see it.'; // R7
export const SAVE_TO_EYEBROW = 'Save to'; // R8 and W7, rendered in uppercase
export const SAVE_TO_PLACEHOLDER = 'Downloads\\Floe requests'; // R9
export const BROWSE = 'Browse'; // R10
export const LINK_ENDS_EYEBROW = 'Link ends'; // R11, rendered in uppercase
export const LIFETIME_24H = 'In 24 hours'; // R12
export const LIFETIME_7D = 'In 7 days'; // R13
export const MAKE_LINK = 'Make link'; // R14
export const READY_IP_LINE = 'Works while Floe is open. The person you send it to can see your IP address once they connect, unless Hide my IP is on.'; // R15
export const MAKING_LINK = 'Making the link...'; // R16
export const READY_HIDE_IP_LINE = 'Hide my IP is on, so a drop goes through the relay and stops at 2 GB.'; // R17

// ---- Error, making a link (E3 is cut, E-25) --------------------------------
const ERROR_LINES: Record<string, string> = {
    disabled: 'Request links are turned off on the Floe server right now. Nothing else is affected.', // E1, X6
    limited: 'This network made too many request links today. Try again tomorrow.', // E2
    unknown: 'Floe could not make a link. Try again later.', // E4
    'no-relay': 'Hide my IP needs a TURN relay and this server has none. Turn off Hide my IP, or add a relay to the server.', // E5
    'relay-unknown': "Hide my IP needs a TURN relay, and this server's connection details could not be read. Check the server address, or turn off Hide my IP.", // E6
    'already-open': 'You already have a request link open. Close it to make a new one.', // E7
    'web-address': 'Floe cannot build a link for this server yet. Add the Share link address under Settings, Advanced, then make the link again.', // E8
};

function has(table: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(table, key);
}

/** errorLine maps a refusal code to its fixed sentence. Every other code,
 *  including `off`, a non-host role, `denied` (no such code in Stage 1, E-25)
 *  and anything a later server invents, is E4. */
export function errorLine(code: string): string {
    return has(ERROR_LINES, code) ? ERROR_LINES[code] : ERROR_LINES.unknown;
}

// ---- Times (spec 06 5.7): a local 12-hour clock, a date for later days -----
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** fmtClock renders "2:05 PM" in local time, independent of the locale. */
export function fmtClock(ms: number): string {
    const d = new Date(ms);
    const h = d.getHours();
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${h % 12 || 12}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
}

/** fmtEnds renders a link end for W5: "today, 2:05 PM", or the date for a
 *  later day, "Sep 24, 2:05 PM". */
export function fmtEnds(ms: number, now: number): string {
    const d = new Date(ms);
    const day = d.toDateString() === new Date(now).toDateString() ? 'today' : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
    return `${day}, ${fmtClock(ms)}`;
}

// ---- Waiting, reconnecting, connecting, ended ------------------------------
/** W1, and the ended heading: the owner's label in uppercase, or REQUEST LINK. */
export function linkHeading(label: string): string {
    return label ? label.toUpperCase() : 'REQUEST LINK';
}
export const COPY_LINK = 'Copy link'; // W2
export const COPIED = 'Copied'; // W3
export const CLOSE_LINK = 'Close link'; // W4
export function scopeLine(expiresAt: number, now: number): string {
    return `For one person. Ends ${fmtEnds(expiresAt, now)}.`; // W5
}
export const WAITING_LINE = 'Waiting for them to open the link.'; // W8
export const WAITING_IP_LINE = 'They can see your IP address once they connect, unless Hide my IP is on.'; // W9
export function missedLine(missedAt: number): string {
    return `You missed a request at ${fmtClock(missedAt)}. The link is still open.`; // W10
}
export const SETUP_FAILED_LINE = 'The sender could not connect.'; // W11
export const CONNECTING_LINE = 'Connecting to their computer.'; // W12
export const SUGGEST_CLOSE_LINE = '2 requests ended without Accept in the last 10 minutes. Close this link?'; // W13
export function reconnectingLine(expiresAt: number): string {
    return `No connection to the Floe server. Floe keeps trying until the link ends at ${fmtClock(expiresAt)}. Senders see: not connected.`; // C1
}
export const RETRY_NOW = 'Retry now'; // C2

/** reopenLine is the first line of the activity slot on a reopened link, or
 *  '' when the link simply waits. E-40's question outranks the reason for the
 *  last reopen; a visitor who left before setup finished gets no line (there
 *  is nobody to blame). */
export function reopenLine(s: {code: string; missedAt?: number; suggestClose: boolean}): string {
    if (s.suggestClose) return SUGGEST_CLOSE_LINE;
    if (s.code === 'setup-failed') return SETUP_FAILED_LINE;
    if (s.code === 'visitor-left') return '';
    if (s.missedAt) return missedLine(s.missedAt);
    return '';
}

/** endedLine: X1 at the link's own end time, X5 on the next launch after Floe
 *  closed with a link open, X2 otherwise (the network and server-restart ends
 *  were removed by E-34, so any other code is a close). */
export function endedLine(code: string, expiresAt: number): string {
    if (code === 'expired') return `This link ended at ${fmtClock(expiresAt)}.`; // X1
    if (code === 'app-closed') return 'This link stopped when Floe closed. Make a new one.'; // X5
    return 'Link closed.'; // X2
}
export const MAKE_ANOTHER_LINK = 'Make another link'; // X3, DN7

// ---- The request prompt and Declined ---------------------------------------
/** P1: whose request, in uppercase. Only the owner's own label, never a
 *  visitor string (OD-04, Q-C7). */
export function promptHeading(label: string): string {
    return label ? `${label.toUpperCase()} WANTS TO SEND YOU FILES` : 'SOMEONE WANTS TO SEND YOU FILES';
}

/** A count of files: "1 file", "12 files". */
export function filesCount(n: number): string {
    return `${n} ${n === 1 ? 'file' : 'files'}`;
}

/** P2: the visitor's claimed count and size, both numbers. */
export function promptSize(files: number, totalBytes: number): string {
    return `${filesCount(files)}, ${fmtBytes(totalBytes)}`;
}
export const INTO = 'Into'; // P3, before the host-computed folder

/** driveOf names the volume a save folder is on, for P4: "D:" for a drive
 *  path, the \\server\share root for a network path, the folder otherwise. */
export function driveOf(saveDir: string): string {
    const drive = /^[A-Za-z]:/.exec(saveDir);
    if (drive) return drive[0].toUpperCase();
    const unc = /^\\\\[^\\]+\\[^\\]+/.exec(saveDir);
    if (unc) return unc[0];
    return saveDir;
}

/** warningLine maps a prompt warning code to its line (P4, P5, P6, P11), or
 *  '' for a code this build does not know. */
export function warningLine(code: string, p: {freeBytes: number; totalBytes: number}, saveDir: string): string {
    switch (code) {
        case 'low-space':
            return `Only ${fmtBytes(p.freeBytes)} free on ${driveOf(saveDir)}. The drop will stop when the drive fills.`; // P4
        case 'file-too-large-for-drive':
            return 'This drive cannot save files over 4 GB. A larger file will stop the drop.'; // P5
        case 'relay-over-cap':
            return `Hide my IP is on, so this ${fmtBytes(p.totalBytes)} drop will stop before any file.`; // P6
        case 'laptop-power':
            return 'On a laptop, plug in and keep the lid open.'; // P11
        default:
            return '';
    }
}

/** P8: minutes only, rounded up, so the last minute still reads 1 min. */
export function answerWithin(answerBy: number, now: number): string {
    return `Answer within ${Math.max(1, Math.ceil((answerBy - now) / 60000))} min`;
}
export const ACCEPT = 'Accept'; // P9
export const DECLINE = 'Decline'; // P9
export const PROMPT_CAUTION = 'Accept only if you expect files from the person you sent this link to.'; // P10
export const DECLINED_LINE = 'You declined. Nothing was saved.'; // D1
export const DECLINED_QUESTION = 'Keep this link open for the person you meant to send it to?'; // D2
export const KEEP_WAITING = 'Keep waiting'; // D3

// ---- Receiving -------------------------------------------------------------
/** V1: file N of M, from the owner's label when there is one. */
export function receivingHeading(index: number, count: number, label: string): string {
    return `RECEIVING ${index} OF ${count}${label ? ` FROM ${label.toUpperCase()}` : ''}`;
}
/** V3, the first of its three numbers. */
export function receivedOf(bytes: number, total: number): string {
    return `${fmtBytes(bytes)} of ${fmtBytes(total)}`;
}
/** V3, the third: "34s left". */
export function timeLeft(eta: string): string {
    return `${eta} left`;
}
export const CANCEL_DROP = 'Cancel drop'; // V4
export const ETA_OVER_2H_LINE = 'If the connection drops, the file that was moving starts over. Windows may restart for updates outside your active hours.'; // V5
/** V6, with the estimate in whole days. */
export function etaLongLine(etaSeconds: number): string {
    const days = Math.max(1, Math.round(etaSeconds / 86400));
    return `This drop would take about ${days} ${days === 1 ? 'day' : 'days'} on this connection and will stop at 24 hours.`;
}
export const RELAY_DROP_TOOLTIP = 'Request link: relay, capped at 2 GB.'; // V8
/** H3: a relayed drop and a direct Send both moving. */
export const RELAY_DROP_DIRECT_SEND_TOOLTIP = 'Request link: relay, capped at 2 GB. Send: direct.'; // H3

// ---- Done ------------------------------------------------------------------
/** DN1: RECEIVED 12 FILES, 38.0 GB. */
export function doneHeading(files: number, bytes: number): string {
    return `RECEIVED ${filesCount(files).toUpperCase()}, ${fmtBytes(bytes).toUpperCase()}`;
}
export const DISMISS = 'Dismiss'; // DN2
export const VERIFIED_LINE = "Every file arrived intact: its SHA-256 matched the sender's."; // DN3
export function renamedLine(n: number): string {
    return n === 1
        ? '1 file was renamed to end in .floe-blocked because Windows can open it by itself.' // DN4
        : `${n} files were renamed to end in .floe-blocked because Windows can open that kind of file by itself.`; // DN4p
}
export const NOT_SCANNED_LINE = 'Floe does not scan files for malware.'; // DN5
export const SHOW_IN_FOLDER = 'Show in folder'; // DN6, DN9
// DN8, drawn as a title and a question (DO-03, DH-03).
export const RENAMED_CONFIRM_TITLE = 'This drop contains renamed files.';
export const RENAMED_CONFIRM_QUESTION = 'Open the folder anyway?';
export const CANCEL = 'Cancel'; // DN9

/** folderName is the exclusive subfolder's own name, for the DN6 row. */
export function folderName(path: string): string {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : path;
}

/** verifiedAll: the DN3 line shows only when every file's SHA-256 matched. */
export function verifiedAll(r: {files: number; saved: number; verified: number}): boolean {
    return r.files > 0 && r.saved === r.files && r.verified === r.files;
}

// ---- Stopped (ST2 is cut, E-24; ST13 has no source in Stage 1) --------------
export const STOPPED_HEADING = 'DROP STOPPED'; // ST0
export const STOPPED_FOLLOW_UP = 'The sender can send the rest with a new link.'; // ST15
/** ST16, and the tail of every stop sentence that carries a count. */
export function savedOf(saved: number, files: number): string {
    return `${saved} of ${files} files were saved.`;
}

// One entry per stop code: the card body under DROP STOPPED, and the full
// sentence the History row keeps (DH-02). `count` says whether the sentence
// carries its own count (ST1, ST10 to ST12), takes ST16 on the card (ST3 to
// ST5, ST7 to ST9), or has none (ST6, nothing was saved).
const STOPS: Record<string, {card: string; full: string; count: 'own' | 'append' | 'none'}> = {
    'disk-full': {card: 'The drive ran out of space.', full: 'Drop stopped: the drive ran out of space.', count: 'own'}, // ST1
    'hash-mismatch': {card: 'A file did not match what was sent, so Floe deleted it.', full: 'Drop stopped: a file did not match what was sent, so Floe deleted it.', count: 'append'}, // ST3
    'path-too-long': {card: 'A folder path was too long for Windows.', full: 'Drop stopped: a folder path was too long for Windows.', count: 'append'}, // ST4
    'over-approved': {card: 'More data arrived than you accepted.', full: 'Drop stopped: more data arrived than you accepted.', count: 'append'}, // ST5
    'relay-cap': {card: 'Over 2 GB through the relay, so it stopped before any file was saved.', full: 'Drop stopped before any file: over 2 GB through the relay.', count: 'none'}, // ST6
    'file-too-large-for-folder': {card: 'A file is too large for this drive.', full: 'Drop stopped: a file is too large for this drive.', count: 'append'}, // ST7
    'write-failed': {card: 'Windows could not write to the folder.', full: 'Drop stopped: Windows could not write to the folder.', count: 'append'}, // ST8
    'save-blocked': {card: 'Windows would not let Floe save a file, even after trying for 5 minutes.', full: 'Drop stopped: Windows would not let Floe save a file.', count: 'append'}, // ST9
    stopped: {card: 'You stopped this drop.', full: 'You stopped this drop.', count: 'own'}, // ST10
    'peer-abort': {card: 'The sender stopped this drop.', full: 'Drop stopped: the sender left.', count: 'own'}, // ST11
    'time-limit': {card: 'The drop reached the 24-hour limit.', full: 'Drop stopped: it reached the 24-hour limit.', count: 'own'}, // ST12
};

/** stoppedCard is the body under DROP STOPPED. An unknown code, and every
 *  host-side stop that no peer frame explains, is ST14: the count alone,
 *  blaming nobody (E-42). Only peer-abort names the sender. */
export function stoppedCard(code: string, saved: number, files: number): string {
    if (!has(STOPS, code)) return savedOf(saved, files); // ST14
    const s = STOPS[code];
    return s.count === 'none' ? s.card : `${s.card} ${savedOf(saved, files)}`;
}

/** stoppedFull is the History form of the same stop (DH-02): the row's own
 *  sentence, which carries a count only when the approved row does. */
export function stoppedFull(code: string, saved: number, files: number): string {
    if (!has(STOPS, code)) return `Drop stopped. ${savedOf(saved, files)}`; // ST14
    const s = STOPS[code];
    if (s.count !== 'own') return s.full;
    if (code === 'peer-abort') return `${s.full} ${saved} of ${files} files arrived.`; // ST11
    return `${s.full} ${savedOf(saved, files)}`;
}

/** stoppedShowsFolder: Show in folder and the follow-up line appear only when
 *  at least one file was saved (DT-05 draws neither for relay-cap). */
export function stoppedShowsFolder(code: string, saved: number): boolean {
    return saved > 0 && code !== 'relay-cap';
}

// ---- Dialogs, header, notice, announcements --------------------------------
export const CLOSE_LINK_OPEN_LINE = 'Your request link stops working until you make a new one.'; // CL2
export const KEEP_FLOE_OPEN = 'Keep Floe open'; // CL3
export const CLOSE_FLOE = 'Close Floe'; // CL3
export const CLOSE_DROP_RECEIVING_LINE = "You're still receiving. If you close now, the transfer stops before the files finish."; // CL4
export const CLOSE_LINK_ALSO_LINE = 'Your request link also stops working.'; // CL5
export const START_OVER_LINK_LINE = 'Your request link stays open.'; // SO1
export const MARKER_TEXT = 'link open'; // H1
export const MARKER_NAME = 'Request link is open'; // H2
export const NOTICE_TEXT = 'Someone wants to send you files.'; // N1
export const NOTICE_REVIEW = 'Review'; // N2
export const ANNOUNCE_REQUEST = 'Request link: someone wants to send you files.'; // A1
export const ANNOUNCE_GUARD_LIFTED = 'Accept and Decline are ready.'; // A2
