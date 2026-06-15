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
    if (etaSeconds < 60) {
        return `${Math.ceil(etaSeconds)}s`;
    } else if (etaSeconds < 3600) {
        return `${Math.floor(etaSeconds / 60)}m ${Math.ceil(etaSeconds % 60)}s`;
    } else {
        return `${Math.floor(etaSeconds / 3600)}h ${Math.floor((etaSeconds % 3600) / 60)}m`;
    }
}
