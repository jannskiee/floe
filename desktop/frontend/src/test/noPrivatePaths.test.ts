/**
 * The frontend ships in a public repository. Nothing in it may name a
 * machine's local paths or the build's private planning folders: the approved
 * copy check reads its table from FLOE_APPROVED_COPY instead (review F1).
 *
 * The needles are assembled from pieces so this file does not match itself,
 * and match either separator in any case: a Windows path in a string literal
 * is written with doubled backslashes, which a forward-slash needle never saw
 * (deep QA A6-04).
 */
import {describe, expect, it} from 'vitest';

const sources = import.meta.glob(['../**/*.{ts,tsx}', '!../**/node_modules/**'], {query: '?raw', import: 'default', eager: true}) as Record<string, string>;

// One or more slashes or backslashes, spelled without a backslash in this file.
const BACKSLASH = String.fromCharCode(92);
const SEP = `[${BACKSLASH}${BACKSLASH}/]+`;
const NEEDLES = [
    new RegExp(['Users', 'Admin'].join(SEP), 'i'),
    new RegExp([`${BACKSLASH}.claude`, 'plans'].join(SEP), 'i'),
    new RegExp(['floe', 'portal'].join('-'), 'i'),
    new RegExp(['16', 'design'].join('-'), 'i'),
];

describe('the repository sources', () => {
    it('no source file names a private local path or the plan folder', () => {
        expect(Object.keys(sources).length).toBeGreaterThan(20);
        const hits: string[] = [];
        for (const [file, text] of Object.entries(sources)) {
            for (const n of NEEDLES) if (n.test(text)) hits.push(`${file}: ${n}`);
        }
        expect(hits).toEqual([]);
    });

    it('a needle matches either separator in any case', () => {
        const p = ['C:', 'users', 'admin', 'x'];
        for (const sep of ['/', BACKSLASH, BACKSLASH + BACKSLASH]) {
            expect(NEEDLES[0].test(p.join(sep)), JSON.stringify(sep)).toBe(true);
        }
        expect(NEEDLES[1].test(['', '.Claude', 'Plans'].join(BACKSLASH + BACKSLASH))).toBe(true);
        expect(NEEDLES[1].test('xclaude/plans')).toBe(false);
    });
});
