import { useState, useRef, useEffect } from 'react';
import { peekSocketUrl, resolveSocketUrl } from '@/lib/socketUrl';

interface UmamiWindow extends Window {
    umami?: {
        track: (event: string, data?: Record<string, unknown>) => void;
    };
}

// Read synchronously during the first render so state never disagrees with
// storage: a default-true state plus a read-in-effect opens a window where the
// persist effect writes 'true' over a stored 'false' opt-out (lost if the page
// unloads before the corrective re-render).
function readInitialReportStats(): boolean {
    if (typeof window === 'undefined') return true;
    try {
        return localStorage.getItem('floe:report-stats') !== 'false';
    } catch {
        return true;
    }
}

export function useTransferAnalytics() {
    const [reportStatsEnabled, setReportStatsEnabled] = useState(readInitialReportStats);
    const reportStatsEnabledRef = useRef(reportStatsEnabled);

    useEffect(() => {
        reportStatsEnabledRef.current = reportStatsEnabled;
        try {
            localStorage.setItem('floe:report-stats', String(reportStatsEnabled));
        } catch { }
    }, [reportStatsEnabled]);

    const track = (event: string, data?: Record<string, unknown>) => {
        if (typeof window === 'undefined') return;
        (window as UmamiWindow).umami?.track(event, data);
    };

    const reportBytes = (bytes: number) => {
        if (!reportStatsEnabledRef.current) return;

        const send = (socketUrl: string) => {
            fetch(`${socketUrl}/api/stats/report`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bytes }),
                keepalive: true,
            }).catch(() => {});
        };

        // Prefer the synchronous path: this can fire while the page is being torn
        // down, and `keepalive` only survives that if the request is issued in the
        // current task. By the time any bytes exist to report the socket has long
        // since connected, so the cache is warm and the async branch is a
        // formality.
        const cached = peekSocketUrl();
        if (cached !== null) send(cached);
        else void resolveSocketUrl().then(send);

        window.dispatchEvent(
            new CustomEvent('floe:bytes-reported', { detail: { bytes } })
        );
    };

    return { reportStatsEnabled, setReportStatsEnabled, track, reportBytes };
}
