/**
 * The frontend ships in a public repository. Nothing in it may name a
 * machine's local paths or the build's private planning folders: the approved
 * copy check reads its table from FLOE_APPROVED_COPY instead (review F1).
 *
 * The needles are assembled from pieces so this file does not match itself.
 */
import {describe, expect, it} from 'vitest';

const sources = import.meta.glob(['../**/*.{ts,tsx}', '!../**/node_modules/**'], {query: '?raw', import: 'default', eager: true}) as Record<string, string>;

const NEEDLES = [
    ['Users', 'Admin'].join('/'),
    ['.claude', 'plans'].join('/'),
    ['floe', 'portal'].join('-'),
    ['16', 'design'].join('-'),
];

describe('the repository sources', () => {
    it('no source file names a private local path or the plan folder', () => {
        expect(Object.keys(sources).length).toBeGreaterThan(20);
        const hits: string[] = [];
        for (const [file, text] of Object.entries(sources)) {
            for (const n of NEEDLES) if (text.includes(n)) hits.push(`${file}: ${n}`);
        }
        expect(hits).toEqual([]);
    });
});
