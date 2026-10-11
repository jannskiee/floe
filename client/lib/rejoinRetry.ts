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
