// The web's words for a verified transfer, D-101: 'SHA-256 matched' and never
// a digest value. Since the check mark took over from the visible line (the
// desktop's rule, D-161), the words pick a green circle-check over a gray
// plain one and are read to screen readers only. Pure, with a .test.ts
// sibling, the receiverClose.ts pattern. `verified` is a LOCAL boolean per file (receiver.ts sets it from its
// own compare, sender.ts from verifiedCountOf's range check), never a peer
// number.
export const VERIFIED_LINE = 'SHA-256 matched';

/**
 * The words when every announced file arrived and every one of them verified,
 * else null. A partial receive gets nothing: a count below the announced total
 * has not proved anything about the files that never came.
 */
export function verifiedLine(
    files: { verified: boolean }[],
    expected: number
): string | null {
    if (expected <= 0 || files.length === 0 || files.length < expected)
        return null;
    return files.every((f) => f.verified) ? VERIFIED_LINE : null;
}
