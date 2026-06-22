'use client';

import React, { useState, useEffect } from 'react';
import NumberFlow, { continuous } from '@number-flow/react';
import { splitBytes } from '@/lib/utils';

export function GlobalStats() {
    const [totalBytes, setTotalBytes] = useState<number | null>(null);

    useEffect(() => {
        const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:3001';

        const fetchStats = async () => {
            try {
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

    const { value, unit } = splitBytes(totalBytes ?? 0);

    return (
        <div className="mt-6 mb-2 w-full max-w-sm mx-auto">
            <div className="flex flex-col items-center gap-2 px-6 py-4 rounded-2xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-sm">
                <p className="text-[10px] text-zinc-600 uppercase tracking-[0.2em] font-medium select-none">
                    Transferred globally
                </p>
                {totalBytes === null ? (
                    <div className="h-8 w-40 rounded-lg bg-white/5 animate-pulse" />
                ) : (
                    <NumberFlow
                        value={value}
                        format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }}
                        suffix={' ' + unit}
                        plugins={[continuous]}
                        className="text-[1.75rem] leading-none font-mono font-semibold text-white tracking-tight tabular-nums"
                    />
                )}
                <p className="text-[10px] text-zinc-700 select-none">
                    across all users, all time
                </p>
            </div>
        </div>
    );
}
