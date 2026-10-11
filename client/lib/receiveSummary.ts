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
    return { kind: 'waiting', text: `${sofar} Waiting for the next file` };
}
