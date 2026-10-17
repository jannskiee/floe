/**
 * What a sender's file rows and progress row show, from how the send ended.
 *
 * Both used to read the status sentence: a row got its check, and the row
 * under the bar read "Sent 3 files", only while the status was exactly "All
 * Files Sent!". Three handlers rewrite that sentence after a finished send
 * (the other side left, this page's own socket dropped, the connection
 * errored), and the last file is by then the current one with its progress at
 * 100. So the moment the status became "Transfer complete" the last row went
 * back to a spinner and the label to "Sending file 3 of 3...", under a status
 * saying the transfer was complete. A `floe` receiver exits right after a
 * receive, so that followed every send to one.
 *
 * `end` is a latched fact about one send, set where the send engine reports
 * it, never the status sentence: the same split lib/receiveSummary.ts makes on
 * the receiving side.
 *
 *   open       nothing has ended: a send is waiting, running or between files
 *   delivered  every file left this browser (the engine's onAllSent)
 *   failed     the send stopped short, or the other side refused a file
 *
 * A late refusal turns `delivered` into `failed`, and nothing turns `failed`
 * back. A new recipient starts again from `open`.
 */
export type SendEnd = 'open' | 'delivered' | 'failed';

export type SendRowMark = 'sent' | 'sending' | 'none';

/** The mark at the right of one file row once the list is sealed. */
export function sendRowMark(input: {
    index: number;
    currentFileIndex: number;
    progress: number;
    end: SendEnd;
}): SendRowMark {
    const { index, currentFileIndex, progress, end } = input;
    if (end === 'delivered') return 'sent';
    // A row before the current one left this browser, whatever happened next.
    if (index < currentFileIndex) return 'sent';
    // Only an open send is still moving. After a failure the current row
    // keeps no spinner and earns no check: the page cannot know which file
    // the other side refused.
    if (end === 'open' && index === currentFileIndex && progress > 0) return 'sending';
    return 'none';
}

/**
 * Whether the status line over the share link says the send is over and
 * well: one of the page's own two sentences, compared whole. The line also
 * reads "Sending: <name>" with the sender's own file name in it, so asking
 * whether it CONTAINS the words gave a file called "Transfer complete.txt"
 * the green check while it was still being sent.
 */
export function shareStatusComplete(status: string): boolean {
    return status === 'All Files Sent!' || status === 'Transfer complete';
}

/**
 * Whether the status line names something that is over and did not end well.
 * Such a line carries no spinner: the spinner says the page is still working
 * on something, and beside "Transfer blocked. Relay limit exceeded." it said
 * so about a connection the page had just closed itself. Compared whole, for
 * the reason shareStatusComplete is: the line can hold a file name.
 *
 * Every ending status the sending page writes is here, and
 * sendSummary.test.ts reads the page to hold that true.
 */
export function shareStatusEnded(status: string): boolean {
    return (
        status === 'Link stopped working' ||
        status === 'Connection failed' ||
        status === 'Connection interrupted' ||
        status === 'Transfer failed' ||
        status === 'Transfer blocked. Relay limit exceeded.'
    );
}

/**
 * Whether the send counts as verified: the status line's check is the green
 * circle-check rather than the gray plain one, and "SHA-256 matched" is read
 * to screen readers under it.
 *
 * It is the receiver's report about a send this page delivered, so it follows
 * the latched end of the send and not the status sentence. Gated on the
 * sentence, the words (a visible line then) vanished when a finished send's
 * status became "Connection interrupted" (the other device dropped off the
 * network after every byte had left), while the rows above still read sent.
 * The check itself belongs to the status's own mark and goes with it there.
 *
 * `delivered` is this page's own engine saying every file left (onAllSent).
 * The report alone is not enough: a peer picks the moment it sends one, and a
 * peer that confirmed early would otherwise mark a send still in progress, or
 * a fresh link waiting for its next recipient.
 */
export function verifiedLineShown(input: { verifiedLine: string | null; end: SendEnd }): boolean {
    return input.verifiedLine !== null && input.end === 'delivered';
}

/** The words at the left of the sender's progress row. Empty after a failure:
 *  the banner above the row already says what happened. */
export function sendProgressLabel(input: { end: SendEnd; currentFileIndex: number; filesCount: number }): string {
    const { end, currentFileIndex, filesCount } = input;
    if (end === 'delivered') return `Sent ${filesCount} ${filesCount === 1 ? 'file' : 'files'}`;
    if (end === 'failed') return '';
    return `Sending file ${currentFileIndex + 1} of ${filesCount}...`;
}
