// Reading a request link out of the URL.
//
// A request link is `/r/<linkId>#<roomId>`. The two halves do different jobs and
// travel differently:
//
//   linkId  11 base64url characters in the PATH. Not a secret. It makes each
//           link a distinct document, and it is the granularity a URL blocklist
//           can act on. The signaling server never sees it.
//   roomId  a UUID in the FRAGMENT, and only there. It is the capability: whoever
//           holds it can take the visitor seat. Fragments are never sent in a
//           request line, never in a Referer, and are ignored by pageview
//           analytics, which is the whole reason it lives there.
//
// Pure by construction, like lib/roomLink.ts: both halves are passed in, because
// client/vitest.config.ts runs with environment: 'node' and a module that read
// window here could not be tested at all.

import { isValidRoomId } from '../roomLink';

/** The link id alphabet and length. 8 random bytes in unpadded base64url are
 *  exactly 11 characters, which is what the desktop app generates. Anchored, so
 *  a longer string is a rejection rather than a prefix match. */
export const LINK_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export interface ParsedRequestLink {
    linkId: string;
    roomId: string;
}

export interface IncompleteRequestLink {
    error: 'incomplete';
}

/** The link id out of a `/r/<linkId>` pathname, or null.
 *
 *  Split out from parseRequestLink because the report link (S1-WEB-04) needs the
 *  id on a page whose fragment may already be gone, and because a caller that
 *  only wants the id should not have to hold a room secret to get it.
 *
 *  One optional trailing slash is accepted; a second path segment is not, so
 *  /r/<id>/anything is not a link. The /r prefix is matched case-sensitively
 *  because Next matches route segments that way: /R/<id> never reaches this
 *  page, and treating it as a link here would only invent a shape the router
 *  cannot serve. scrubUrl and loadsUmami are deliberately case-INSENSITIVE,
 *  because they run over strings that reached them from somewhere else. */
export function linkIdFromPath(pathname: string): string | null {
    const match = /^\/r\/([^/]+)\/?$/.exec(pathname);
    if (!match) return null;
    return LINK_ID_RE.test(match[1]) ? match[1] : null;
}

/** Parse `location.pathname` and `location.hash` into a link, or report that the
 *  link is incomplete.
 *
 *  Every rejection is the same `incomplete` outcome on purpose. The page's V1
 *  copy tells the visitor to copy the whole link again, which is the remedy for
 *  every shape failure here, and a finer-grained error would only describe the
 *  URL back to whoever sent it.
 *
 *  The fragment must be a BARE uuid. The `#room=<uuid>` form that today's share
 *  links use is rejected: it is a different link shape for a different page, and
 *  accepting it here would let a share link masquerade as a request link. */
export function parseRequestLink(
    pathname: string,
    hash: string
): ParsedRequestLink | IncompleteRequestLink {
    const linkId = linkIdFromPath(pathname);
    if (!linkId) return { error: 'incomplete' };

    const roomId = hash.startsWith('#') ? hash.slice(1) : hash;
    if (!isValidRoomId(roomId)) return { error: 'incomplete' };

    return { linkId, roomId };
}
