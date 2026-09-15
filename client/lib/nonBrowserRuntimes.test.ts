import { describe, it, expect } from 'vitest';
import { isNonBrowserRuntimeError, type CheckableEvent } from './nonBrowserRuntimes';
import { isInjectedScriptError } from './injectedScripts';

// FLOE-J exactly as Sentry stored it: oldest frame first, the throwing one last.
// Only filenames decide; the rest is kept so the fixture reads like the event.
const FLOE_J_FRAMES = [
    { filename: 'ext:core/01_core.js', function: 'eventLoopTick', lineno: 178, colno: 7 },
    { filename: 'ext:core/01_core.js', lineno: 294, colno: 9 },
    { filename: '<script>', lineno: 1, colno: 100633 },
    { filename: '<script>', function: 'xm', lineno: 1, colno: 98865 },
    { filename: '<obscura:bootstrap>', lineno: 346, colno: 75 },
    { filename: '<script>', function: 'Object.O [as onmessage]', lineno: 46, colno: 54979 },
    { filename: '<script>', function: 'uV', lineno: 46, colno: 207502 },
    { filename: '<script>', function: 'ur', lineno: 46, colno: 182292 },
    { filename: '<script>', function: 'ua', lineno: 46, colno: 184056 },
    { filename: '<script>', function: 'u_', lineno: 46, colno: 200903 },
    { filename: '<script>', lineno: 46, colno: 198629 },
    { filename: '<script>', lineno: 46, colno: 198613 },
    { filename: '<script>', function: 'l5', lineno: 46, colno: 159317 },
    { filename: '<script>', function: 'F.getSnapshotBeforeUpdate', lineno: 1, colno: 16028 },
];

// FLOE-G, the same client before AnimatedByteCount existed: the same frames, with
// the chunk offsets and one minified name shifted.
const FLOE_G_FRAMES = [
    { filename: 'ext:core/01_core.js', function: 'eventLoopTick', lineno: 178, colno: 7 },
    { filename: 'ext:core/01_core.js', lineno: 294, colno: 9 },
    { filename: '<script>', lineno: 1, colno: 100633 },
    { filename: '<script>', function: 'xm', lineno: 1, colno: 98865 },
    { filename: '<obscura:bootstrap>', lineno: 346, colno: 75 },
    { filename: '<script>', function: 'Object.O [as onmessage]', lineno: 46, colno: 54663 },
    { filename: '<script>', function: 'uV', lineno: 46, colno: 207186 },
    { filename: '<script>', function: 'ur', lineno: 46, colno: 181976 },
    { filename: '<script>', function: 'ua', lineno: 46, colno: 183740 },
    { filename: '<script>', function: 'u_', lineno: 46, colno: 200587 },
    { filename: '<script>', lineno: 46, colno: 198313 },
    { filename: '<script>', lineno: 46, colno: 198297 },
    { filename: '<script>', function: 'l5', lineno: 46, colno: 159001 },
    { filename: '<script>', function: 'z.getSnapshotBeforeUpdate', lineno: 1, colno: 16024 },
];

const FLOE_CHUNK = 'app:///_next/static/chunks/01etqiofowxq2.js';

type Frames = { filename?: string; lineno?: number }[];
const withFrames = (...stacks: Frames[]): CheckableEvent => ({
    exception: { values: stacks.map((frames) => ({ stacktrace: { frames } })) },
});

describe('isNonBrowserRuntimeError', () => {
    it('drops FLOE-J, the odometer fallback reporting from Obscura', () => {
        expect(isNonBrowserRuntimeError(withFrames(FLOE_J_FRAMES))).toBe(true);
    });

    it('drops FLOE-G, the same client before the fallback existed', () => {
        expect(isNonBrowserRuntimeError(withFrames(FLOE_G_FRAMES))).toBe(true);
    });

    it('is not something isInjectedScriptError already caught', () => {
        // The executable reason for a separate module: FLOE-J's throwing frame
        // is <script>, not <anonymous>, so the FLOE-F filter keeps it.
        expect(isInjectedScriptError(withFrames(FLOE_J_FRAMES))).toBe(false);
    });

    it('drops the shape current Obscura code would give, where only the ext: frames are foreign', () => {
        // Obscura's current code names page scripts by URL, so after
        // normalization every frame above deno_core's would be one of our
        // chunks. A check that looked only at the throwing frame would keep this.
        const frames = [
            { filename: 'ext:core/01_core.js', lineno: 178 },
            { filename: 'ext:core/01_core.js', lineno: 294 },
            { filename: FLOE_CHUNK, lineno: 46 },
            { filename: FLOE_CHUNK, lineno: 1 },
        ];
        expect(isNonBrowserRuntimeError(withFrames(frames))).toBe(true);
    });

    it('reads every exception value, linked causes included', () => {
        // Whichever position LinkedErrors gives the cause, an ext: frame in any
        // value is enough.
        expect(isNonBrowserRuntimeError(withFrames([{ filename: FLOE_CHUNK, lineno: 1 }], FLOE_J_FRAMES))).toBe(
            true
        );
        expect(isNonBrowserRuntimeError(withFrames(FLOE_J_FRAMES, [{ filename: FLOE_CHUNK, lineno: 1 }]))).toBe(
            true
        );
    });

    it('matches any deno_core module, not only core', () => {
        expect(isNonBrowserRuntimeError(withFrames([{ filename: 'ext:deno_web/02_timers.js', lineno: 3 }]))).toBe(
            true
        );
    });

    it('needs no source position', () => {
        expect(isNonBrowserRuntimeError(withFrames([{ filename: 'ext:core/01_core.js' }]))).toBe(true);
    });

    it('finds an ext: frame that is neither the oldest nor the one that threw', () => {
        // Every true case above has ext: first or alone, which a check reading
        // only frames[0] would also pass. A bootstrap script calling into page
        // code through a deno_core module puts it in the middle.
        expect(
            isNonBrowserRuntimeError(
                withFrames([
                    { filename: '<obscura:bootstrap>', lineno: 1 },
                    { filename: 'ext:deno_web/02_event.js', lineno: 2 },
                    { filename: FLOE_CHUNK, lineno: 1 },
                ])
            )
        ).toBe(true);
    });

    it('keeps an injected <anonymous> error (FLOE-F), which is another filter\'s job', () => {
        expect(
            isNonBrowserRuntimeError(withFrames([{ filename: FLOE_CHUNK, lineno: 5 }, { filename: '<anonymous>', lineno: 13 }]))
        ).toBe(false);
    });

    it('keeps the odometer report from a real browser', () => {
        // The signal components/AnimatedByteCount.tsx exists to send. A browser
        // that hits the fallback must still reach Sentry.
        expect(isNonBrowserRuntimeError(withFrames([{ filename: FLOE_CHUNK, lineno: 1 }]))).toBe(false);
    });

    it('does not key on names that belong to one Obscura build', () => {
        expect(
            isNonBrowserRuntimeError(
                withFrames([
                    { filename: '<script>', lineno: 1 },
                    { filename: '<obscura:bootstrap>', lineno: 346 },
                    { filename: '<script>', lineno: 1 },
                ])
            )
        ).toBe(false);
    });

    it('never matches a look-alike', () => {
        for (const filename of [
            'extensions::SafeBuiltins:1',
            'extension://abc/content.js',
            'chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/inpage.js',
            'moz-extension://2f8a5f6c/content.js',
            'blob:https://www.floe.one/2f8a5f6c-1b7d-4a3e-9c2f-8d1e5a6b7c90',
            'webpack-internal:///./lib/x.ts',
            'node:internal/process/task_queues',
            'app:///_next/static/chunks/ext:core.js',
            'https://www.floe.one/ext:core/01_core.js',
            'EXT:core/01_core.js',
            ' ext:core/01_core.js',
        ]) {
            expect(isNonBrowserRuntimeError(withFrames([{ filename, lineno: 1 }])), filename).toBe(false);
        }
    });

    it('keeps events it cannot classify', () => {
        expect(isNonBrowserRuntimeError({})).toBe(false);
        expect(isNonBrowserRuntimeError({ exception: {} })).toBe(false);
        expect(isNonBrowserRuntimeError({ exception: { values: [] } })).toBe(false);
        expect(isNonBrowserRuntimeError({ exception: { values: [{}] } })).toBe(false);
        expect(isNonBrowserRuntimeError(withFrames([]))).toBe(false);
        expect(isNonBrowserRuntimeError(withFrames([{ lineno: 1 }]))).toBe(false);
    });

    it('does not modify the event', () => {
        const event = withFrames(FLOE_J_FRAMES, [{ filename: FLOE_CHUNK, lineno: 1 }]);
        const before = structuredClone(event);
        isNonBrowserRuntimeError(event);
        expect(event).toEqual(before);
    });
});
