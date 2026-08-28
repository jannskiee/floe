import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET, dynamic } from './route';

const SHA = 'fa1eade47b73733d6312d5abfad33ce9e4068081';

beforeEach(() => {
    // The handler reads the live process on every request, so every case starts
    // from a known-empty environment whatever the machine running the suite has.
    vi.stubEnv('SOCKET_URL', undefined);
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', undefined);
    vi.stubEnv('SOURCE_COMMIT', undefined);
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('GET /api/config', () => {
    it('opts out of prerendering so the environment is read per request', () => {
        expect(dynamic).toBe('force-dynamic');
    });

    it('is never cached', () => {
        expect(GET().headers.get('Cache-Control')).toBe('no-store');
    });

    it('answers an empty socketUrl and a null commit when nothing is set', async () => {
        await expect(GET().json()).resolves.toEqual({ socketUrl: '', commit: null });
    });

    it('serves SOCKET_URL as socketUrl', async () => {
        vi.stubEnv('SOCKET_URL', 'https://api.example.com');
        const body = await GET().json();
        expect(body.socketUrl).toBe('https://api.example.com');
    });

    it('reports the Vercel commit SHA as commit', async () => {
        vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA);
        const body = await GET().json();
        expect(body.commit).toBe(SHA);
    });

    it('falls back to SOURCE_COMMIT for a self-hosted build', async () => {
        vi.stubEnv('SOURCE_COMMIT', 'abc1234');
        const body = await GET().json();
        expect(body.commit).toBe('abc1234');
    });

    it('prefers the Vercel SHA when both are set', async () => {
        vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA);
        vi.stubEnv('SOURCE_COMMIT', 'abc1234');
        const body = await GET().json();
        expect(body.commit).toBe(SHA);
    });

    it('treats an empty value as unset rather than reporting ""', async () => {
        // Compose and shells produce empty strings readily; unknown must stay null.
        vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
        vi.stubEnv('SOURCE_COMMIT', '');
        const body = await GET().json();
        expect(body.commit).toBeNull();
    });

    it('keeps the response to exactly the documented keys', async () => {
        vi.stubEnv('SOCKET_URL', 'https://api.example.com');
        vi.stubEnv('VERCEL_GIT_COMMIT_SHA', SHA);
        await expect(GET().json()).resolves.toEqual({
            socketUrl: 'https://api.example.com',
            commit: SHA,
        });
    });
});
