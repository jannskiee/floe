import { describe, it, expect } from 'vitest';
import {
    DESKTOP_VERSION,
    DESKTOP_RELEASE_DATE,
    DESKTOP_TAG,
    DESKTOP_STORE_ID,
    DESKTOP_STORE_URL,
    DESKTOP_SETUP_URL,
    DESKTOP_ZIP_URL,
    DESKTOP_SHA_URL,
    DESKTOP_RELEASE_NOTES_URL,
    DESKTOP_RELEASE_PAGE_URL,
    ALL_RELEASES_URL,
} from './desktopRelease';

describe('desktopRelease', () => {
    it('pins a strictly numeric X.Y.Z version', () => {
        // The release workflow enforces the same shape on tags; a suffix here
        // would produce asset URLs that do not exist.
        expect(DESKTOP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('derives the tag from the version', () => {
        expect(DESKTOP_TAG).toBe(`desktop-v${DESKTOP_VERSION}`);
    });

    it('carries a real, non-future release date (bumped together with the version)', () => {
        const parsed = new Date(DESKTOP_RELEASE_DATE);
        expect(Number.isNaN(parsed.getTime())).toBe(false);
        // A future date means the version was bumped without the date (or vice versa).
        expect(parsed.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('builds asset URLs matching the release workflow naming', () => {
        expect(DESKTOP_SETUP_URL).toBe(
            `https://github.com/jannskiee/floe/releases/download/desktop-v${DESKTOP_VERSION}/floe-desktop-setup-${DESKTOP_VERSION}.exe`
        );
        expect(DESKTOP_ZIP_URL).toBe(
            `https://github.com/jannskiee/floe/releases/download/desktop-v${DESKTOP_VERSION}/floe-desktop-${DESKTOP_VERSION}-windows-amd64.zip`
        );
        expect(DESKTOP_SHA_URL).toContain('/SHA256SUMS.txt');
        expect(DESKTOP_RELEASE_PAGE_URL).toContain(`/releases/tag/desktop-v${DESKTOP_VERSION}`);
    });

    it('points "release notes" at the changelog, not the generated GitHub body', () => {
        // desktop-release.yml writes the same boilerplate body on every tag, so
        // the GitHub release page carries no account of what changed. The docs
        // changelog is the only place that does.
        expect(DESKTOP_RELEASE_NOTES_URL).toBe('https://www.floe.one/docs/changelog');
        expect(DESKTOP_RELEASE_NOTES_URL).not.toContain('github.com');
    });

    it('never uses the releases/latest permalink, which resolves to the CLI', () => {
        for (const url of [
            DESKTOP_SETUP_URL,
            DESKTOP_ZIP_URL,
            DESKTOP_SHA_URL,
            DESKTOP_RELEASE_PAGE_URL,
            ALL_RELEASES_URL,
        ]) {
            expect(url).not.toContain('/releases/latest');
        }
    });

    it('links the Microsoft Store listing by product id (the primary install path)', () => {
        // The Store ID is assigned by Partner Center and never changes, even
        // across renames; the https detail URL works in any browser on any OS.
        expect(DESKTOP_STORE_ID).toMatch(/^9[A-Z0-9]{11}$/);
        expect(DESKTOP_STORE_URL).toBe(`https://apps.microsoft.com/detail/${DESKTOP_STORE_ID}`);
        // The ms-windows-store: protocol form errors on non-Windows, so it must
        // never appear here.
        expect(DESKTOP_STORE_URL).not.toContain('ms-windows-store');
    });
});
