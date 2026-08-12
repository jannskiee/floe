import {describe, expect, it} from 'vitest';
import {DOWNLOAD_URL, bareVersion, isNewerDesktopVersion} from './update';

describe('isNewerDesktopVersion', () => {
    it('stays silent for equal or older versions', () => {
        expect(isNewerDesktopVersion('desktop-v0.2.2', 'desktop-v0.2.2')).toBe(false);
        expect(isNewerDesktopVersion('desktop-v0.2.1', 'desktop-v0.2.2')).toBe(false);
    });

    it('shows for strictly newer versions', () => {
        expect(isNewerDesktopVersion('desktop-v0.2.3', 'desktop-v0.2.2')).toBe(true);
        expect(isNewerDesktopVersion('desktop-v0.3.0', 'desktop-v0.2.9')).toBe(true);
    });

    it('orders two-digit components numerically, not lexically', () => {
        expect(isNewerDesktopVersion('desktop-v0.2.10', 'desktop-v0.2.9')).toBe(true);
        expect(isNewerDesktopVersion('desktop-v0.2.9', 'desktop-v0.2.10')).toBe(false);
    });

    it('handles the major bump the prefix-blind compare gets wrong', () => {
        expect(isNewerDesktopVersion('desktop-v1.0.0', 'desktop-v0.9.9')).toBe(true);
    });

    it('accepts mixed tag forms on either side', () => {
        expect(isNewerDesktopVersion('0.2.3', 'desktop-v0.2.2')).toBe(true);
        expect(isNewerDesktopVersion('desktop-v0.2.3', 'v0.2.2')).toBe(true);
    });

    it('never shows on a dev or unresolved baseline', () => {
        expect(isNewerDesktopVersion('desktop-v9.9.9', 'dev')).toBe(false);
        expect(isNewerDesktopVersion('desktop-v9.9.9', '')).toBe(false);
    });

    it('fails closed on malformed input instead of throwing', () => {
        expect(isNewerDesktopVersion('desktop-vNext', 'desktop-v0.0.1')).toBe(false);
        expect(isNewerDesktopVersion('', 'desktop-v0.2.2')).toBe(false);
    });

    it('parses digit-strict like the Go comparator (10rc1 is 0, not 10)', () => {
        expect(isNewerDesktopVersion('desktop-v0.2.10rc1', 'desktop-v0.2.9')).toBe(false);
        expect(isNewerDesktopVersion('desktop-v0.2.9', 'desktop-v0.2.10rc1')).toBe(true);
    });
});

describe('bareVersion', () => {
    it('strips the desktop tag prefixes for display', () => {
        expect(bareVersion('desktop-v0.2.3')).toBe('0.2.3');
        expect(bareVersion('v0.2.3')).toBe('0.2.3');
        expect(bareVersion('0.2.3')).toBe('0.2.3');
    });
});

describe('DOWNLOAD_URL', () => {
    it('points at the canonical download page', () => {
        expect(DOWNLOAD_URL).toBe('https://www.floe.one/download');
    });
});
