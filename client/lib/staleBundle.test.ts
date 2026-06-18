import { describe, it, expect } from 'vitest';
import { isStaleBundleError } from './staleBundle';

describe('isStaleBundleError', () => {
    it('returns false for empty/nullish input', () => {
        expect(isStaleBundleError(undefined)).toBe(false);
        expect(isStaleBundleError(null)).toBe(false);
        expect(isStaleBundleError('')).toBe(false);
    });

    it('detects the Turbopack stale module-factory error (FLOE-C)', () => {
        expect(
            isStaleBundleError(
                'Module 74891 was instantiated because it was required from module 88178, but the module factory is not available.'
            )
        ).toBe(true);
    });

    it('detects Webpack chunk-load failures', () => {
        expect(isStaleBundleError('Loading chunk 537 failed.')).toBe(true);
        expect(isStaleBundleError('Loading chunk app-pages failed')).toBe(true);
        expect(isStaleBundleError('ChunkLoadError: Loading chunk 12 failed')).toBe(true);
    });

    it('detects native ESM dynamic-import failures across browser wording', () => {
        expect(isStaleBundleError('Failed to fetch dynamically imported module: https://x/a.js')).toBe(true);
        expect(isStaleBundleError('error loading dynamically imported module')).toBe(true);
        expect(isStaleBundleError('Importing a module script failed.')).toBe(true);
    });

    it('ignores unrelated application errors', () => {
        expect(isStaleBundleError('TypeError: Cannot read properties of undefined')).toBe(false);
        expect(isStaleBundleError('Ice connection failed.')).toBe(false);
        expect(
            isStaleBundleError(
                "Failed to execute 'setRemoteDescription' on 'RTCPeerConnection': Called in wrong state: stable"
            )
        ).toBe(false);
    });
});
