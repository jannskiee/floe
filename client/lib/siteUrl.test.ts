import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * siteUrl resolves once at module load, because Next inlines
 * NEXT_PUBLIC_* at build time and metadata is evaluated during the build. So
 * every case has to reset the module registry and re-import, rather than
 * stubbing the environment around a live import.
 */
async function load(env: Record<string, string | undefined>) {
    vi.resetModules();
    vi.unstubAllEnvs();
    for (const [key, value] of Object.entries(env)) {
        vi.stubEnv(key, value as string);
    }
    return import('./siteUrl');
}

beforeEach(() => {
    vi.unstubAllEnvs();
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
});

describe('siteUrl', () => {
    it('uses NEXT_PUBLIC_SITE_URL when set', async () => {
        const { siteUrl } = await load({
            NEXT_PUBLIC_SITE_URL: 'https://floe.example.com',
        });
        expect(siteUrl).toBe('https://floe.example.com');
    });

    it('strips trailing slashes so callers can append a path', async () => {
        const { siteUrl } = await load({
            NEXT_PUBLIC_SITE_URL: 'https://floe.example.com///',
        });
        expect(siteUrl).toBe('https://floe.example.com');
    });

    it('trims surrounding whitespace', async () => {
        const { siteUrl } = await load({
            NEXT_PUBLIC_SITE_URL: '  https://floe.example.com  ',
        });
        expect(siteUrl).toBe('https://floe.example.com');
    });

    it('falls back to floe.one for an ordinary build', async () => {
        const { siteUrl } = await load({
            NEXT_PUBLIC_SITE_URL: '',
            FLOE_DISTRIBUTABLE_IMAGE: '',
        });
        expect(siteUrl).toBe('https://www.floe.one');
    });

    // The property that makes this change a no-op for the canonical deploy: with
    // no flag set, behaviour is identical to before the helper existed.
    it('falls back to floe.one when the variable is absent entirely', async () => {
        const { siteUrl } = await load({});
        expect(siteUrl).toBe('https://www.floe.one');
    });

    it('is undefined in the published image, rather than claiming floe.one', async () => {
        const { siteUrl } = await load({
            NEXT_PUBLIC_SITE_URL: '',
            FLOE_DISTRIBUTABLE_IMAGE: '1',
        });
        expect(siteUrl).toBeUndefined();
    });

    // client/Dockerfile declares `ARG NEXT_PUBLIC_SITE_URL=`, so the value that
    // reaches the build is the empty string, not undefined. A `!== undefined`
    // guard would let '' through and `new URL('')` throws.
    it('treats an empty string as unset, not as a URL', async () => {
        const { siteUrl, metadataBase } = await load({
            NEXT_PUBLIC_SITE_URL: '   ',
            FLOE_DISTRIBUTABLE_IMAGE: '1',
        });
        expect(siteUrl).toBeUndefined();
        expect(metadataBase).toBeNull();
    });

    it('lets a self-hoster override even inside the published image', async () => {
        const { siteUrl } = await load({
            NEXT_PUBLIC_SITE_URL: 'https://files.example.org',
            FLOE_DISTRIBUTABLE_IMAGE: '1',
        });
        expect(siteUrl).toBe('https://files.example.org');
    });
});

describe('metadataBase', () => {
    it('is a URL when the origin is known', async () => {
        const { metadataBase } = await load({
            NEXT_PUBLIC_SITE_URL: 'https://floe.example.com',
        });
        expect(metadataBase).toBeInstanceOf(URL);
        expect(metadataBase?.origin).toBe('https://floe.example.com');
    });

    // null, not undefined: an absent metadataBase makes Next resolve relative
    // Open Graph images against http://localhost:3000, which is worse than
    // emitting no image at all.
    it('is null in the published image', async () => {
        const { metadataBase } = await load({
            NEXT_PUBLIC_SITE_URL: '',
            FLOE_DISTRIBUTABLE_IMAGE: '1',
        });
        expect(metadataBase).toBeNull();
    });
});
