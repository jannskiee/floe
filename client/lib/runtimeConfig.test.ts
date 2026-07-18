import { describe, expect, it } from 'vitest';
import { resolveSocketUrl } from './runtimeConfig';

describe('resolveSocketUrl', () => {
    it('prefers a runtime URL and removes its trailing slash', () => {
        expect(
            resolveSocketUrl({
                runtimeUrl: 'https://signal.example.com/',
                buildTimeUrl: 'https://build.example.com',
                browserOrigin: 'http://192.168.1.10:3000',
            })
        ).toBe('https://signal.example.com');
    });

    it('keeps the build-time URL for source-built images', () => {
        expect(
            resolveSocketUrl({
                buildTimeUrl: 'https://api.example.com',
                browserOrigin: 'http://192.168.1.10:3000',
            })
        ).toBe('https://api.example.com');
    });

    it('derives the paired server URL from the browser host', () => {
        expect(
            resolveSocketUrl({
                socketPort: '3101',
                browserOrigin: 'http://192.168.1.10:3000',
            })
        ).toBe('http://192.168.1.10:3101');
    });

    it('uses the local development default outside a browser', () => {
        expect(resolveSocketUrl({})).toBe('http://localhost:3001');
    });
});
