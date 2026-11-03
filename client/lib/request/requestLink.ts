// Reading a request link out of the URL.
//
// A request link is `/r/<linkId>#<roomId>`, or `/r/<linkId>#<roomId>.<k>` once its
// host makes keyed links. The parts do different jobs and travel differently:
//
//   linkId  11 base64url characters in the PATH. Not a secret. It makes each
//           link a distinct document, and it is the granularity a URL blocklist
//           can act on. The signaling server never sees it.
//   roomId  a UUID in the FRAGMENT, and only there. It is the capability: whoever
//           holds it can take the visitor seat. Fragments are never sent in a
//           request line, never in a Referer, and are ignored by pageview
//           analytics, which is the whole reason it lives there.
//   k       the link key, behind the room id's one dot. No server ever sees it. The
//           visitor proves it to the host and checks the host's proof before it names
//           a file (lib/transfer/keySession.ts). A link with no k is a bare link, which
//           every released Floe Desktop makes: no key, no wait, as it always was.
//
// Pure by construction, like lib/roomLink.ts: both halves are passed in, because
// client/vitest.config.ts runs with environment: 'node' and a module that read
// window here could not be tested at all.

import { namesDamagedKey, parseLinkKey, type LinkKey } from '../linkKey';
import { isValidRoomId } from '../roomLink';

/** The link id alphabet and length. 8 random bytes in unpadded base64url are
 *  exactly 11 characters, which is what the desktop app generates. Anchored, so
 *  a longer string is a rejection rather than a prefix match. */
export const LINK_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export interface ParsedRequestLink {
    linkId: string;
    roomId: string;
    /** Null on a bare link. A caller has to read this field to drop it, which is the point:
     *  a parser that handed back the old shape would be a silent downgrade. */
    key: LinkKey | null;
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

/** Parse `location.pathname`, `location.hash` and `location.search` into a link, or
 *  report that the link is incomplete.
 *
 *  Every rejection is the same `incomplete` outcome on purpose. The page's V1
 *  copy tells the visitor to copy the whole link again, which is the remedy for
 *  every shape failure here, and a finer-grained error would only describe the
 *  URL back to whoever sent it.
 *
 *  The fragment is a uuid, or a uuid, one dot and one canonical key. The
 *  `#room=<uuid>` form that today's share links use is rejected: it is a different
 *  link shape for a different page, and accepting it here would let a share link
 *  masquerade as a request link.
 *
 *  Anything that names a key and does not give a whole one is incomplete, never a bare
 *  link into the same room, because a caller that dropped the key and joined would be a
 *  downgrade: a key cut short, a second dot, and a k in the query, which cannot be read
 *  and must not leave the fragment beside it passing as bare (namesDamagedKey). Read
 *  from the raw hash: neither the room's shape nor the key's has room for a %, so a
 *  keyed fragment holding one is incomplete here as it is in ParseRequestLink,
 *  cli/engine/code, which reads the decoded one and refuses the escape by name.
 *  cli/engine/code/testdata/link-shapes.json holds the two parsers together. */
export function parseRequestLink(
    pathname: string,
    hash: string,
    search: string
): ParsedRequestLink | IncompleteRequestLink {
    const linkId = linkIdFromPath(pathname);
    if (!linkId) return { error: 'incomplete' };
    if (namesDamagedKey(new URLSearchParams(search))) return { error: 'incomplete' };

    const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
    const dot = fragment.indexOf('.');
    const roomId = dot < 0 ? fragment : fragment.slice(0, dot);
    if (!isValidRoomId(roomId)) return { error: 'incomplete' };
    if (dot < 0) return { linkId, roomId, key: null };

    const key = parseLinkKey(fragment.slice(dot + 1));
    if (!key) return { error: 'incomplete' };
    return { linkId, roomId, key };
}
