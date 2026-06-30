import { useState, useRef, useEffect } from 'react';

interface UmamiWindow extends Window {
    umami?: {
        track: (event: string, data?: Record<string, unknown>) => void;
    };
}

export function useTransferAnalytics() {
    const [reportStatsEnabled, setReportStatsEnabled] = useState(true);
    const reportStatsEnabledRef = useRef(true);

    useEffect(() => {
        try {
            const stored = localStorage.getItem('floe:report-stats');
            if (stored !== null) {
                const val = stored !== 'false';
                // eslint-disable-next-line react-hooks/set-state-in-effect
                setReportStatsEnabled(val);
                reportStatsEnabledRef.current = val;
            }
        } catch { }
    }, []);

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
        const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:3001';
        fetch(`${socketUrl}/api/stats/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bytes }),
            keepalive: true,
        }).catch(() => {});
        window.dispatchEvent(
            new CustomEvent('floe:bytes-reported', { detail: { bytes } })
        );
    };

    return { reportStatsEnabled, setReportStatsEnabled, track, reportBytes };
}
