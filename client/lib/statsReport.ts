/**
 * Whether a finished receive has a byte count worth posting to the public
 * counter.
 *
 * The server takes a positive whole number and nothing else
 * (validateReportBytes in server/stats.js), and it answers 400 to anything
 * else only after its per-address limiter has counted the request. A transfer
 * made only of empty files ends with a total of 0, so the page used to spend
 * one of the sixty reports a minute allows on a request that could not count.
 *
 * The upper bound is the server's to enforce (MAX_REPORT_BYTES is its
 * setting); this only keeps out what no setting accepts.
 */
export function reportableBytes(bytes: number): boolean {
    return Number.isSafeInteger(bytes) && bytes > 0;
}
