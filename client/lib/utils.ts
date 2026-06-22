import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

// splitBytes returns the numeric value and unit separately so NumberFlow can
// animate the number while keeping the unit stable as a suffix.
export const splitBytes = (bytes: number): { value: number; unit: string } => {
    if (bytes === 0) return { value: 0, unit: 'Bytes' };
    const k = 1024;
    const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
    return {
        value: parseFloat((bytes / Math.pow(k, i)).toFixed(2)),
        unit: units[i],
    };
};