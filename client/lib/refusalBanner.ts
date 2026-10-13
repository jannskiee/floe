// The banner a page shows while the signaling server is refusing its
// connection (the per-address connection limiter's "Rate limit exceeded"), and
// the two ways the banner state may change because of it.
//
// It used to be set with a plain setError and cleared only by the Manager's
// 'reconnect' event. A refused socket is retried by hand (useSignaling), and
// that retry ends in a plain 'connect', so a page that had reconnected went on
// saying it was reconnecting until someone closed the banner.
//
// Both functions are state updaters: they take the banner as it is and return
// what it should be. That is what keeps them narrow. The banner state is
// shared with every other message the page shows, and one value in it is not
// a banner at all: "Link Expired or Busy" is what the Link Invalid card is
// drawn from.
//
// That value is matched whole, here and in the component. Every site used to
// ask whether the state contained the words "Link Expired", and the banner
// state also holds other peers' words: a refusal reason is the whole banner
// (lib/transfer/receiver.ts, compatErrorFromIncompatible), and a version
// string or a file name sits inside one. A peer could therefore switch the
// page to the card on a link that was good. isLinkInvalid is the one test,
// and peerBanner keeps a peer's message from ever being the value itself.

export const REFUSAL_BANNER = 'Too many refreshes. Reconnecting';

/** What the banner state holds while the Link Invalid card is up. */
export const LINK_INVALID = 'Link Expired or Busy';

/** Whether the banner state is the Link Invalid card's value: the whole
 *  string, never a part of one. */
export function isLinkInvalid(current: string): boolean {
    return current === LINK_INVALID;
}

/** A message whose words the other peer chose, on its way into the banner
 *  state. It is shown as it is, unless it is exactly the card's value: then
 *  the caller's own sentence for "they stopped, with no reason" stands in. */
export function peerBanner(text: string, fallback: string): string {
    return isLinkInvalid(text) ? fallback : text;
}

/** The banner goes up, over anything but the Link Invalid card's value: with
 *  that written over, the page read "Access Denied" with nothing to say why. */
export function withRefusalBanner(current: string): string {
    return isLinkInvalid(current) ? current : REFUSAL_BANNER;
}

/** The banner comes down, and only the banner: a message about the link or
 *  the transfer that arrived meanwhile is still true once the socket is back. */
export function withoutRefusalBanner(current: string): string {
    return current === REFUSAL_BANNER ? '' : current;
}

/** What a reconnect leaves of the banner state. It clears it, as it always
 *  has: a new socket is a new attempt, and a message about the last one must
 *  not sit over it. The exception is the Link Invalid card's value on a page
 *  with no room to go back to (an incomplete link never joins one). Nothing
 *  is coming to replace that card, and with it cleared the page read "Secure
 *  room joined" over a room it was never in. A receiver that does hold a room
 *  is about to join it again, so its card goes, as before. */
export function afterReconnect(current: string, rejoining: boolean): string {
    return isLinkInvalid(current) && !rejoining ? current : '';
}
