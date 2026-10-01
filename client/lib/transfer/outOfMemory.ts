/**
 * Whether a thrown value is the JavaScript engine refusing to allocate memory.
 *
 * A browser receiver holds each file in the tab until it is complete, so a
 * large enough file runs the tab out of memory, and the first sign is a throw
 * from an ordinary allocation (the chunk copy in receiver.ts). FLOE-M is that
 * throw from Chrome on Windows, 4,272 times from one visitor:
 *
 *   RangeError: Array buffer allocation failed
 *     at arrayBufferConstructor_DoNotInitialize (<anonymous>)
 *     at new Uint8Array (<anonymous>)
 *     at handleMessage
 *
 * One shape per engine, because the wording is all there is to go on:
 *  - V8 (Chrome, Edge, Opera): RangeError "Array buffer allocation failed".
 *  - JavaScriptCore (Safari, every iOS browser): RangeError "Out of memory".
 *  - SpiderMonkey (Firefox): the primitive string "out of memory". It is
 *    thrown as a bare string, not as an Error, so `instanceof` alone misses it.
 *
 * Deliberately narrow. A RangeError such as "Invalid array length" is a bug in
 * the code that asked, not a full tab, and must keep reaching Sentry as one.
 */
const OUT_OF_MEMORY = /allocation failed|out of memory/i;

export function isOutOfMemory(err: unknown): boolean {
    if (typeof err === 'string') return OUT_OF_MEMORY.test(err);
    return err instanceof RangeError && OUT_OF_MEMORY.test(err.message);
}
