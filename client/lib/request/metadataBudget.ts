// Does every file in this pick still fit in a control frame?
//
// The transfer protocol caps a control message at CONTROL_MSG_MAX (1000) bytes
// on the ENCODED frame, and a metadata frame carries the file's relative path.
// A path that pushes its frame over the cap does not fail politely: the browser
// receiver aborts the transfer and the Go receiver refuses the file, both after
// the visitor has already picked, waited for an accept and started sending.
//
// So the check runs at pick time, and it runs by building the real frame with
// the real builder rather than by counting characters. That is not caution, it
// is the only way to be right: JSON escaping grows quotes, backslashes and
// control characters, non-ASCII costs its UTF-8 length rather than its character
// count, and the numeric fields grow with their digits. A hand-rolled estimate
// is wrong in at least four directions at once.
//
// It is measured at WORST CASE per file: a full-length uuid, `index` equal to
// `total` (the most digits that field will ever hold), and a release string in
// `ver`, which the sender does not send today. That last one makes the number an
// upper bound rather than an exact match, deliberately: see constants.ts.

import { metadataMessage, CONTROL_MSG_MAX } from '../transfer/protocol';
import {
    CONTROL_FRAME_WORST_CASE_ID,
    CONTROL_FRAME_WORST_CASE_VER,
    MAX_REQUEST_FILES,
} from './constants';

const encoder = new TextEncoder();

/** The encoded byte length of the largest metadata frame this file can produce
 *  in a selection of `total` files totalling `totalBytes`.
 *
 *  Every argument that is not the path is at its widest: a full-length uuid,
 *  `index` equal to `total`, and a release string the sender does not send
 *  today. The last one is the only one that costs anything real, and
 *  constants.ts says why it is reserved anyway. */
export function metadataFrameBytes(
    relativePath: string,
    size: number,
    total: number,
    totalBytes: number
): number {
    return encoder.encode(
        metadataMessage(
            CONTROL_FRAME_WORST_CASE_ID,
            relativePath,
            size,
            // index at its widest: the last file of the batch.
            total,
            total,
            totalBytes,
            CONTROL_FRAME_WORST_CASE_VER
        )
    ).byteLength;
}

/** The least a candidate has to look like to be measured. A walked file, a
 *  chosen file and a plain test fixture all satisfy it. */
export interface PickCandidate {
    relativePath: string;
    file: { size: number };
}

export type PickCheck = { ok: true } | { ok: false; cause: 'too-many' | 'path-too-long' };

/**
 * Check a WHOLE selection, not the files being added to it.
 *
 * Two of the three inputs to a frame's size are properties of the selection
 * rather than of the file: `total` and `totalBytes` both grow as picks
 * accumulate, so a path that fit when it was the only file can stop fitting when
 * a second pick lands. Checking only the new files would let that through.
 */
export function checkPick(files: PickCandidate[]): PickCheck {
    const total = files.length;
    if (total > MAX_REQUEST_FILES) return { ok: false, cause: 'too-many' };

    const totalBytes = files.reduce((sum, f) => sum + f.file.size, 0);
    for (const f of files) {
        if (metadataFrameBytes(f.relativePath, f.file.size, total, totalBytes) > CONTROL_MSG_MAX) {
            return { ok: false, cause: 'path-too-long' };
        }
    }
    return { ok: true };
}
