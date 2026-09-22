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
