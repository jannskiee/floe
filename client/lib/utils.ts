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

// The NumberFlow options GlobalStats animates the global counter with. Shared
// so components/AnimatedByteCount.tsx can format its static fallback with the
// same settings instead of a second copy that could drift.
//
// Left to inference rather than annotated Intl.NumberFormatOptions, because
// @number-flow/react's own `Format` type is a NARROWER subset of it (its
// `notation` admits only 'standard' and 'compact'), and the wider annotation is
// not assignable to the prop. The literal type satisfies both.
export const BYTE_COUNT_FORMAT = {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
} as const;

// The exact string NumberFlow paints for a splitBytes() pair.
//
// `undefined` locales rather than 'en-US': GlobalStats passes NumberFlow no
// `locales` prop, so it builds Intl.NumberFormat(undefined, format) and
// resolves the runtime default. The fallback has to resolve the same one.
// toFixed() would not do: splitBytes(1181116006).value is 1.1, and only
// minimumFractionDigits pads that back to the "1.10" NumberFlow shows.
export const formatSplitBytes = ({ value, unit }: { value: number; unit: string }): string =>
    `${value.toLocaleString(undefined, BYTE_COUNT_FORMAT)} ${unit}`;