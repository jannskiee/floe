import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reportableBytes } from './statsReport';

// The server takes a report only when it is a positive whole number
// (validateReportBytes in server/stats.js) and answers 400 otherwise, after
// its limiter has already counted the request. A transfer made only of empty
// files finishes with a total of 0, and the page posted that 0 every time.
describe('reportableBytes', () => {
    it('is true for a positive whole number of bytes', () => {
        for (const bytes of [1, 1500, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
            expect(reportableBytes(bytes), String(bytes)).toBe(true);
        }
    });

    it('is false for zero, the total of a transfer of only empty files', () => {
        expect(reportableBytes(0)).toBe(false);
    });

    it('is false for anything the server would refuse as not a count', () => {
        for (const bytes of [-1, 0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
            expect(reportableBytes(bytes), String(bytes)).toBe(false);
        }
    });

    it('stands before both the request and the optimistic count on the page', () => {
        const hook = readFileSync(fileURLToPath(new URL('../hooks/useTransferAnalytics.ts', import.meta.url)), 'utf8');
        const body = hook.slice(hook.indexOf('const reportBytes'));
        const guard = body.indexOf('reportableBytes(bytes)');
        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(body.indexOf('/api/stats/report'));
        expect(guard).toBeLessThan(body.indexOf('floe:bytes-reported'));
    });
});
