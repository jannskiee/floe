/**
 * Pure utility functions for transfer speed and ETA formatting, shared by the
 * sender and receiver progress displays.
 *
 * Two twins mirror these: formatSpeed and formatDuration in
 * cli/engine/transfer/format.go, and fmtSpeed and fmtEta in
 * desktop/frontend/src/progress.ts. Keep the three in sync.
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
    // "60s". formatDuration in format.go truncates and never had either;
    // fmtEta in progress.ts rounds up exactly like this. Keep Math.ceil: the
    // 60-second carry test in transferUtils.test.ts pins it.
    const s = Math.ceil(etaSeconds);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
