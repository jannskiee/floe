// Numbers the visitor page checks a pick against.
//
// Both of these are courtesies. The host is authoritative for every limit that
// depends on the receiving machine (depth 32, the 240 UTF-16 unit full path,
// FAT32's 4 GiB file size, free space plus its reserve), because the page cannot
// know the Save-to folder the path will be joined onto. What the page CAN know
// exactly is the wire: a metadata frame either fits in the control-frame cap or
// it does not, and a count either exceeds the per-drop limit or it does not.
// Catching those two here turns a mid-transfer refusal into a pick that simply
// does not start.

import { REQUEST_ACK_TIMEOUT_MS, REQUEST_ACK_GRACE_MS } from '../transfer/protocol';

/** Files per drop. Over this the pick is refused and Send stays off. */
export const MAX_REQUEST_FILES = 10_000;

/**
 * The id used when measuring a metadata frame, not when sending one.
 *
 * `sendFiles` gives every file a fresh uuid, so the id's LENGTH is fixed at 36
 * characters and its content is irrelevant to the byte count. Measuring with a
 * real-shaped uuid rather than a short placeholder is what makes the measurement
 * worst case: a frame that fits here fits on the wire, whatever uuid it draws.
 */
export const CONTROL_FRAME_WORST_CASE_ID = '00000000-0000-4000-8000-000000000000';

/**
 * The release string used when measuring a metadata frame, not when sending one.
 *
 * The browser sender omits `ver` today, so the frame it sends is currently
 * shorter than the one measured here. That is the point. `ver` is a live field
 * on the metadata message (the type is not named here on purpose: check-consumers
 * scans every file for the wire field names), CLAUDE.md's protocol section
 * describes it as riding there, and S1-WEB-07 is a card on this same branch
 * whose job is to change that very call. The day a release string starts
 * travelling, a frame measured at exactly the cap would be accepted at pick time
 * and refused mid-transfer, which is the one failure this module exists to
 * prevent. Reserving the room now means the measurement can only ever be an
 * upper bound.
 *
 * The value is a width, not a version. It is the widest shape this project
 * actually ships: the desktop tag form (`desktop-v0.2.12` today, and
 * `cli/engine/transfer/format.go` records the family as "v1.2.3",
 * "desktop-v0.1.2", "dev"), widened to two-digit components and a prerelease
 * suffix. 25 characters, which costs 34 bytes of the 1000-byte frame once the
 * key and the JSON punctuation are counted. That is about four percent of the
 * path budget, on a page whose paths are bounded far more tightly by the host's
 * 240 UTF-16 unit full-path rule, so the headroom is free in practice and the
 * asymmetry decides it: reserving too much refuses a pick the wire would have
 * taken, reserving too little accepts one the wire will drop after the visitor
 * has waited for an accept.
 */
export const CONTROL_FRAME_WORST_CASE_VER = 'desktop-v99.99.99-beta.99';

// ---------------------------------------------------------------------------
// Connection timing and fixed wire text for the visitor (S1-WEB-03).
// ---------------------------------------------------------------------------

/** After request-join, an answer (request-joined, host-absent, room-full,
 *  disabled) must arrive within this. Silence means a server that predates
 *  request links, so the page says "not available on this Floe server". */
export const JOIN_NO_ANSWER_MS = 10_000;

/** From request-joined to an open data channel. The host fetches its ICE
 *  list, offers, then waits 30 s for the answer and 30 s to connect before it
 *  gives up and reopens the link, so 75 s covers its whole budget. */
export const SETUP_TIMEOUT_MS = 75_000;

/** No Socket.IO connect at all within this ends the attempt (errata row R4).
 *  An unreachable server otherwise leaves socket.io-client retrying quietly
 *  forever. */
export const SOCKET_CONNECT_TIMEOUT_MS = 20_000;

/** How long the FIRST file waits for the host's answer. One clock with the CLI
 *  and the host: the host answers "expired" at the difference of these two,
 *  so its answer normally arrives before this timer fires, and both paths show
 *  the same Timed out copy. Derived, never restated as a literal. */
export const FIRST_ACK_TIMEOUT_MS = REQUEST_ACK_TIMEOUT_MS + REQUEST_ACK_GRACE_MS;

/** The host's own decision window (HostDecisionWindow on the Go side). The
 *  countdown on the Waiting screen counts this down, because it is when THEY
 *  must answer, not when this page stops waiting. */
export const ANSWER_WINDOW_MS = REQUEST_ACK_TIMEOUT_MS - REQUEST_ACK_GRACE_MS;

/** How long after the channel opens the relay probe reads the selected ICE
 *  pair. The same delay the main page's sender uses. */
export const RELAY_PROBE_DELAY_MS = 2_000;

/** A room-full answer this soon after this page's previous attempt ended is
 *  most likely this page's own old seat, not yet released; one retry after a
 *  short wait tells the two apart (spec 07 G1, errata row R2). */
export const ROOM_FULL_RETRY_WINDOW_MS = 15_000;
export const ROOM_FULL_RETRY_DELAY_MS = 3_000;

/** The STUN servers the page keeps when the TURN answer is missing or
 *  malformed: the same two the main page starts from. */
export const DEFAULT_STUN_SERVERS: readonly RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
];

/** The abort text the visitor sends when the route turns out to be a relay and
 *  the drop is over the cap. Byte for byte the main page's relay block text,
 *  which that page builds from two concatenated literals; lib/relay.test.ts
 *  joins them and compares, so the two can never drift apart. The host never
 *  shows it: it maps the abort to fixed copy of its own. */
export const RELAY_BLOCK_REASON =
    'Transfer blocked: relay connections are capped at 2 GB. ' +
    'Ask the sender to remove files, or to try a network that allows a direct connection.';

/** The abort text for the visitor's own Cancel. Fixed, like every string this
 *  page puts on the wire. */
export const VISITOR_CANCEL_REASON = 'The sender stopped.';

/** Where "What is a request link?" goes: the request-link docs page the docs
 *  plan names (DOC-S1-27, docs/desktop/request-links.mdx), served under the
 *  site's /docs rewrite. */
export const REQUEST_LINK_DOCS_PATH = '/docs/desktop/request-links';
