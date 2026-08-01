import { describe, it, expect } from 'vitest';
import { eventFiltersIntegration, rewriteFramesIntegration } from '@sentry/nextjs';
import type { ErrorEvent, Event, EventHint, Exception, StackFrame } from '@sentry/nextjs';
import { BROWSER_EXTENSION_URL_PATTERNS } from './browserExtensions';

// Proves the FLOE-E fix against the REAL @sentry/core filter rather than a
// reimplementation of it. sentry.client.config.ts cannot be imported here: it
// calls Sentry.replayIntegration() at module scope, and in a node test
// '@sentry/nextjs' resolves to build/cjs/index.server.js where that export does
// not exist. So we drive the same integration the SDK installs, with the same
// denyUrls value the config passes it.

// --- Types -----------------------------------------------------------------
// '@sentry/nextjs' re-exports Event/EventHint/ErrorEvent/Exception/StackFrame
// but NOT Client or Integration. Derive what we need from the factory's own
// signature so it tracks any SDK change instead of drifting from it.
type ProcessEventFn = NonNullable<ReturnType<typeof eventFiltersIntegration>['processEvent']>;
type ProcessEventResult = ReturnType<ProcessEventFn>;
type SentryClientArg = Parameters<ProcessEventFn>[2];

// EventFilters only ever calls client.getOptions() (see _mergeOptions in
// @sentry/core/integrations/eventFilters.js), and RewriteFrames ignores the
// argument entirely, so a one-method stub is faithful. The double cast is
// required rather than lazy: a single `as` is rejected with TS2352 because the
// stub and Client do not sufficiently overlap. Keeping the annotation on the
// stub means the object itself is still typechecked.
type ClientStub = { getOptions: () => Record<string, unknown> };
const CLIENT_STUB: ClientStub = { getOptions: () => ({}) };
const CLIENT = CLIENT_STUB as unknown as SentryClientArg;

// EventFilters names this parameter `_hint` and never reads it.
const EMPTY_HINT: EventHint = {};

// processEvent is optional on the Integration interface and may declare a
// thenable return. Both integrations here are synchronous, so narrow once and
// fail loudly - otherwise a vanished hook would return undefined, which a
// `.not.toBeNull()` assertion would happily accept.
function assertSync(result: ProcessEventResult | undefined): Event | null {
    if (result === undefined) throw new Error('integration exposed no processEvent hook');
    if (result !== null && 'then' in result) throw new Error('expected a synchronous integration');
    return result;
}

// --- Fixtures --------------------------------------------------------------

const METAMASK_INPAGE_URL = 'chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js';
const FLOE_CHUNK_URL = 'https://www.floe.one/_next/static/chunks/page-abc.js';

// Events are built by factories, never shared. rewriteFramesIntegration returns
// a new event but reuses the SAME frame objects, and its iteratee assigns to
// frame.filename in place, so a module-level fixture would be mutated by one
// test and silently change the meaning of the next.
function metaMaskFrames(): StackFrame[] {
    return [{ filename: METAMASK_INPAGE_URL, function: 'Object.connect', in_app: true, lineno: 7, colno: 84179 }];
}

// FLOE-E as Sentry received it: an unhandled rejection raised inside MetaMask's
// injected script, with a chained "MetaMask extension not found" cause linked
// to it by LinkedErrors.
//
// The shape is load-bearing. _getEventFilterUrl reverse-scans exception.values
// for the first value with no mechanism.parent_id AND a non-empty frame list;
// _getLastValidUrl then walks THAT value's frames backward, skipping
// <anonymous> and [native code]. values[0] carries parent_id so it is skipped;
// values[1] is what decides the filtered URL.
function makeFloeEEvent(frames: StackFrame[] = metaMaskFrames()): ErrorEvent {
    const values: Exception[] = [
        {
            type: 'Error',
            value: 'MetaMask extension not found',
            mechanism: { type: 'chained', handled: false, source: 'cause', exception_id: 1, parent_id: 0 },
        },
        {
            type: 'i',
            value: 'Failed to connect to MetaMask',
            mechanism: { type: 'onunhandledrejection', handled: false, exception_id: 0 },
            stacktrace: { frames },
        },
    ];
    return { type: undefined, level: 'error', platform: 'javascript', exception: { values } };
}

// A real Floe bug: the regression guard.
function makeFloeApplicationEvent(): ErrorEvent {
    const values: Exception[] = [
        {
            type: 'TypeError',
            value: "Cannot read properties of undefined (reading 'send')",
            mechanism: { type: 'onunhandledrejection', handled: false },
            stacktrace: {
                frames: [
                    { filename: FLOE_CHUNK_URL, function: 'sendFiles', in_app: true, lineno: 1, colno: 5312 },
                    { filename: FLOE_CHUNK_URL, function: 'onDataChannelOpen', in_app: true, lineno: 1, colno: 4210 },
                ],
            },
        },
    ];
    return { type: undefined, level: 'error', platform: 'javascript', exception: { values } };
}

// --- Drivers ---------------------------------------------------------------

// A FRESH integration instance per call, on purpose: EventFilters memoizes its
// merged options on first use, so one shared instance would make the
// "no denyUrls" case reuse the "with denyUrls" options and pass for free.
function runEventFilters(event: Event, denyUrls?: RegExp[]): Event | null {
    const integration = eventFiltersIntegration(denyUrls ? { denyUrls } : {});
    return assertSync(integration.processEvent?.(event, EMPTY_HINT, CLIENT));
}

// Replica of NextjsClientStackFrameNormalization.
//
// This is NOT the real integration: nextjsClientStackFrameNormalizationIntegration
// is exported from no @sentry/nextjs build entry, and the package `exports` map
// blocks deep imports. What it actually is, though, is rewriteFramesIntegration
// wrapped around one custom iteratee, so we use the REAL rewriteFramesIntegration
// and hand-copy that iteratee from
// node_modules/@sentry/nextjs/build/cjs/client/clientNormalizationIntegration.js.
// We copy the non-experimental branch because that is the one that runs here:
// experimentalThirdPartyOriginStackFrames is off and next.config.mjs sets neither
// assetPrefix nor basePath, so rewriteFramesAssetPrefixPath is ''.
//
// Being a replica, this documents the ordering assumption; it cannot detect a
// future SDK change to the iteratee itself.
const ASSET_PREFIX_PATH = '';

// The one deliberate deviation from the SDK source, and the reason a verbatim
// copy would prove nothing. The SDK calls `new URL(frame.filename).origin`.
// Chromium registers chrome-extension: and friends as STANDARD schemes and
// returns "chrome-extension://<id>", but Node's WHATWG URL treats them as
// non-special and returns the opaque origin - the literal string "null" -
// against which the SDK's .replace(origin, ...) is a silent no-op. Reproduce
// the browser's answer so this file tests production behaviour.
function browserOrigin(filename: string): string {
    const nodeOrigin = new URL(filename).origin;
    if (nodeOrigin !== 'null') return nodeOrigin;
    const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i.exec(filename);
    if (!match) throw new TypeError(`no origin for ${filename}`);
    return match[1];
}

function runNormalization(event: Event): Event {
    const integration = rewriteFramesIntegration({
        iteratee: (frame: StackFrame): StackFrame => {
            try {
                const origin = browserOrigin(frame.filename ?? '');
                frame.filename = frame.filename?.replace(origin, 'app://').replace(ASSET_PREFIX_PATH, '');
            } catch {
                // Filename was not a URL, so there is nothing to rewrite.
            }
            return frame;
        },
    });
    const processed = assertSync(integration.processEvent?.(event, EMPTY_HINT, CLIENT));
    if (processed === null) throw new Error('RewriteFrames never drops events');
    return processed;
}

describe('browser-extension denyUrls in the Sentry event pipeline', () => {
    it('drops the MetaMask unhandled rejection (FLOE-E)', () => {
        expect(runEventFilters(makeFloeEEvent(), BROWSER_EXTENSION_URL_PATTERNS)).toBeNull();
    });

    it('keeps the same event when denyUrls is absent (guards a false pass)', () => {
        // Without this, the test above could pass for a reason unrelated to the
        // fix: a DEFAULT_IGNORE_ERRORS entry matching the message, or
        // _isUselessError discarding it. It must be denyUrls that drops FLOE-E.
        expect(runEventFilters(makeFloeEEvent())).not.toBeNull();
    });

    it('keeps a genuine Floe application error (reporting must not regress)', () => {
        expect(runEventFilters(makeFloeApplicationEvent(), BROWSER_EXTENSION_URL_PATTERNS)).not.toBeNull();
    });

    it('drops when the extension frame sits behind one of ours', () => {
        // The real-world shape. Sentry orders frames oldest-first, so the
        // injected script is last even though our bundle is on the stack, and
        // _getLastValidUrl steps back over a trailing <anonymous> frame to
        // find it. Observed live: the browser produced exactly
        // [<app chunk>, chrome-extension://...inpage.js] for this rejection.
        const frames: StackFrame[] = [
            { filename: FLOE_CHUNK_URL, function: 'sendFiles', in_app: true },
            { filename: METAMASK_INPAGE_URL, function: 'Object.connect', in_app: true },
            { filename: '<anonymous>', function: 'new Promise', in_app: false },
        ];
        expect(runEventFilters(makeFloeEEvent(frames), BROWSER_EXTENSION_URL_PATTERNS)).toBeNull();
    });
});

describe('EventFilters must run before NextjsClientStackFrameNormalization', () => {
    it('rewrites the MetaMask frame to app:///scripts/inpage.js', () => {
        // Pins the replica to the value the real integration produces in a
        // browser. Observed live on a production build: the same event carried
        // chrome-extension://...inpage.js at preprocessEvent time and
        // app:///scripts/inpage.js by the time it reached the transport.
        const normalized = runNormalization(makeFloeEEvent());
        expect(normalized.exception?.values?.[1]?.stacktrace?.frames?.[0]?.filename).toBe(
            'app:///scripts/inpage.js'
        );
    });

    it('would report FLOE-E if normalization ran first', () => {
        // The executable statement of the assumption this fix rests on. Once
        // the filename is app:///scripts/inpage.js it is indistinguishable from
        // our own code and no denyUrls entry can - or should - match it.
        // @sentry/browser lists the filter FIRST in getDefaultIntegrations()
        // and @sentry/nextjs pushes the normalization LAST, and processEvent
        // hooks run in registration order, so in production the filter wins.
        // If that ever changes, this test still passes and FLOE-E simply
        // reappears in Sentry; treat it as documentation, not a canary.
        const reported = runEventFilters(runNormalization(makeFloeEEvent()), BROWSER_EXTENSION_URL_PATTERNS);
        expect(reported).not.toBeNull();
    });
});
