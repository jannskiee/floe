/**
 * Pure utility functions for transfer speed and ETA formatting.
 * Extracted from P2PTransfer.tsx to avoid duplication between sender and receiver.
 */

export function formatSpeed(bytesPerSec: number): string {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '';
    return bytesPerSec >= 1024 * 1024
        ? `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`
        : `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
}

export function formatETA(etaSeconds: number): string {
    if (!Number.isFinite(etaSeconds) || etaSeconds < 0) return '';
    // Round to whole seconds FIRST. Applying Math.ceil to the remainder
    // instead let it reach 60, so 119.5s printed "1m 60s" and 59.9s printed
    // "60s". The Go twin truncates and never had either.
    const s = Math.ceil(etaSeconds);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
