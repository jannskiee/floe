/**
 * Every Windows notification goes through Go's notify, which applies Show
 * notifications, Play sound and the in-front rule, and pins the text to the
 * fixed table (H7 S-11 to S-13). The page could skip all of that: the Wails
 * runtime it loads exposes SendNotification and its siblings, which go
 * straight to go-toast (R-OPUS-1 OP-2). So no app source may name a Wails
 * notification function, read window.runtime, or use the web Notification
 * API. The names are read from the generated runtime.d.ts, so a function a
 * later Wails adds is covered without editing this list.
 */
import {describe, expect, it} from 'vitest';

const sources = import.meta.glob(['../**/*.{ts,tsx}', '!../**/node_modules/**'], {query: '?raw', import: 'default', eager: true}) as Record<string, string>;
const runtimeTypes = Object.values(import.meta.glob('../../wailsjs/runtime/runtime.d.ts', {query: '?raw', import: 'default', eager: true}) as Record<string, string>)[0] ?? '';

const wailsNames = [...runtimeTypes.matchAll(/export function (\w*Notification\w*)/g)].map((m) => m[1]);
const PATTERNS: Array<[string, RegExp]> = [
    ...wailsNames.map((n): [string, RegExp] => [n, new RegExp(`\\b${n}\\b`)]),
    ['window.runtime', /\bwindow\s*\.\s*runtime\b/],
    ['web Notification API', /\bnew\s+Notification\s*\(|\bNotification\s*\.\s*(requestPermission|permission)\b/],
];

describe('the app sources', () => {
    it('never reach a Windows notification except through Go (OP-2)', () => {
        expect(wailsNames).toContain('SendNotification');
        expect(wailsNames.length).toBeGreaterThan(5);
        // Test files and this folder (the glob keys it ./; setup.ts stubs window.runtime) are not app sources.
        const app = Object.entries(sources).filter(([file]) => !/\.test\.tsx?$/.test(file) && !file.startsWith('./') && !file.includes('/test/'));
        expect(app.length).toBeGreaterThan(20);
        const hits: string[] = [];
        for (const [file, text] of app) {
            for (const [name, re] of PATTERNS) if (re.test(text)) hits.push(`${file}: ${name}`);
        }
        expect(hits).toEqual([]);
    });
});
