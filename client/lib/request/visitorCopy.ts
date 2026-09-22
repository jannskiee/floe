// Every string the visitor page renders, in one place.
//
// The copy is frozen: it was approved at Checkpoint C (2026-09-18) and the ids
// below are that table's ids. Edit a string here only with a new approval.
//
// Three rules the table itself carries, restated because they are invariants of
// this module rather than of any one string: American English; no em dash and no
// en dash in any value; and the page never renders a peer-supplied string, so
// nothing here is a template for one. The templates below take numbers the page
// clamped itself, sizes through formatBytes, and the visitor's OWN relative
// paths; a refusal is chosen by an allowlisted code and never described in the
// peer's words.
//
// The Cancel confirmation (stopTitle to stop) is the one set that is not in the
// frozen file: D-096 chose the Q-C14 question's wording over the file's O10
// rows, and spec 07 4.15.1 records it as C-102 to C-105.

import type { VisitorModel } from './visitorState';
import { answerMinutesLeft, arrivedCount } from './visitorState';
import { formatBytes } from '../utils';
import { formatETA, formatSpeed } from '../transferUtils';

export const visitorCopy = {
    /** C-01: the Ready eyebrow, drawn as a mono line with the chip at its right.
     *  Written in capitals rather than lowercased and transformed, so the DOM
     *  carries the approved string and a screen reader is not handed a
     *  differently-cased one. */
    readyEyebrow: 'SEND FILES THROUGH THIS LINK',
    /** C-01: the chip beside the eyebrow. */
    betaChip: 'Beta',
    /** C-02: what this page is, and where the files go. */
    readyIntro:
        'This is a Floe request link. Files go to the computer of the person who made it, not to a Floe server. Floe does not know who made this link.',
    /** C-13: the Beta support line, shown while request links are in Beta. */
    betaSupport: 'During Beta, request links work in current Chrome and Edge on desktop.',

    /** C-20: V1, a link whose shape does not parse. Detected locally; no network
     *  call happens to produce it. */
    incompleteTitle: 'This link looks incomplete',
    /** C-21. */
    incompleteBody: 'Copy the whole link again, including everything after the # sign.',

    /** C-22: V2, no RTCPeerConnection or no data channel support. */
    unsupportedTitle: 'This browser cannot send through Floe',
    /** C-23. */
    unsupportedBody: 'Open the link in current Chrome or Edge.',

    /** C-30: V3a, this browser cannot pick folders. It is also the refusal for a
     *  dropped folder that arrived as a directory pseudo-File, because from the
     *  visitor's side those are the same problem with the same remedy. */
    foldersUnsupported: 'This browser cannot pick folders. Drag the folder in, or zip it first.',
    /** C-34, the over-10,000-files half. */
    tooManyFiles: 'This drop has more than 10,000 files. Zip them first.',
    /** C-34, the path-over-the-cap half. Its second sentence is C-33, which is
     *  drawn only as this tail and never on its own. */
    pathTooLong: 'A folder path is too long to send. Zip deeply nested folders first.',
    /** C-35: a quiet line under the count, not a refusal. Empty folders, and the
     *  modification times, are not delivered. */
    emptyFoldersSkipped: 'Empty folders are not sent.',
    /** C-36: the walk hit an entry it could not read, so nothing was added. */
    folderUnreadable: 'Some files in this folder could not be read. Nothing was added.',

    // ---- Ready controls (V3) ----
    /** C-03: a text link under the intro, to the request-link docs page. */
    whatIsRequestLink: 'What is a request link?',
    /** C-04: the dropzone's line; hidden on coarse pointers. */
    dropHere: 'Drop files or folders here',
    /** C-05. */
    chooseFiles: 'Choose files',
    /** C-06: hidden where folder picking is missing or known broken. */
    chooseFolder: 'Choose folder',
    /** C-08: the Hide my IP checkbox label. */
    hideIp: 'Hide my IP (relay only, 2 GB per drop)',
    /** C-10: empties the whole selection. */
    clear: 'Clear',
    /** C-11: always visible in Ready, under Send. */
    ipNotice:
        'When you connect, the person who made this link can see your IP address unless you turn on Hide my IP.',
    /** APP-1: the dropzone while files are dragged over it. */
    releaseToAdd: 'Release to add files',
    /** APP-2: the compact strip after the first pick. */
    addMoreFiles: 'Add more files',
    /** E45-1: above Send on a coarse-pointer device. A line, never a block. */
    coarsePointer: 'Keep this page open and your screen on.',
    /** C-53: V6b, shown under the switch back in Ready. */
    hideIpNeedsRelay:
        'Hide my IP needs a relay, and this Floe server has none right now. Turn off Hide my IP to send directly.',

    // ---- Server answers (V4, V5) ----
    /** C-40. */
    hostAbsentTitle: 'Their computer is not connected right now',
    /** C-41. */
    hostAbsentBody: 'The person who made this link may have closed Floe. Your files stay selected.',
    /** C-42. */
    tryAgain: 'Try again',
    /** C-43. */
    usedTitle: 'This link has already been used',
    /** C-44. */
    usedBody: 'Ask the person who made it for a new one.',
    /** C-45. */
    turnedOff: 'Request links are turned off right now',
    /** C-46: no answer to request-join at all (an older or self-hosted server). */
    notAvailable: 'Request links are not available on this Floe server.',

    // ---- Connecting and waiting (V6, V7) ----
    /** C-50. */
    connecting: 'Connecting to their computer',
    /** C-51: full width in V6, V7 and V10. */
    cancel: 'Cancel',
    /** C-52: V6a. */
    couldNotConnect: "Couldn't connect to their computer. Nothing was sent.",
    /** C-54: V6c, the per-IP connection limiter refused and the page retries. */
    limiterRetry: 'Too many connections from this network. Trying again shortly.',
    /** C-55: the route badge in V7 and V10. */
    badgeDirect: 'Direct',
    badgeRelay: 'Relay',
    /** C-60. */
    waitingTitle: 'Waiting for them to accept',
    /** C-61 after its first sentence; C-62 replaces that sentence in the last
     *  minute and this tail follows it. */
    answerTail: 'Nothing is saved until they accept. Keep this page open.',
    /** C-62. */
    lastMinute: 'They have less than 1 min to answer.',

    // ---- Declined, timed out, relay blocked (V8, V9) ----
    /** C-70, and the declined code's row. */
    declined: 'They declined. Nothing was sent.',
    /** C-71, the expired code's row, and the local first-ack timer. */
    timedOut: 'They did not answer in time. Nothing was sent.',
    /** C-72 and C-81. */
    backToFiles: 'Back to files',
    /** C-80: the main page's existing relay wording. */
    relayBlocked:
        'Transfer limit exceeded. Relay connections are capped at 2 GB. Remove files to proceed, or switch to a network that supports a direct connection.',
    /** APP-3: after C-80, to /how-it-works#size-limit. */
    learnMore: 'Learn more',

    // ---- Sending (V10) ----
    /** C-93: drawn in capitals by CSS; the DOM keeps the approved casing. */
    arrivedHeading: 'ARRIVED (saved on their computer)',
    /** C-94: always shown in V10. */
    keepInFront: 'Keep this tab in front until the last file arrives. For long drops, pin this tab.',
    /** C-102 to C-105: the inline confirmation Cancel opens after the first
     *  ack (D-091 Q-C14 option a, wording D-096). Before the first ack a
     *  Cancel loses nothing and asks nothing. */
    stopTitle: 'Stop sending?',
    stopBody: 'Files that already arrived stay on their computer. This link cannot be used again.',
    keepSending: 'Keep sending',
    stop: 'Stop',

    // ---- Endings (V11, V12, V13) ----
    /** C-100. */
    stoppedByYou: 'You stopped this drop.',
    /** C-101, and a version range miss. */
    needsUpdate: 'Their Floe needs an update to receive from this page.',
    /** C-110. */
    lostTitle: 'Connection lost',
    /** C-112: V12a. */
    lostBeforeAccept: 'Connection lost. Nothing was sent.',
    /** C-122: only when the host's verified count equals the file count. Never
     *  a hash value. */
    shaMatched: "Their app reports every file's SHA-256 matched.",
    /** 4.15.2's saved line at 0. */
    nothingSent: 'Nothing was sent.',
    /** 4.15.2: after the codes where sending the rest makes sense. */
    askForTheRest: 'Ask them for a new link to send the rest.',
    /** 4.15.2: relay-cap's second line when nothing was saved. */
    relayCapNothing: 'Nothing was sent. Send under 2 GB.',

    // ---- Screen reader lines (4.15.3) that are not a title ----
    /** SR-01. */
    srConnecting: 'Connecting to their computer.',
    /** SR-02. */
    srWaiting: 'Waiting for them to accept.',
} as const;

/** The refusal titles of 4.15.2, keyed by the twelve allowlisted codes. A Map,
 *  not an object: no peer string can reach a prototype key. declined and
 *  expired are the V8 sentences. */
const REFUSAL_TITLES: ReadonlyMap<string, string> = new Map([
    ['declined', visitorCopy.declined],
    ['expired', visitorCopy.timedOut],
    ['disk-full', 'Their computer ran out of space'],
    ['write-failed', 'Their computer could not save a file'],
    ['hash-mismatch', 'A file changed or was damaged on the way, so their Floe deleted it'],
    ['relay-cap', 'Relayed drops are capped at 2 GB'],
    ['path-too-long', 'A folder path is too long for their computer. Zip deeply nested folders first.'],
    ['file-too-large-for-folder', 'A file is too large for the drive they save to.'],
    ['save-blocked', 'A file arrived but their computer blocked saving it.'],
    [
        'over-approved',
        'More data arrived than they accepted. If files changed after you chose them, ask them for a new link.',
    ],
    ['stopped', 'They stopped this drop.'],
    ['time-limit', 'This drop reached the 24-hour limit, so their Floe stopped it.'],
]);

/** 4.15.2's unknown or missing code: anything the page does not know,
 *  including too-slow, which Stage 1 never sends (E-24). */
export const UNKNOWN_REFUSAL = 'The drop stopped on their computer.';

/** Clamp a count to [0, total]; anything that is not an integer is 0. */
export function clampCount(n: unknown, total: number): number {
    return typeof n === 'number' && Number.isInteger(n) ? Math.min(Math.max(n, 0), Math.max(0, total)) : 0;
}

function savedLine(saved: number, total: number): string {
    return saved === 0 ? visitorCopy.nothingSent : `${saved} of ${total} files were saved.`;
}

export interface RefusalCopy {
    title: string;
    lines: string[];
    /** Whether the ARRIVED list follows the lines. */
    showArrived: boolean;
}

/** The card for a refusal code. `refusal` is typed loosely on purpose: the
 *  lookup is the allowlist, so a raw or hostile value lands on the unknown
 *  row, and `saved` is clamped here whatever the caller did. */
export function refusalCopy(refusal: unknown, saved: unknown, total: number): RefusalCopy {
    const code = typeof refusal === 'string' && REFUSAL_TITLES.has(refusal) ? refusal : null;
    const title = code === null ? UNKNOWN_REFUSAL : (REFUSAL_TITLES.get(code) as string);
    if (code === 'declined' || code === 'expired') return { title, lines: [], showArrived: false };
    const count = clampCount(saved, total);
    const lines =
        code === 'relay-cap' && count === 0 ? [visitorCopy.relayCapNothing] : [savedLine(count, total)];
    if (code === 'hash-mismatch') lines.push(visitorCopy.askForTheRest);
    return { title, lines, showArrived: count > 0 };
}

/** C-07. */
export function countLine(count: number, size: number): string {
    return count === 1 ? `1 FILE, ${formatBytes(size)}` : `${count} FILES, ${formatBytes(size)}`;
}

/** C-09. */
export function sendLabel(count: number): string {
    return count === 1 ? 'Send 1 file' : `Send ${count} files`;
}

/** C-31: V3b. */
export function relayCapNotice(size: number): string {
    return `This drop is ${formatBytes(size)}, so it cannot go through the relay. Turn off Hide my IP, or send under 2 GB.`;
}

/** C-61, or C-62 in the last minute. Never "0 min". */
export function countdownLine(minutesLeft: number): string {
    const first = minutesLeft >= 1 ? `They have ${Math.floor(minutesLeft)} min to answer.` : visitorCopy.lastMinute;
    return `${first} ${visitorCopy.answerTail}`;
}

/** C-90. */
export function sendingHeader(index: number, total: number): string {
    return `SENDING ${index} OF ${total}`;
}

/** C-92, as the parts the page lays out side by side: sent of size, then the
 *  speed and the time left when they are known. */
export function progressParts(sent: number, ofSize: number, bytesPerSec: number, etaSeconds: number): string[] {
    const parts = [`${formatBytes(sent)} of ${formatBytes(ofSize)}`];
    const speed = formatSpeed(bytesPerSec);
    if (speed) parts.push(speed);
    const eta = formatETA(etaSeconds);
    if (eta) parts.push(`${eta} left`);
    return parts;
}

/** C-91: the visitor's own relative path, shortened in the middle so both the
 *  folder it starts in and the file name it ends with stay readable. */
export function displayPath(path: string, max = 56): string {
    const chars = Array.from(path);
    if (chars.length <= max) return path;
    const room = Math.max(2, max - 3);
    const head = Math.ceil(room / 2);
    const tail = Math.floor(room / 2);
    return `${chars.slice(0, head).join('')}...${chars.slice(chars.length - tail).join('')}`;
}

/** C-111. The flow form ("to send the rest.") when nothing is left or the
 *  count is unknown. */
function lostLine(arrived: number, total: number): string {
    const left = total - arrived;
    return left > 0
        ? `${arrived} of ${total} files arrived. Ask them for a new link to send the other ${left}.`
        : `${arrived} of ${total} files arrived. ${visitorCopy.askForTheRest}`;
}

/** C-130, with the visitor's own path. */
function unreadableTitle(path: string): string {
    return `Could not read "${path}". It may have been moved, renamed, or on a drive or folder that is no longer available. Nothing further was sent.`;
}

export interface StatusContext {
    /** The visitor's own relative path of file `index` (1-based) in this
     *  attempt's selection. */
    pathAt: (index: number) => string | undefined;
    /** The route badge's reading, when it has one. */
    route: 'direct' | 'relay' | null;
    now: number;
}

export interface StatusCopy {
    /** The dot before the title: a hollow ring for an ending or a block, a
     *  solid dot while connecting or waiting, green once delivered. */
    marker: 'ended' | 'active' | 'done';
    title: string;
    lines: string[];
    action: 'try-again' | 'back-to-files' | 'cancel' | null;
    showArrived: boolean;
    /** V9: the Learn more link after the title. */
    learnMore: boolean;
    /** V7 and V10 show the route badge. */
    badge: boolean;
}

function card(
    marker: StatusCopy['marker'],
    title: string,
    lines: string[] = [],
    action: StatusCopy['action'] = null,
    extra: Partial<StatusCopy> = {}
): StatusCopy {
    return { marker, title, lines, action, showArrived: false, learnMore: false, badge: false, ...extra };
}

/** The status card for every state that is not the Ready view (V3, V3c, V6b,
 *  V6d render Ready) and not the Sending view (V10); null for those. V1 and V2
 *  keep their own card. */
export function statusCopy(model: VisitorModel, ctx: StatusContext): StatusCopy | null {
    const total = model.total;
    const arrived = arrivedCount(model);
    switch (model.state) {
        case 'V4':
            return card('ended', visitorCopy.hostAbsentTitle, [visitorCopy.hostAbsentBody], 'try-again');
        case 'V5a':
            return card('ended', visitorCopy.usedTitle, [visitorCopy.usedBody]);
        case 'V5b':
            return card('ended', visitorCopy.turnedOff);
        case 'V5c':
            return card('ended', visitorCopy.notAvailable);
        case 'V6':
            return card('active', visitorCopy.connecting, [], 'cancel');
        case 'V6c':
            return card('active', visitorCopy.connecting, [visitorCopy.limiterRetry], 'cancel');
        case 'V6a':
            return card('ended', visitorCopy.couldNotConnect, [], 'try-again');
        case 'V7': {
            const elapsed = model.firstMetadataAt === null ? 0 : ctx.now - model.firstMetadataAt;
            return card('active', visitorCopy.waitingTitle, [countdownLine(answerMinutesLeft(elapsed))], 'cancel', {
                badge: true,
            });
        }
        case 'V8a':
            return card('ended', visitorCopy.declined, [], 'back-to-files');
        case 'V8b':
            return card('ended', visitorCopy.timedOut, [], 'back-to-files');
        case 'V9':
            return card('ended', visitorCopy.relayBlocked, [], 'back-to-files', { learnMore: true });
        case 'V11': {
            const r = refusalCopy(model.stop?.refusal ?? null, model.stop?.savedCount ?? 0, total);
            return card('ended', r.title, r.lines, null, { showArrived: r.showArrived });
        }
        case 'V11a':
            return card('ended', visitorCopy.stoppedByYou, [savedLine(arrived, total)], null, {
                showArrived: arrived > 0,
            });
        case 'V11b':
            return card('ended', visitorCopy.needsUpdate);
        case 'V12': {
            const path = model.lost === 'unreadable' ? ctx.pathAt(model.unreadableIndex) : undefined;
            const title = path !== undefined ? unreadableTitle(path) : visitorCopy.lostTitle;
            return card('ended', title, [lostLine(arrived, total)], null, { showArrived: arrived > 0 });
        }
        case 'V12a':
            return card('ended', visitorCopy.lostBeforeAccept, [], 'try-again');
        case 'V13': {
            const seconds =
                model.acceptedAt !== null && model.deliveredAt !== null
                    ? Math.max(0, (model.deliveredAt - model.acceptedAt) / 1000)
                    : 0;
            const route = ctx.route ?? model.route ?? 'direct';
            let line = `${formatBytes(model.size)} in ${formatETA(seconds)}, ${route}.`;
            const v = model.verifiedCount;
            if (typeof v === 'number' && Number.isInteger(v) && total > 0 && v === total) {
                line += ` ${visitorCopy.shaMatched}`;
            }
            return card('done', `ALL ${total} FILES ARRIVED`, [line]);
        }
        default:
            return null;
    }
}

/** The sentence for the persistent role="status" span on entering a state
 *  (4.15.3), or '' where the table has none. The countdown and the ARRIVED
 *  list stay out of it. */
export function announcement(model: VisitorModel, ctx: StatusContext): string {
    switch (model.state) {
        case 'V6':
        case 'V6c':
            return visitorCopy.srConnecting;
        case 'V7':
            return visitorCopy.srWaiting;
        case 'V10':
            return `They accepted. Sending ${model.total} files.`;
        case 'V13':
            return `All ${model.total} files arrived.`;
        case 'V12':
            return `Connection lost. ${arrivedCount(model)} of ${model.total} files arrived.`;
        case 'V4':
        case 'V5a':
        case 'V5b':
        case 'V5c':
        case 'V6a':
        case 'V8a':
        case 'V8b':
        case 'V9':
        case 'V11':
        case 'V11a':
        case 'V11b':
        case 'V12a':
            return statusCopy(model, ctx)?.title ?? '';
        default:
            return '';
    }
}
