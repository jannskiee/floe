import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isWebKitDomDesync, type CheckableEvent } from './webkitDomDesync';

const reconciler = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
        filename: 'app:///_next/static/immutable/chunks/37yfzz1-lm0ho.js',
        function: i % 2 ? 'so' : 'ss',
    }));

// FLOE-P's shape (Mobile Safari 17.4.1, 2026-10-05): React's reconciler frames,
// then the native call that threw.
function floeP(nativeFunction = 'removeChild', type = 'NotFoundError'): CheckableEvent {
    return {
        exception: {
            values: [
                {
                    type,
                    mechanism: {},
                    stacktrace: { frames: [...reconciler(48), { filename: '[native code]', function: nativeFunction }] },
                },
            ],
        },
    };
}

describe('isWebKitDomDesync', () => {
    it("drops FLOE-P: a NotFoundError thrown by the native removeChild under React's reconciler", () => {
        expect(isWebKitDomDesync(floeP())).toBe(true);
    });

    it('drops the insertBefore twin', () => {
        expect(isWebKitDomDesync(floeP('insertBefore'))).toBe(true);
    });

    it('keeps a NotFoundError that a native call other than the two DOM methods threw', () => {
        expect(isWebKitDomDesync(floeP('querySelector'))).toBe(false);
    });

    it('keeps another error type thrown from the native removeChild', () => {
        expect(isWebKitDomDesync(floeP('removeChild', 'TypeError'))).toBe(false);
    });

    it('keeps a NotFoundError whose throwing frame is our own code', () => {
        const event: CheckableEvent = {
            exception: { values: [{ type: 'NotFoundError', mechanism: {}, stacktrace: { frames: reconciler(4) } }] },
        };
        expect(isWebKitDomDesync(event)).toBe(false);
    });

    it('reads the root exception, not a linked cause', () => {
        const event: CheckableEvent = {
            exception: {
                values: [
                    ...(floeP().exception?.values ?? []).map((v) => ({ ...v, mechanism: { parent_id: 0 } })),
                    { type: 'Error', mechanism: {}, stacktrace: { frames: reconciler(3) } },
                ],
            },
        };
        expect(isWebKitDomDesync(event)).toBe(false);
    });

    it('keeps an event with no exception or no frames', () => {
        expect(isWebKitDomDesync({})).toBe(false);
        expect(isWebKitDomDesync({ exception: { values: [{ type: 'NotFoundError' }] } })).toBe(false);
    });

    it('is wired into the browser beforeSend', () => {
        const src = readFileSync(fileURLToPath(new URL('../sentry.client.config.ts', import.meta.url)), 'utf8');
        expect(src).toContain("import { isWebKitDomDesync } from './lib/webkitDomDesync';");
        expect(src).toContain('if (isWebKitDomDesync(event)) return null;');
    });
});
