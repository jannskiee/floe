import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveSocketUrl, peekSocketUrl, resetSocketUrlCache } from './socketUrl';

const ORIGIN = 'https://floe.example.com';

/** Minimal `window` stand-in: the resolver only ever reads location.origin. */
function stubWindow(origin = ORIGIN) {
    vi.stubGlobal('window', { location: { origin } });
}

function stubFetchJson(body: unknown, ok = true) {
    const fetchMock = vi.fn().mockResolvedValue({
        ok,
        json: async () => body,
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

beforeEach(() => {
    resetSocketUrlCache();
    // Vitest runs with NODE_ENV=test, so the development branch is off unless a
    // test opts into it explicitly.
    vi.stubEnv('NEXT_PUBLIC_SOCKET_URL', '');
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

describe('resolveSocketUrl', () => {
    it('uses NEXT_PUBLIC_SOCKET_URL when it is set', async () => {
        vi.stubEnv('NEXT_PUBLIC_SOCKET_URL', 'https://api.floe.one');
        const fetchMock = stubFetchJson({ socketUrl: 'https://wrong.example' });
        stubWindow();

        await expect(resolveSocketUrl()).resolves.toBe('https://api.floe.one');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('treats an empty NEXT_PUBLIC_SOCKET_URL as unset', async () => {
        // This is exactly what the Docker image bakes so runtime config applies.
        stubWindow();
        const fetchMock = stubFetchJson({ socketUrl: 'https://configured.example' });

        await expect(resolveSocketUrl()).resolves.toBe('https://configured.example');
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('strips a trailing slash from the build-time value', async () => {
        vi.stubEnv('NEXT_PUBLIC_SOCKET_URL', 'https://api.floe.one/');
        stubWindow();

        await expect(resolveSocketUrl()).resolves.toBe('https://api.floe.one');
    });

    it('falls back to localhost in development without fetching', async () => {
        vi.stubEnv('NODE_ENV', 'development');
        const fetchMock = stubFetchJson({ socketUrl: 'https://configured.example' });
        stubWindow();

        await expect(resolveSocketUrl()).resolves.toBe('http://localhost:3001');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fetches /api/config with cache disabled', async () => {
        stubWindow();
        const fetchMock = stubFetchJson({ socketUrl: 'https://configured.example' });

        await resolveSocketUrl();

        expect(fetchMock).toHaveBeenCalledWith('/api/config', { cache: 'no-store' });
    });

    it('strips a trailing slash from the configured value', async () => {
        stubWindow();
        stubFetchJson({ socketUrl: 'https://configured.example/' });

        await expect(resolveSocketUrl()).resolves.toBe('https://configured.example');
    });

    it('falls back to the page origin when the configured value is empty', async () => {
        // The one-domain reverse-proxy case: the server intentionally answers ''.
        stubWindow();
        stubFetchJson({ socketUrl: '' });

        await expect(resolveSocketUrl()).resolves.toBe(ORIGIN);
    });

    it('falls back to the page origin when the fetch rejects', async () => {
        stubWindow();
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

        await expect(resolveSocketUrl()).resolves.toBe(ORIGIN);
    });

    it('falls back to the page origin on a non-ok response', async () => {
        stubWindow();
        stubFetchJson({ socketUrl: 'https://ignored.example' }, false);

        await expect(resolveSocketUrl()).resolves.toBe(ORIGIN);
    });

    it('falls back to the page origin when the response is not valid JSON', async () => {
        stubWindow();
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => {
                    throw new SyntaxError('unexpected token');
                },
            })
        );

        await expect(resolveSocketUrl()).resolves.toBe(ORIGIN);
    });

    it('never rejects, even when fetch throws synchronously', async () => {
        stubWindow();
        vi.stubGlobal(
            'fetch',
            vi.fn(() => {
                throw new Error('blocked');
            })
        );

        await expect(resolveSocketUrl()).resolves.toBe(ORIGIN);
    });

    it('caches the resolved value so a second call does not refetch', async () => {
        stubWindow();
        const fetchMock = stubFetchJson({ socketUrl: 'https://configured.example' });

        await resolveSocketUrl();
        await resolveSocketUrl();

        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('shares one in-flight request between concurrent callers', async () => {
        stubWindow();
        let release: (v: unknown) => void = () => {};
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const fetchMock = vi.fn().mockImplementation(async () => {
            await gate;
            return { ok: true, json: async () => ({ socketUrl: 'https://configured.example' }) };
        });
        vi.stubGlobal('fetch', fetchMock);

        const both = Promise.all([resolveSocketUrl(), resolveSocketUrl()]);
        release(undefined);

        expect(await both).toEqual([
            'https://configured.example',
            'https://configured.example',
        ]);
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('resolves to an empty base on the server without fetching', async () => {
        // No window during SSR and prerender. Must not throw and must not connect.
        vi.stubGlobal('window', undefined);
        const fetchMock = stubFetchJson({ socketUrl: 'https://configured.example' });

        await expect(resolveSocketUrl()).resolves.toBe('');
        expect(fetchMock).not.toHaveBeenCalled();
        // The server-side answer must not poison the browser cache.
        expect(peekSocketUrl()).toBeNull();
    });
});

describe('peekSocketUrl', () => {
    it('is null before resolution and the URL afterwards', async () => {
        stubWindow();
        stubFetchJson({ socketUrl: 'https://configured.example' });

        expect(peekSocketUrl()).toBeNull();
        await resolveSocketUrl();
        expect(peekSocketUrl()).toBe('https://configured.example');
    });
});

describe('resetSocketUrlCache', () => {
    it('forces the next call to resolve again', async () => {
        stubWindow();
        const fetchMock = stubFetchJson({ socketUrl: 'https://configured.example' });

        await resolveSocketUrl();
        resetSocketUrlCache();
        await resolveSocketUrl();

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
