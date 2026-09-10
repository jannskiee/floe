import { describe, it, expect } from 'vitest';
import { IGNORED_ERROR_PATTERNS } from './ignoredErrors';

// Replicates stringMatchesSomePattern/isMatchingPattern from @sentry/core for a
// plain-string pattern: a case-sensitive substring test. The pipeline sibling
// proves this replica against the real integration; this file is the cheap
// per-entry sweep.
const isIgnored = (message: string): boolean =>
    IGNORED_ERROR_PATTERNS.some((pattern) =>
        typeof pattern === 'string' ? message.includes(pattern) : pattern.test(message)
    );

// FLOE-H exactly as Sentry stored the exception value.
const FLOE_H = 'Error invoking postMessage: Java object is gone';

describe('IGNORED_ERROR_PATTERNS', () => {
    it('matches the Facebook Android WebView bridge error (FLOE-H)', () => {
        expect(isIgnored(FLOE_H)).toBe(true);
    });

    it('matches the "<type>: <value>" form Sentry also tests', () => {
        // getPossibleEventMessages pushes `${type}: ${value}` as a third
        // candidate alongside event.message and the bare value.
        expect(isIgnored(`Error: ${FLOE_H}`)).toBe(true);
    });

    it('covers the bridge methods other than postMessage', () => {
        // The entry deliberately matches the bridge's own words rather than
        // "Error invoking postMessage", because the method name varies by host
        // app while "Java object is gone" comes from Chromium itself.
        expect(isIgnored('Error invoking onNavigation: Java object is gone')).toBe(true);
    });

    it('is a substring test, not an exact one', () => {
        expect(isIgnored(`Uncaught (in promise) Error: ${FLOE_H} at x`)).toBe(true);
    });

    it('is case-sensitive, so an entry must keep its original casing', () => {
        // isMatchingPattern uses String#includes for string patterns. Lowercase
        // the entry later and the filter silently stops firing.
        expect(isIgnored('error invoking postmessage: java object is gone')).toBe(false);
    });

    it('still matches every wording the config filtered before the extraction', () => {
        expect(
            isIgnored(
                "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node."
            )
        ).toBe(true);
        expect(
            isIgnored("Failed to execute 'insertBefore' on 'Node': parameter 1 is not of type 'Node'.")
        ).toBe(true);
        expect(isIgnored('Object Not Found Matching Id:3, MethodName:update, ParamCount:4')).toBe(true);
        expect(isIgnored('Write permission denied.')).toBe(true);
        expect(isIgnored('ResizeObserver loop completed with undelivered notifications.')).toBe(true);
    });

    it('never swallows a genuine Floe application error', () => {
        expect(isIgnored("Cannot read properties of undefined (reading 'send')")).toBe(false);
        expect(isIgnored('Failed to connect to MetaMask')).toBe(false);
        // FLOE-G, the NumberFlow commit-phase crash that components/
        // AnimatedByteCount.tsx contains. It must keep reaching Sentry: a
        // filter that hides it from us is worse than the crash itself.
        expect(isIgnored('this.el?.willUpdate is not a function')).toBe(false);
    });

    it('never swallows a stale-bundle error before beforeSend can fingerprint it', () => {
        // EventFilters runs ahead of beforeSend, so anything matched here never
        // reaches the stale-bundle branch in sentry.client.config.ts. Keep the
        // wordings in lib/staleBundle.ts out of every entry.
        for (const message of [
            'Loading chunk 493 failed.',
            'ChunkLoadError: Loading chunk app/page failed.',
            'Failed to fetch dynamically imported module: https://www.floe.one/_next/static/chunks/x.js',
            'Module 74891 was instantiated because it was required from module 88178, but the module factory is not available.',
        ]) {
            expect(isIgnored(message)).toBe(false);
        }
    });

    it('carries only plain-string patterns today', () => {
        // A future RegExp entry has to carry the no-g/no-y guard that
        // browserExtensions.test.ts pins, because Sentry calls .test() on these
        // same instances for every event and a sticky flag would advance
        // lastIndex. This assertion is the reminder.
        for (const pattern of IGNORED_ERROR_PATTERNS) {
            expect(typeof pattern).toBe('string');
        }
    });
});
