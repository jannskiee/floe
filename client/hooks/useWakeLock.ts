import { useRef, useCallback } from 'react';

/**
 * Manages the Screen Wake Lock API to prevent the screen from dimming
 * or locking while a file transfer is in progress.
 *
 * requestWakeLock — acquires the lock (no-op if already held or not supported)
 * releaseWakeLock — releases the lock (no-op if not held)
 *
 * Both functions are stable (useCallback with empty deps) so they are safe
 * to include in useEffect dependency arrays.
 */
export function useWakeLock() {
    const wakeLockRef = useRef<WakeLockSentinel | null>(null);

    const requestWakeLock = useCallback(async () => {
        if ('wakeLock' in navigator && document.visibilityState === 'visible') {
            try {
                const sentinel = await navigator.wakeLock.request('screen');
                wakeLockRef.current = sentinel;
                // The browser releases a screen lock by itself whenever the
                // tab is hidden. Clearing the ref on that release is what lets
                // a later re-acquire (the request link page does one on
                // becoming visible) see there is no lock to keep. Only this
                // sentinel's own release clears it, so a newer lock is never
                // forgotten.
                sentinel.addEventListener('release', () => {
                    if (wakeLockRef.current === sentinel) wakeLockRef.current = null;
                });
            } catch {
                // Silently ignore — wake lock is best-effort
            }
        }
    }, []);

    const releaseWakeLock = useCallback(() => {
        if (wakeLockRef.current) {
            wakeLockRef.current.release().catch(() => { });
            wakeLockRef.current = null;
        }
    }, []);

    return { requestWakeLock, releaseWakeLock };
}
