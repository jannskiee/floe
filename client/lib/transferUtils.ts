/**
 * Pure utility functions for transfer speed and ETA formatting.
 * Extracted from P2PTransfer.tsx to avoid duplication between sender and receiver.
 */

/**
 * Formats a bytes-per-second value into a human-readable string.
 * e.g. 2097152 → "2.0 MB/s", 512000 → "500.0 KB/s"
 */
export function formatSpeed(bytesPerSec: number): string {
    return bytesPerSec >= 1024 * 1024
        ? `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`
        : `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
}

/**
 * Formats an ETA in seconds into a human-readable string.
 * e.g. 45 → "45s", 90 → "1m 30s", 3700 → "1h 1m"
 */
export function formatETA(etaSeconds: number): string {
    if (etaSeconds < 60) {
        return `${Math.ceil(etaSeconds)}s`;
    } else if (etaSeconds < 3600) {
        return `${Math.floor(etaSeconds / 60)}m ${Math.ceil(etaSeconds % 60)}s`;
    } else {
        return `${Math.floor(etaSeconds / 3600)}h ${Math.floor((etaSeconds % 3600) / 60)}m`;
    }
}
