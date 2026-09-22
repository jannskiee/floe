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
