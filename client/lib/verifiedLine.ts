// The web success line for a verified transfer, D-101: 'SHA-256 matched' and
// never a digest value. Pure, with a .test.ts sibling, the receiverClose.ts
// pattern. `verified` is a LOCAL boolean per file (receiver.ts sets it from its
// own compare, sender.ts from verifiedCountOf's range check), never a peer
// number.
export const VERIFIED_LINE = 'SHA-256 matched';

/**
 * The line when every announced file arrived and every one of them verified,
 * else null. A partial receive shows nothing: a count below the announced total
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
