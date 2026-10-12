// When a sender page retries the join its own room refused.
//
// A sender whose signaling socket died without a goodbye comes back under a
// new socket while the server still counts the old one as seated: the old
// socket holds its seat until the server's heartbeat gives up on it, up to
// about 45 s (socket.io's default pingInterval 25 s plus pingTimeout 20 s). If
// a receiver took the other seat meanwhile, the room is full and the sender's
// re-join is answered room-full. The sender page listened for no such answer,
// so it kept showing its link over a room it was no longer in, and the receiver
// waited for an offer nobody would make.
//
// These delays outlast that window and then stop, so a room that is really
// taken (two other peers, or a link locked to other networks) ends in a
// message instead of a retry that never finishes.
//
// A retry is only ever a response to room-full. A join from a socket that is
// already seated leaves first and takes the next free seat, which would move a
// seated sender behind its own receiver, so the caller clears a pending retry
// the moment the server seats it.

export const REJOIN_DELAYS_MS = [2000, 4000, 8000, 15000, 15000, 15000] as const;

/** Delay before retry number `attempt` (0 for the first), or null to give up. */
export function rejoinDelay(attempt: number): number | null {
    if (!Number.isInteger(attempt) || attempt < 0 || attempt >= REJOIN_DELAYS_MS.length) return null;
    return REJOIN_DELAYS_MS[attempt];
}

/** The sender's status while a refused join is being retried, and after the last retry. */
export const REJOINING_STATUS = 'Reconnecting to your link';
export const REJOIN_FAILED_STATUS = 'Link stopped working';

/**
 * Whether a refused join may be retried, or answered on screen at all.
 *
 * The refused join goes out while the two devices are still connecting, and
 * that connection can come up by itself afterwards: the offer and answer were
 * already exchanged. From then on the room does not matter. A retry would write
 * the retry status over 'All Files Sent!', and the give-up banner would tell
 * someone to reload in the middle of a transfer that works.
 */
export function rejoinAllowed(inputs: { peerConnected: boolean; transferComplete: boolean }): boolean {
    return !inputs.peerConnected && !inputs.transferComplete;
}

/**
 * The status once the server has seated the page.
 *
 * Decided from what the status says, not from a retry counter: a second
 * reconnect can seat the page with no retry in between, after the reconnect
 * handler has reset the counter, and the page then kept saying it was
 * reconnecting, or that its link had stopped working, over a link that worked.
 */
export function statusOnceSeated(status: string): string {
    return status === REJOINING_STATUS || status === REJOIN_FAILED_STATUS ? 'Waiting for peer' : status;
}
