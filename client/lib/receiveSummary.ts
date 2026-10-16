import { receiveUnderWay } from './pageGuards';

/**
 * The count line under a receiver's file list, and whether it may carry the
 * green check.
 *
 * The check used to follow the list alone: one file in it and the page said
 * "1 file received" beside a check, whether the sender had announced one file
 * or three, and whether or not the connection was still there. A sender that
 * vanished during file 2 of 3 left a page that looked finished.
 *
 * `expected` is the count the sender announced in its metadata, 0 until then
 * and for a peer that announces none. `ended` is a latched fact (the peer
 * connection closed, or the receiver engine stopped on a failure), never the
 * status sentence: the signaling socket can drop and come back in the middle
 * of a healthy transfer, and that writes the status too.
 *
 * The waiting line says "the rest", not "the next file": it can be on screen
 * while the next file is already arriving. When this page's own signaling
 * socket drops mid-file the status is rewritten, so the line shows over a
 * progress row that is still moving.
 *
 * The two partial lines must not contain "N files received". The transfer
 * audit reads the page with an unanchored /(\d+) files? received/ and takes a
 * match as a complete receive of N files.
 */
export type ReceiveSummary =
    | { kind: 'none' }
    | { kind: 'complete'; text: string }
    | { kind: 'waiting'; text: string }
    | { kind: 'short'; text: string };

export function receiveSummary(input: {
    received: number;
    expected: number;
    ended: boolean;
}): ReceiveSummary {
    const { received, expected, ended } = input;
    if (received <= 0) return { kind: 'none' };
    if (expected <= 0 || received >= expected) {
        return {
            kind: 'complete',
            text: `${received} ${received === 1 ? 'file' : 'files'} received`,
        };
    }
    // Short of the announced count, so expected is at least 2: always "files".
    const sofar = `Received ${received} of ${expected} files.`;
    // Cause-neutral. A network that failed on this side ends here too, so the
    // line does not say who left.
    if (ended) return { kind: 'short', text: `${sofar} The transfer ended before the rest arrived.` };
    return { kind: 'waiting', text: `${sofar} Waiting for the rest` };
}

/**
 * Whether the receiving card draws its three joining steps ("Secure room
 * joined", "Waiting for the sender to start", "Files stream in below").
 *
 * They describe an attempt that is under way. `ended` is the same latched
 * fact receiveSummary reads. Without it, an attempt that ended with nothing
 * received set the connected flag false, and the first step drew its spinner
 * again under the red banner, as if the page were joining. Nothing was
 * retrying: the banner is the whole account, and the way on is a reload.
 *
 * `busy` is a file arriving or being checked, which has its own line at the
 * foot of the card.
 */
export function joinStepsShown(input: { received: number; busy: boolean; ended: boolean }): boolean {
    return input.received === 0 && !input.busy && !input.ended;
}

/**
 * Whether closing the receiving tab would cost the person something, which is
 * what "Keep this tab open and in front. Closing it interrupts the download." claims.
 *
 * Exactly when the browser's leave prompt is held on a receiving page
 * (mainPageHoldsTab in lib/pageGuards.ts): while a receive is under way, or
 * while a received file has never been handed to the browser to save. Not
 * under the Link Invalid card, not while nobody is on the sending side and
 * nothing is unsaved, and not once every file has arrived and each was saved:
 * the line used to stay for as long as any file was listed, after the prompt
 * had already let go.
 */
export function receiverTabMatters(input: {
    linkInvalid: boolean;
    senderAbsent: boolean;
    ended: boolean;
    allArrived: boolean;
    unsaved: number;
}): boolean {
    return receiveUnderWay(input) || input.unsaved > 0;
}

/**
 * Whether the two bulk buttons (Download All, Download ZIP) are on the card:
 * two or more files, and none arriving. The iOS tip names Download ZIP, so it
 * shows exactly when this is true. It used to show from the first file, for
 * a button a one-file transfer never has.
 */
export function bulkDownloadShown(input: { received: number; busy: boolean }): boolean {
    return input.received > 1 && !input.busy;
}
