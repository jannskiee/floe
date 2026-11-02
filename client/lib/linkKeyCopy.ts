// What the main page says when the link-key check stops a transfer. Fixed words only,
// chosen by the enum the check reports, so a peer's text has no path onto the page. The
// owner approved them in the plan (New copy), and linkKeyCopy.test.ts quotes each.
//
// Pure and outside P2PTransfer.tsx for the same reason senderStop.ts is: nothing in the
// suite mounts the component.

import type { KeyOutcome } from './transfer/keySession';

/** This page's own check of the person who opened its link failed. */
export const KEY_FAILED_SENDER =
    "Floe couldn't confirm the person who opened your link, so nothing was sent. Make a new link and send it again.";

/** The receiver holds the key and refused this page's proof. */
export const KEY_REFUSED_SENDER =
    "The other side couldn't confirm this link, so nothing was sent. Make a new link and send it again.";

/** This browser could not read the connection's certificates, so it had no proof to give. */
export const KEY_UNAVAILABLE_SENDER =
    "This browser can't check this link, so nothing was sent. Open Floe in a current version of Chrome, Edge, Firefox or Safari.";

/** The cutover's: no proof within the wait, which can also be a peer too old to send
 *  one. Reachable only once ENFORCE_SHARE_LINK_KEY is on. */
export const KEY_SILENT_SENDER =
    "Floe couldn't confirm the other side. They may need to update Floe or keep the page open.";

/** This page holds the key and the sender could not prove it does. */
export const KEY_FAILED_RECEIVER =
    "Floe couldn't confirm who sent this link, so nothing was received. Ask them for a new link.";

/** This browser could not read the connection's certificates. Never claims the other
 *  side failed (D7). */
export const KEY_UNAVAILABLE_RECEIVER =
    "This browser can't check this link, so nothing was received. Open it in a current version of Chrome, Edge, Firefox or Safari.";

/** The sending page's sentence for what stopped its send. */
export function senderKeyLine(outcome: KeyOutcome): string {
    switch (outcome) {
        case 'unavailable':
            return KEY_UNAVAILABLE_SENDER;
        case 'silent':
            return KEY_SILENT_SENDER;
        case 'peer-refused':
            return KEY_REFUSED_SENDER;
        case 'bad-tag':
        case 'malformed':
        case 'missing':
            return KEY_FAILED_SENDER;
    }
}

/** The receiving page's sentence. A check that failed and a sender that refused this
 *  side read the same to a person: nothing arrived, and a new link is the way on. */
export function receiverKeyLine(unavailable: boolean): string {
    return unavailable ? KEY_UNAVAILABLE_RECEIVER : KEY_FAILED_RECEIVER;
}
