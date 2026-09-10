'use client';

import React, { useState, useEffect } from 'react';
import { AnimatedByteCount } from '@/components/AnimatedByteCount';
import { splitBytes } from '@/lib/utils';
import { resolveSocketUrl } from '@/lib/socketUrl';

export function GlobalStats() {
    const [totalBytes, setTotalBytes] = useState<number | null>(null);

    useEffect(() => {
        const fetchStats = async () => {
            try {
                // Cached after the first call, so the 10s poll costs nothing extra.
                const socketUrl = await resolveSocketUrl();
                const res = await fetch(`${socketUrl}/api/stats`);
                if (!res.ok) return;
                const { totalBytes: raw } = await res.json();
                const n = Number(raw) || 0;
                setTotalBytes((prev) => (prev === null ? n : Math.max(prev, n)));
            } catch {
                // Server unreachable — keep current display
            }
        };

        fetchStats();
        const interval = setInterval(fetchStats, 10_000);

        const handleBytesReported = (e: Event) => {
            const bytes = (e as CustomEvent<{ bytes: number }>).detail?.bytes;
            if (typeof bytes === 'number' && bytes > 0) {
                setTotalBytes((prev) => (prev ?? 0) + bytes);
            }
        };
        window.addEventListener('floe:bytes-reported', handleBytesReported);

        return () => {
            clearInterval(interval);
            window.removeEventListener('floe:bytes-reported', handleBytesReported);
        };
    }, []);

    // Render at 0 until loaded so NumberFlow rolls up from 0 on every refresh
    // (it only animates on value *changes* after mount, not on its first paint).
    const { value, unit } = splitBytes(totalBytes ?? 0);

    return (
        <div className="mt-6 mb-2 flex items-center justify-center gap-2 text-sm select-none">
            <AnimatedByteCount
                value={value}
                unit={unit}
                className="font-mono font-medium text-zinc-300 tabular-nums"
            />
            <span className="text-zinc-600">transferred globally</span>
        </div>
    );
}
