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

export const REFUSAL_BANNER = 'Too many refreshes. Reconnecting';

/** The banner goes up, over anything but the Link Invalid card's value: with
 *  that written over, the page read "Access Denied" with nothing to say why. */
export function withRefusalBanner(current: string): string {
    return current.includes('Link Expired') ? current : REFUSAL_BANNER;
}

/** The banner comes down, and only the banner: a message about the link or
 *  the transfer that arrived meanwhile is still true once the socket is back. */
export function withoutRefusalBanner(current: string): string {
    return current === REFUSAL_BANNER ? '' : current;
}
