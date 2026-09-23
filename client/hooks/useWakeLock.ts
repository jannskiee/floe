import { useCallback, useState } from 'react';
import { createWakeLockHolder } from '@/lib/wakeLock';

/**
 * Manages the Screen Wake Lock API to prevent the screen from dimming
 * or locking while a file transfer is in progress.
 *
 * requestWakeLock: acquires the lock (no-op if already held, if the page is
 * not visible, or if the API is missing)
 * releaseWakeLock: releases the lock, including one still being requested
 *
 * Both functions are stable, so they are safe to include in useEffect
 * dependency arrays. The bookkeeping, and the two races it closes (a release
 * while the request is pending, and the browser's own release while the tab
 * is hidden), live in lib/wakeLock.ts with tests. Best effort throughout.
 */
export function useWakeLock() {
    const [holder] = useState(() =>
        createWakeLockHolder({
            request: () => navigator.wakeLock.request('screen'),
            canRequest: () =>
                typeof navigator !== 'undefined' &&
                'wakeLock' in navigator &&
                document.visibilityState === 'visible',
        })
    );

    const requestWakeLock = useCallback(() => holder.acquire(), [holder]);
    const releaseWakeLock = useCallback(() => holder.release(), [holder]);

    return { requestWakeLock, releaseWakeLock };
}
