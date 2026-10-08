// The Request link's owner-facing copy, verbatim from the desktop copy table
// (frozen at Checkpoint C 2026-09-18, D-091; the calm pass D-167 took every
// line's closing period and cut the words; kept outside this repository): every
// string here is a row of that table, named by its row ID, and
// approvedCopy.test.ts byte-matches each one against it. Codes map to
// fixed sentences; engine text, error text and a visitor's words never render.
// Where a row carries a value (a time, a count, a size), the builder fills it,
// and the approved mock values reproduce the row exactly.
//
// Pure: no DOM, no Wails runtime, no clock except the injected one.

import {fmtBytes} from './incoming';
import {shortPath} from './paths';

// ---- A request link pasted into Receive > CODE ----------------------------
export const CODE_PASTE_LINE = 'Request links open in a web browser'; // CP2
export const OPEN_IN_BROWSER = 'Open in browser'; // CP3

// ---- Receive row and Ready -------------------------------------------------
export const CODE_TAB = 'Code'; // R1, rendered in uppercase
export const REQUEST_TAB = 'Request link'; // R1, rendered in uppercase
export const BETA_CHIP = 'Beta'; // R2, rendered in uppercase
export const REQUEST_TAB_NAME = 'Request link, beta'; // R3 (accessible name)
export const LABEL_EYEBROW = 'Label'; // R6, rendered in uppercase
export const LABEL_PLACEHOLDER = 'Optional'; // R7, the label field's placeholder (D-161, D-167)
export const SAVE_TO_EYEBROW = 'Save to'; // R8 and W7, rendered in uppercase
export const SAVE_TO_PLACEHOLDER = 'Downloads\\Floe'; // R9, the real default folder (D-167)
export const BROWSE = 'Browse'; // R10
export const LINK_ENDS_EYEBROW = 'Link ends'; // R11, rendered in uppercase
// The six Link ends choices (D-173), listed R24, R25, R26, R12, R27, R13 by
// requestLink.ts LIFETIMES. Each stays a top-level export so the copy and
// punctuation scans see it.
export const LIFETIME_30M = 'In 30 minutes'; // R24
export const LIFETIME_1H = 'In 1 hour'; // R25
export const LIFETIME_8H = 'In 8 hours'; // R26
export const LIFETIME_24H = 'In 24 hours'; // R12
export const LIFETIME_3D = 'In 3 days'; // R27
export const LIFETIME_7D = 'In 7 days'; // R13
export const MAKE_LINK = 'Make link'; // R14
export const READY_IP_LINE = 'Senders see your IP, even if you decline'; // R15, only while Hide my IP is off
export const MAKING_LINK = 'Making link...'; // R16
export const READY_HIDE_IP_LINE = 'Hide my IP limits drops to 2 GB'; // R17
// Auto-accept (D-173, D-174): an inline check under LINK ENDS with an info
// icon. R28, the eyebrow it had as a switch box in H10, is cut: the check
// belongs to the LINK ENDS group.
export const AUTO_ACCEPT_LABEL = 'Auto-accept'; // R29, the checkbox's accessible name
export const READY_AUTO_LINE = 'Anyone with this link can send you files without asking'; // R30, amber, only while R29 is on
export const AUTO_ACCEPT_TIP = 'Only turn this on if you trust everyone with the link'; // R31, the info tooltip's warning, amber with a caution icon
export const AUTO_ACCEPT_TIP_DETAIL = 'Files save without asking, except in a few cases, like low space or a USB drive'; // R31a, its second line, gray (an open list: G4 to G13 ask in more cases than two)
export const AUTO_ACCEPT_ABOUT = 'About Auto-accept'; // R32, the info icon's accessible name

// ---- Error, making a link (E3 is cut, E-25; E8 is cut, D-122) --------------
const ERROR_LINES: Record<string, string> = {
    disabled: 'Request links are off on this server', // E1, X6
    limited: "This network reached today's link limit", // E2
    unknown: "Couldn't make a link", // E4
    'no-relay': "Hide my IP needs a relay this server doesn't have", // E5
    'relay-unknown': "Couldn't read this server's relay details for Hide my IP", // E6
    'already-open': 'Close your open link to make a new one', // E7
    'save-folder': "Couldn't use that folder", // E9 (D-177): a Save to folder Floe cannot use, refused at Make link
};

function has(table: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(table, key);
}

/** errorLine maps a refusal code to its fixed sentence. Every other code,
 *  including a non-host role, `denied` (no such code in Stage 1, E-25)
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
export const ACCEPTS_AUTOMATICALLY = 'Accepts automatically'; // W5a, after the end time
/** W5, and W5a on a link made with Auto-accept on (D-173). */
export function scopeLine(expiresAt: number, now: number, autoAccept = false): string {
    const w5 = `Ends ${fmtEnds(expiresAt, now)}`; // W5 (D-168: no "For one person")
    return autoAccept ? `${w5} · ${ACCEPTS_AUTOMATICALLY}` : w5; // W5a
}
export const WAITING_LINE = 'Waiting for files'; // W8 (W9 is cut: the IP line is said once, at Ready)
export function missedLine(missedAt: number): string {
    return `Missed a request at ${fmtClock(missedAt)}`; // W10
}
export const SETUP_FAILED_LINE = "The sender couldn't connect"; // W11
export const CONNECTING_LINE = 'Connecting to the sender...'; // W12
export const SUGGEST_CLOSE_LINE = '2 requests ended without Accept in 10 minutes. Close this link?'; // W13
// C1, two lines: the news, then the reassurance, quieter.
export const RECONNECTING_LINE = "Can't reach the Floe server"; // C1, line 1
export const RECONNECTING_NOTE = 'Reconnecting...'; // C1, line 2
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

/** endedLine: X1 at the link's own end time, X2 otherwise (the network and
 *  server-restart ends were removed by E-34, and X5, the line after a
 *  relaunch, by D-170, so any other code is a close). */
export function endedLine(code: string, expiresAt: number): string {
    if (code === 'expired') return `Link ended at ${fmtClock(expiresAt)}`; // X1
    return 'Link closed'; // X2
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

/** warningLine maps a prompt warning code to its line (P4, P5, P6), or '' for a
 *  code this build does not know. The laptop-power code is no longer one: P11
 *  is the Receiving view's LAPTOP_LINE (E-94). */
export function warningLine(code: string, p: {freeBytes: number; totalBytes: number}, saveDir: string): string {
    switch (code) {
        case 'low-space':
            return `Only ${fmtBytes(p.freeBytes)} free on ${driveOf(saveDir)}, not enough for this drop`; // P4
        case 'file-too-large-for-drive':
            return "This drive can't save files over 4 GB"; // P5
        case 'relay-over-cap':
            return `This ${fmtBytes(p.totalBytes)} drop is over the 2 GB Hide my IP limit`; // P6
        default:
            return '';
    }
}

/** P12, Accept's countdown (D-169; it replaced P8, the "9 min to answer"
 *  line): minutes and seconds to the answer deadline, rounded down (D-143),
 *  so it never promises more time
 *  than is left: the host's 9 min 45 s window starts at 9:45 and the
 *  countdown stops at 0:00, when the prompt answers itself. */
export function countdown(answerBy: number, now: number): string {
    const s = Math.max(0, Math.floor((answerBy - now) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
export const ACCEPT = 'Accept'; // P9
export const DECLINE = 'Decline'; // P9
// P10 is cut (D-161): the caution lives in the docs, request-links.mdx#accept-or-decline.
export const DECLINED_LINE = 'Request declined'; // D1
export const DECLINED_QUESTION = 'Keep waiting for the right sender?'; // D2
export const KEEP_WAITING = 'Keep waiting'; // D3

// ---- Receiving -------------------------------------------------------------
/** P11: advice for a PC with a battery, shown while a long drop receives. */
export const LAPTOP_LINE = 'Keep this laptop plugged in and open';
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
export const ETA_OVER_2H_LINE = 'If the connection drops, the current file starts over'; // V5
/** V6, with the estimate in whole days. */
export function etaLongLine(etaSeconds: number): string {
    const days = Math.max(1, Math.round(etaSeconds / 86400));
    return `About ${days} ${days === 1 ? 'day' : 'days'} at this speed, past the 24-hour limit`;
}

// ---- Done ------------------------------------------------------------------
/** DN1: RECEIVED 12 FILES, 38.0 GB. */
export function doneHeading(files: number, bytes: number): string {
    return `RECEIVED ${filesCount(files).toUpperCase()}, ${fmtBytes(bytes).toUpperCase()}`;
}
/** DN3, the D-101 words. Never drawn: a green check says it, and screen readers read these. */
export const VERIFIED_LINE = 'SHA-256 matched';
export function renamedLine(n: number): string {
    return n === 1
        ? "1 file now ends in .floe-blocked so Windows won't open it on its own" // DN4
        : `${n} files now end in .floe-blocked so Windows won't open them on their own`; // DN4p
}
/** DN5, drawn only when the save volume cannot carry the downloaded-file mark (S-7). */
export const NOT_SCANNED_LINE = "Floe doesn't scan files for malware";
export const SHOW_IN_FOLDER = 'Show in folder'; // DN6, DN9
// DN8, drawn as a title and a question (DO-03, DH-03).
export const RENAMED_CONFIRM_TITLE = 'This drop has renamed files';
export const RENAMED_CONFIRM_QUESTION = 'Open the folder anyway?';
export const CANCEL = 'Cancel'; // DN9

// ---- The saved files on Done and Stopped (D-171) -------------------------
export const RECEIVED_FILES_LABEL = 'Received files'; // DN13, the list's name for screen readers
/** A file name in the list, in characters: the box is 422 px inside, less
 *  the size column, so about 50 of 14 px Geist; 44 leaves room for wide ones. */
const FILE_NAME_MAX = 44;
/** DN12: the files past the names Go lists (200), which Show in folder opens. */
export function moreFiles(n: number): string {
    return `+ ${n} more`;
}

export interface FileRow {
    /** The saved name as Windows writes paths, cut in the middle so the
     *  extension always shows (a spoofed name keeps its real ending). */
    name: string;
    /** The whole saved name, for the row's title. */
    full: string;
    /** The committed size, or '' when none came. */
    size: string;
}

/** fileRows lists every saved file Go names (up to 200), in the order they
 *  were saved, and how many more there are (D-172: the list scrolls). The names are the engine's
 *  display-safe saved names (controls and bidi marks already replaced), shown
 *  as text only; "/" between folders shows as "\". */
export function fileRows(r: {names: string[]; sizes?: number[]; saved: number}): {rows: FileRow[]; more: number} {
    const rows = r.names.map((n, i) => {
        const full = n.replace(/\//g, '\\');
        const s = r.sizes?.[i] ?? -1;
        return {name: shortPath(full, FILE_NAME_MAX), full, size: s >= 0 ? fmtBytes(s) : ''};
    });
    return {rows, more: Math.max(0, r.saved - rows.length)};
}

/** folderName is the exclusive subfolder's own name, for the DN6 row. */
export function folderName(path: string): string {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : path;
}

/** dropFolderShown is an accepted drop's absolute folder in the prompt's P3
 *  form, the save folder's own name and then the drop's ("Floe\Acme footage
 *  2026-09-14 1405"), or '' for none: Receiving's line for a drop that showed
 *  no prompt (D-173), and for a prompted one whose name took a " (2)". */
export function dropFolderShown(folder: string): string {
    const parts = folder.split(/[\\/]+/).filter(Boolean);
    return parts.length >= 2 ? `${parts[parts.length - 2]}\\${parts[parts.length - 1]}` : parts.join('');
}

export const ACCEPTED_AUTOMATICALLY_LINE = 'Accepted automatically'; // HA1 (D-173), History only, gray, from the drop's own mark

/** verifiedAll: the DN3 check shows only when every file's SHA-256 matched. */
export function verifiedAll(r: {files: number; saved: number; verified: number}): boolean {
    return r.files > 0 && r.saved === r.files && r.verified === r.files;
}

// ---- Stopped (ST2 is cut, E-24; ST13 has no source in Stage 1; ST15 is cut,
// D-136: Make another link sits right under the card) -----------------------
export const STOPPED_HEADING = 'DROP STOPPED'; // ST0
/** ST16, and the tail of every stop sentence that carries a count, after a
 *  " · " (D-123, D-136, D-167): "4 of 12 files saved", "1 of 1 file saved",
 *  and "Nothing saved" when none was, whatever the drop offered (0 of 0 and
 *  0 of 1 included). */
export function savedOf(saved: number, files: number): string {
    if (saved <= 0) return 'Nothing saved';
    return files === 1 ? `${saved} of 1 file saved` : `${saved} of ${files} files saved`;
}

// One entry per stop code: the card body under DROP STOPPED, and the full
// sentence the History row keeps (DH-02). `count` says whether the sentence
// carries its own count (ST1, ST10 to ST12), takes ST16 on the card (ST3 to
// ST5, ST7, ST8), takes it only when a file was saved (ST9: its card sits
// above ST17, the kept file, so "Nothing saved" would contradict it), or
// has none (ST6, whose card says nothing was saved).
const STOPS: Record<string, {card: string; full: string; count: 'own' | 'append' | 'kept' | 'none'}> = {
    'disk-full': {card: 'The drive ran out of space', full: 'Drop stopped: the drive ran out of space', count: 'own'}, // ST1
    'hash-mismatch': {card: "A file didn't match what was sent and was deleted", full: "Drop stopped: a file didn't match what was sent and was deleted", count: 'append'}, // ST3
    'path-too-long': {card: 'A folder path was too long for Windows', full: 'Drop stopped: a folder path was too long for Windows', count: 'append'}, // ST4
    'over-approved': {card: 'More data arrived than you accepted', full: 'Drop stopped: more data arrived than you accepted', count: 'append'}, // ST5
    'relay-cap': {card: 'Over the 2 GB relay limit · Nothing saved', full: 'Drop stopped before any file: over the 2 GB relay limit', count: 'none'}, // ST6
    'file-too-large-for-folder': {card: 'A file is too large for this drive', full: 'Drop stopped: a file is too large for this drive', count: 'append'}, // ST7
    'write-failed': {card: "Windows couldn't write to the folder", full: "Drop stopped: Windows couldn't write to the folder", count: 'append'}, // ST8
    'save-blocked': {card: 'Windows blocked Floe from saving a file', full: 'Drop stopped: Windows blocked a save', count: 'kept'}, // ST9
    stopped: {card: 'You stopped this drop', full: 'You stopped this drop', count: 'own'}, // ST10
    'peer-abort': {card: 'The sender stopped this drop', full: 'Drop stopped: the sender left', count: 'own'}, // ST11
    'time-limit': {card: 'The drop reached the 24-hour limit', full: 'Drop stopped: it reached the 24-hour limit', count: 'own'}, // ST12
};

/** stoppedCard is the body under DROP STOPPED. An unknown code, and every
 *  host-side stop that no peer frame explains, is ST14: the count alone,
 *  blaming nobody (E-42). Only peer-abort names the sender. */
export function stoppedCard(code: string, saved: number, files: number): string {
    if (!has(STOPS, code)) return savedOf(saved, files); // ST14
    const s = STOPS[code];
    return s.count === 'none' || (s.count === 'kept' && saved <= 0) ? s.card : `${s.card} · ${savedOf(saved, files)}`;
}

/** stoppedFull is the History form of the same stop (DH-02): the row's own
 *  sentence, which carries a count only when the approved row does. */
export function stoppedFull(code: string, saved: number, files: number): string {
    if (!has(STOPS, code)) return `Drop stopped · ${savedOf(saved, files)}`; // ST14
    const s = STOPS[code];
    if (s.count !== 'own') return s.full;
    if (code === 'peer-abort') return `${s.full} · ${saved} of ${files} ${files === 1 ? 'file' : 'files'} arrived`; // ST11
    return `${s.full} · ${savedOf(saved, files)}`;
}

/** stoppedShowsFolder: Show in folder appears when at least one file was
 *  saved (DT-05 draws it for no relay-cap stop), and for save-blocked even with
 *  none saved (D-128, the one exception to DT-05): the engine keeps the file it
 *  could not move into place, complete and verified, as a .part in the drop
 *  folder (E-36), and keptPartLine says so. */
export function stoppedShowsFolder(code: string, saved: number): boolean {
    return code !== 'relay-cap' && (saved > 0 || code === 'save-blocked');
}

/** ST17 (D-136), RX10's second sentence with "save folder" as "folder": the
 *  drop keeps the file in its own subfolder, which Show in folder opens. The
 *  code receive keeps RX10 whole (COMMIT_KEPT_PART in errors.ts). */
export const SAVE_BLOCKED_KEPT_LINE = 'The complete file was kept with a .part ending';

/** keptPartLine is the line a stopped drop adds, on the card and in History,
 *  when the engine kept a verified .part in the drop folder: save-blocked
 *  only (D-128). It names no file, and every other code gets none. */
export function keptPartLine(code: string): string {
    return code === 'save-blocked' ? SAVE_BLOCKED_KEPT_LINE : '';
}

// ---- Dialogs, header, notice, announcements --------------------------------
export const CLOSE_LINK_OPEN_LINE = 'Your request link stops working'; // CL2
// CL3, one pair for every Close Floe? case (D-170; it was Keep Floe open and
// Close Floe with a link open, Keep going and Close anyway with a transfer).
// Not "Cancel": beside a running transfer it reads as cancel the transfer.
export const KEEP_FLOE_OPEN = 'Keep open';
export const CLOSE_FLOE = 'Close';
export const CLOSE_DROP_RECEIVING_LINE = 'Closing now stops the transfer before the files finish'; // CL4
export const CLOSE_LINK_ALSO_LINE = 'Your request link also stops working'; // CL5, its own line under the transfer sentence
export const START_OVER_LINK_LINE = 'Your request link stays open'; // SO1
// H2: the Receive tab's screen-reader description while a link is open. The
// header has no marker for an open link (H1 is cut) and the status chip has no
// relay tooltip for a drop (V8 and H3 are cut).
export const LINK_OPEN_DESCRIPTION = 'Request link is open'; // H2
// H4: the status chip's word while a link made with Auto-accept on is open
// and nothing moves (D-173); moving words win, as always.
export const AUTO_ACCEPT_CHIP = 'Auto-accept'; // H4, rendered in uppercase
export const NOTICE_TEXT = 'Someone wants to send you files'; // N1
export const NOTICE_REVIEW = 'Review'; // N2
export const ANNOUNCE_REQUEST = 'Request link: someone wants to send you files.'; // A1, screen reader only: keeps its period (D-167)
export const ANNOUNCE_GUARD_LIFTED = 'Accept and Decline are ready.'; // A2, screen reader only: keeps its period (D-167)
