/**
 * What a failed wait may say about the Go host harness: its events and its stderr
 * tail, with everything a link is made of taken out. Pure, and apart from
 * request-helpers.ts so that vitest can read it: vitest reads lib/ and app/ only,
 * and a *.test.ts under e2e/ would be collected by Playwright.
 */

export interface HarnessEvent {
    event: string;
    [key: string]: unknown;
}

/**
 * The harness fields that carry the link or the room id: `link` on the link
 * event and `roomId` on joined (cli/internal/e2ehost/request.go). describe()
 * replaces them, so a failed wait never puts either into a Playwright error,
 * report or CI artifact.
 */
const SECRET_FIELDS = ['link', 'roomId'];
const REDACTED = '<redacted>';
/** In the stderr tail: a room id (UUID-shaped, RoomIDFromToken) and a link's
 *  `/r/<linkId>` path, whether or not an event announced them. */
const TAIL_SECRETS = [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, /\/r\/[A-Za-z0-9_-]+/g];

/**
 * The events with SECRET_FIELDS redacted and every other field kept, then the
 * stderr tail with TAIL_SECRETS replaced. A tail cut at its start loses the cut
 * line, which could hold the end of a value no pattern would match.
 */
export function describeHarness(events: HarnessEvent[], stderrTail: string, stderrCut: boolean): string {
    const shown = events.map((e) => {
        const copy: HarnessEvent = { ...e };
        for (const field of SECRET_FIELDS) if (field in copy) copy[field] = REDACTED;
        return copy;
    });
    let tail = stderrCut ? stderrTail.slice(stderrTail.indexOf('\n') + 1 || stderrTail.length) : stderrTail;
    for (const re of TAIL_SECRETS) tail = tail.replace(re, REDACTED);
    return `${JSON.stringify(shown)}${tail ? ` stderr tail: ${tail}` : ''}`;
}
