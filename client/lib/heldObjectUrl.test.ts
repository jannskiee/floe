import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdObjectUrl } from './heldObjectUrl';

function fakeUrls() {
    let n = 0;
    const live = new Set<string>();
    const revoked: string[] = [];
    return {
        live,
        revoked,
        api: {
            create: () => {
                const url = `blob:test/${++n}`;
                live.add(url);
                return url;
            },
            revoke: (url: string) => {
                live.delete(url);
                revoked.push(url);
            },
        },
    };
}

describe('holdObjectUrl', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps the URL through the hold and revokes it when the hold runs out', () => {
        const urls = fakeUrls();
        const held = holdObjectUrl(60_000, urls.api);
        const url = held.hold(new Blob(['zip']));
        // The click that starts the download returns before the browser
        // opens it: nothing may be revoked then.
        vi.advanceTimersByTime(59_999);
        expect(urls.live.has(url)).toBe(true);
        expect(urls.revoked).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(urls.revoked).toEqual([url]);
        expect(urls.live.size).toBe(0);
    });

    it('revokes the previous URL when the next one replaces it, and only once', () => {
        const urls = fakeUrls();
        const held = holdObjectUrl(60_000, urls.api);
        const first = held.hold(new Blob(['a']));
        vi.advanceTimersByTime(10_000);
        const second = held.hold(new Blob(['b']));
        expect(urls.revoked).toEqual([first]);
        expect(urls.live.has(second)).toBe(true);
        // The first URL's timer is gone: the second keeps its own full hold.
        vi.advanceTimersByTime(59_999);
        expect(urls.revoked).toEqual([first]);
        vi.advanceTimersByTime(1);
        expect(urls.revoked).toEqual([first, second]);
    });

    it('revokes at once on release, and a release with nothing held does nothing', () => {
        const urls = fakeUrls();
        const held = holdObjectUrl(60_000, urls.api);
        held.release();
        expect(urls.revoked).toEqual([]);
        const url = held.hold(new Blob(['zip']));
        held.release();
        expect(urls.revoked).toEqual([url]);
        vi.advanceTimersByTime(60_000);
        expect(urls.revoked).toEqual([url]);
    });
});
