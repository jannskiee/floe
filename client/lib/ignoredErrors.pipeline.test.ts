import { describe, it, expect } from 'vitest';
import { eventFiltersIntegration } from '@sentry/nextjs';
import type { ErrorEvent, Event, EventHint, Exception } from '@sentry/nextjs';
import { IGNORED_ERROR_PATTERNS } from './ignoredErrors';
import { BROWSER_EXTENSION_URL_PATTERNS } from './browserExtensions';

// Proves the FLOE-H fix against the REAL @sentry/core filter rather than a
// reimplementation of it. sentry.client.config.ts cannot be imported here: it
// calls Sentry.init() at module scope. So we drive the same integration the SDK
// installs, with the same ignoreErrors value the config passes it.
//
// The harness below is deliberately duplicated from
// browserExtensions.pipeline.test.ts rather than extracted into a shared kit.
// The two files test opposite halves of EventFilters, one message extraction
// and one frame ordering, and coupling them would make each harder to change.

// --- Types -----------------------------------------------------------------
type ProcessEventFn = NonNullable<ReturnType<typeof eventFiltersIntegration>['processEvent']>;
type ProcessEventResult = ReturnType<ProcessEventFn>;
type SentryClientArg = Parameters<ProcessEventFn>[2];

// EventFilters only ever calls client.getOptions() (_mergeOptions in
// @sentry/core/integrations/eventFilters.js), so a one-method stub is faithful.
type ClientStub = { getOptions: () => Record<string, unknown> };
const CLIENT_STUB: ClientStub = { getOptions: () => ({}) };
const CLIENT = CLIENT_STUB as unknown as SentryClientArg;

// EventFilters names this parameter `_hint` and never reads it.
const EMPTY_HINT: EventHint = {};

function assertSync(result: ProcessEventResult | undefined): Event | null {
    if (result === undefined) throw new Error('integration exposed no processEvent hook');
    if (result !== null && 'then' in result) throw new Error('expected a synchronous integration');
    return result;
}

// A FRESH integration instance per call, on purpose: EventFilters memoizes its
// merged options on first use, so one shared instance would make the "no
// ignoreErrors" case reuse the "with ignoreErrors" options and pass for free.
function runEventFilters(
    event: Event,
    options: { ignoreErrors?: (string | RegExp)[]; denyUrls?: RegExp[] } = {}
): Event | null {
    const integration = eventFiltersIntegration(options);
    return assertSync(integration.processEvent?.(event, EMPTY_HINT, CLIENT));
}

// --- Fixtures --------------------------------------------------------------

// FLOE-H as Sentry received it. Every filename is ALREADY app://, the injected
// logger's included: @sentry/nextjs rewrote them before the event was stored.
// That is not incidental, it is the reason this fix cannot be a denyUrls entry.
// Frames are oldest-first, the reverse of the issue page's display order.
const FB_LOGGER = 'app://navigation_performance_logger_android';
const FLOE_CHUNK = 'app:///_next/static/immutable/chunks/01etqiofowxq2.js';
const FLOE_H_VALUE = 'Error invoking postMessage: Java object is gone';

function makeFloeHEvent(value: string = FLOE_H_VALUE): ErrorEvent {
    const values: Exception[] = [
        {
            type: 'Error',
            value,
            mechanism: { type: 'auto.browser.browserapierrors.addEventListener', handled: false },
            stacktrace: {
                frames: [
                    { filename: FLOE_CHUNK, function: 'n', lineno: 32, colno: 1785, in_app: true },
                    { filename: FB_LOGGER, lineno: 1, colno: 18239, in_app: true },
                    { filename: FB_LOGGER, function: 'sendINPMessage', lineno: 1, colno: 13829, in_app: true },
                    {
                        filename: FB_LOGGER,
                        function: 'sendDataToNative',
                        lineno: 1,
                        colno: 10198,
                        in_app: true,
                    },
                ],
            },
        },
    ];
    return { type: undefined, level: 'error', platform: 'javascript', exception: { values } };
}

// FLOE-G, the NumberFlow commit-phase crash. The regression guard.
function makeFloeGEvent(): ErrorEvent {
    const values: Exception[] = [
        {
            type: 'TypeError',
            value: 'this.el?.willUpdate is not a function',
            mechanism: { type: 'generic', handled: true },
            stacktrace: {
                frames: [
                    {
                        filename: FLOE_CHUNK,
                        function: 'z.getSnapshotBeforeUpdate',
                        lineno: 1,
                        colno: 16024,
                    },
                ],
            },
        },
    ];
    return { type: undefined, level: 'error', platform: 'javascript', exception: { values } };
}

function makeChunkLoadEvent(): ErrorEvent {
    const values: Exception[] = [
        {
            type: 'ChunkLoadError',
            value: 'Loading chunk 493 failed.',
            mechanism: { type: 'onunhandledrejection', handled: false },
            stacktrace: {
                frames: [{ filename: FLOE_CHUNK, function: 'loadChunk', lineno: 1, colno: 20 }],
            },
        },
    ];
    return { type: undefined, level: 'error', platform: 'javascript', exception: { values } };
}

describe('ignoreErrors in the Sentry event pipeline', () => {
    it('drops the Facebook WebView bridge error (FLOE-H)', () => {
        expect(runEventFilters(makeFloeHEvent(), { ignoreErrors: IGNORED_ERROR_PATTERNS })).toBeNull();
    });

    it('keeps the same event when ignoreErrors is absent (guards a false pass)', () => {
        // Without this, the test above could pass for a reason unrelated to the
        // fix. DEFAULT_IGNORE_ERRORS is merged in unconditionally and carries
        // /^Java exception was raised during method invocation$/, close enough
        // in wording to be worth ruling out and anchored so it cannot match.
        // _isUselessError cannot drop it either: it has both a stacktrace and a
        // value. It must be OUR entry that drops FLOE-H.
        expect(runEventFilters(makeFloeHEvent())).not.toBeNull();
    });

    it('is not something denyUrls could have done', () => {
        // The executable reason this fix is not FLOE-E's fix. Every frame Sentry
        // stored is already app://, the injected logger's included, so
        // _getLastValidUrl hands BROWSER_EXTENSION_URL_PATTERNS a string none of
        // them match, by design: browserExtensions.test.ts asserts that no
        // pattern may match an app:// prefix.
        expect(
            runEventFilters(makeFloeHEvent(), { denyUrls: BROWSER_EXTENSION_URL_PATTERNS })
        ).not.toBeNull();
    });

    it('drops on the top-level message alone, with no exception', () => {
        // getPossibleEventMessages' first candidate, for the SDK paths that
        // produce a message-only event.
        const event: Event = { type: undefined, level: 'error', message: FLOE_H_VALUE };
        expect(runEventFilters(event, { ignoreErrors: IGNORED_ERROR_PATTERNS })).toBeNull();
    });

    it('only ever tests the LAST exception value', () => {
        // The sharp edge lib/ignoredErrors.ts warns about, made executable: a
        // LinkedErrors cause appended after the matching value takes its place
        // as the tested one, and the entry stops firing.
        const event = makeFloeHEvent();
        event.exception?.values?.push({
            type: 'Error',
            value: 'some chained cause',
            mechanism: { type: 'chained', handled: false, parent_id: 0 },
        });
        expect(runEventFilters(event, { ignoreErrors: IGNORED_ERROR_PATTERNS })).not.toBeNull();
    });

    it('keeps a genuine Floe application error (FLOE-G)', () => {
        expect(runEventFilters(makeFloeGEvent(), { ignoreErrors: IGNORED_ERROR_PATTERNS })).not.toBeNull();
    });

    it('keeps a stale-bundle error so beforeSend can still fingerprint it', () => {
        expect(
            runEventFilters(makeChunkLoadEvent(), { ignoreErrors: IGNORED_ERROR_PATTERNS })
        ).not.toBeNull();
    });
});
