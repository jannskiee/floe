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
                wakeLockRef.current = await navigator.wakeLock.request('screen');
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
