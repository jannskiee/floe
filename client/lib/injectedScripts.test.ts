import { describe, it, expect } from 'vitest';
import { isInjectedScriptError, type CheckableEvent } from './injectedScripts';

const FLOE_CHUNK = 'app:///_next/static/chunks/354mhlwzyb0pq.js';

// FLOE-F exactly as Sentry stored it. Frames are oldest-first, so Sentry's own
// wrapped-setTimeout frame inside our bundle comes first and the injected
// script that actually threw comes last.
const floeF = (): CheckableEvent => ({
    exception: {
        values: [
            {
                mechanism: { },
                stacktrace: {
                    frames: [
                        { filename: FLOE_CHUNK, lineno: 5 },
                        { filename: '<anonymous>', lineno: 13 },
                    ],
                },
            },
        ],
    },
});

describe('isInjectedScriptError', () => {
    it('drops an error whose throwing frame is evaluated code (FLOE-F)', () => {
        expect(isInjectedScriptError(floeF())).toBe(true);
    });

    it('keeps a positionless <anonymous> pseudo-frame', () => {
        // V8 writes `at new Promise (<anonymous>)` with no source position, and
        // that really can be the deepest frame of a genuine error: the fixture
        // in browserExtensions.pipeline.test.ts is a real observed stack of
        // exactly this shape. Without the lineno half of the test, this would
        // silently discard our own promise bugs.
        const event: CheckableEvent = {
            exception: {
                values: [
                    {
                        stacktrace: {
                            frames: [
                                { filename: FLOE_CHUNK, lineno: 1 },
                                { filename: '<anonymous>' },
                            ],
                        },
                    },
                ],
            },
        };
        expect(isInjectedScriptError(event)).toBe(false);
    });

    it('keeps a genuine Floe application error', () => {
        const event: CheckableEvent = {
            exception: {
                values: [
                    {
                        stacktrace: {
                            frames: [
                                { filename: FLOE_CHUNK, lineno: 1 },
                                { filename: FLOE_CHUNK, lineno: 4 },
                            ],
                        },
                    },
                ],
            },
        };
        expect(isInjectedScriptError(event)).toBe(false);
    });

    it('reads the root exception, not a linked cause', () => {
        // LinkedErrors appends causes with mechanism.parent_id set. The root is
        // the last value WITHOUT one, matching _getEventFilterUrl. A cause
        // whose own deepest frame is ours must not rescue an injected error.
        const event = floeF();
        event.exception!.values!.push({
            mechanism: { parent_id: 0 },
            stacktrace: { frames: [{ filename: FLOE_CHUNK, lineno: 9 }] },
        });
        expect(isInjectedScriptError(event)).toBe(true);
    });

    it('keeps events it cannot classify', () => {
        expect(isInjectedScriptError({})).toBe(false);
        expect(isInjectedScriptError({ exception: { values: [] } })).toBe(false);
        expect(isInjectedScriptError({ exception: { values: [{}] } })).toBe(false);
        expect(isInjectedScriptError({ exception: { values: [{ stacktrace: { frames: [] } }] } })).toBe(
            false
        );
    });

    it('ignores an <anonymous> frame that is not the one that threw', () => {
        // Only the deepest frame decides. An injected script somewhere up the
        // stack, with our code below it, is our bug.
        const event: CheckableEvent = {
            exception: {
                values: [
                    {
                        stacktrace: {
                            frames: [
                                { filename: '<anonymous>', lineno: 13 },
                                { filename: FLOE_CHUNK, lineno: 4 },
                            ],
                        },
                    },
                ],
            },
        };
        expect(isInjectedScriptError(event)).toBe(false);
    });
});
