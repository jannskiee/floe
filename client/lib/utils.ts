import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

// unitIndex is the shared guard both formatters were missing one half of.
// Math.log of a negative is NaN, and both sizes[NaN] and
// sizes[Math.min(NaN, 4)] are undefined, so formatBytes(-1) printed
// "NaN undefined" and splitBytes(-1) returned an undefined unit. The top
// clamp matters too: formatBytes(1024**5) printed "1 undefined".
// cli/engine/transfer/format.go carries the post-mortem for the same bug.
const BYTE_UNITS = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
const unitIndex = (bytes: number) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return 0;
    return Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
};

export const formatBytes = (bytes: number) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 Bytes';
    const i = unitIndex(bytes);
    return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + ' ' + BYTE_UNITS[i];
};

// splitBytes returns the numeric value and unit separately so NumberFlow can
// animate the number while keeping the unit stable as a suffix.
export const splitBytes = (bytes: number): { value: number; unit: string } => {
    if (!Number.isFinite(bytes) || bytes <= 0) return { value: 0, unit: 'Bytes' };
    const i = unitIndex(bytes);
    return {
        value: parseFloat((bytes / Math.pow(1024, i)).toFixed(2)),
        unit: BYTE_UNITS[i],
    };
};