/**
 * What a throw inside the receiver means, so it can stop the transfer with the
 * right words and the right report.
 *
 * 'out-of-memory': the JavaScript engine refused an allocation. A browser
 * receiver keeps each file inside the browser until the tab closes, so a large
 * enough file can run the tab out (Firefox and Safari keep it all in memory,
 * Chromium past its blob storage), and the first sign is a throw from an
 * ordinary allocation such as the chunk copy in receiver.ts. FLOE-M is that throw from
 * Chrome on Windows, 4,272 times from one visitor:
 *
 *   RangeError: Array buffer allocation failed
 *     at arrayBufferConstructor_DoNotInitialize (<anonymous>)
 *     at new Uint8Array (<anonymous>)
 *     at handleMessage
 *
 * One shape per engine, because the wording is all there is to go on:
 *  - V8 (Chrome, Edge, Opera): RangeError "Array buffer allocation failed".
 *  - JavaScriptCore (Safari, every iOS browser): RangeError "Out of memory"
 *    (createOutOfMemoryError).
 *  - SpiderMonkey (Firefox): the primitive string "out of memory", thrown as
 *    a bare string rather than an Error, and catchable.
 * Deliberately narrow: a RangeError such as "Invalid array length" is a bug in
 * the code that asked, not a full tab, and must keep reaching Sentry as one.
 *
 * 'channel-closed': the receiver's own ack or abort could not be sent because
 * the data channel is no longer open. RTCDataChannel.send throws
 * InvalidStateError then, and simple-peer throws ERR_DESTROYED once it has torn
 * down. The connection is what failed, and the peer's close handler already
 * says so; reporting it as a bug would only add noise to Sentry.
 *
 * 'internal': anything else, which is a bug of ours and is reported once.
 */
export type ReceiveFailureCode = 'out-of-memory' | 'channel-closed' | 'internal';

const OUT_OF_MEMORY = /allocation failed|out of memory/i;

export function classifyThrow(err: unknown): ReceiveFailureCode {
    if (typeof err === 'string') return OUT_OF_MEMORY.test(err) ? 'out-of-memory' : 'internal';
    if (err instanceof RangeError && OUT_OF_MEMORY.test(err.message)) return 'out-of-memory';
    if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'InvalidStateError') {
        return 'channel-closed';
    }
    if (err instanceof Error && (err as Error & { code?: unknown }).code === 'ERR_DESTROYED') return 'channel-closed';
    return 'internal';
}
