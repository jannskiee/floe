import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withoutLocation, type LocationBearing } from './noLocation';

// An event as a send hook sees it: whatever fields, and maybe a user.
type Report = LocationBearing & Record<string, unknown>;

describe('withoutLocation', () => {
    it('gives a report that names no user an empty location', () => {
        const event: Report = { type: 'transaction', transaction: '/' };
        expect(withoutLocation(event)).toEqual({ type: 'transaction', transaction: '/', user: { geo: {} } });
    });

    it('keeps whatever else the user field holds', () => {
        const event: Report = { user: { id: 'abc', segment: 'beta' } };
        expect(withoutLocation(event).user).toEqual({ id: 'abc', segment: 'beta', geo: {} });
    });

    it('empties a location that is already there', () => {
        const event: Report = { user: { geo: { country_code: 'ZZ', region: 'Somewhere', city: 'Anytown' } } };
        expect(withoutLocation(event).user).toEqual({ geo: {} });
    });

    // In place, like stripDeviceHints: a send hook returns what it was given.
    it('edits the event in place and returns the same one', () => {
        const event: Report = { message: 'boom' };
        expect(withoutLocation(event)).toBe(event);
        expect(event.user).toEqual({ geo: {} });
    });

    it('is idempotent', () => {
        const once = withoutLocation<Report>({ user: { id: 'abc' } });
        expect(withoutLocation(structuredClone(once))).toEqual(once);
    });

    // What Sentry's servers test is that the field is there when the report
    // arrives, so the empty object has to survive serialization.
    it('leaves an empty object that reaches the wire', () => {
        expect(JSON.stringify(withoutLocation({}))).toBe('{"user":{"geo":{}}}');
    });

    // A send hook that throws does not just lose its report: the SDK reports
    // the throw as an error of its own, and that one skips beforeSend.
    it('never throws, whatever it is handed', () => {
        const odd: unknown[] = [
            null,
            undefined,
            3,
            'event',
            Object.freeze({}),
            Object.freeze({ user: Object.freeze({ id: 'abc' }) }),
            { user: null },
            { user: 'someone' },
            {
                get user(): never {
                    throw new Error('no');
                },
            },
        ];
        for (const item of odd) expect(() => withoutLocation(item as never)).not.toThrow();
        // What cannot be changed comes back as it was.
        const frozen: Report = Object.freeze({ message: 'boom' });
        expect(withoutLocation(frozen)).toBe(frozen);
        expect(frozen).toEqual({ message: 'boom' });
    });

    it('replaces a user field that is not an object', () => {
        expect(withoutLocation<Report>({ user: null }).user).toEqual({ geo: {} });
    });
});

// The config imports the SDK and cannot load here, so its wiring is read as
// text, as deviceHints.test.ts does. Both hooks: an error leaves through
// beforeSend and a traced page load through beforeSendTransaction, and
// neither passes through the other.
describe('sentry.client.config.ts', () => {
    // Split on either line ending: a Windows checkout has CRLF, and the error
    // hook is cut out of the file by line.
    const lines = readFileSync(fileURLToPath(new URL('../sentry.client.config.ts', import.meta.url)), 'utf8').split(/\r?\n/);

    it('imports the function', () => {
        expect(lines).toContain("import { withoutLocation } from './lib/noLocation';");
    });

    it('ends the error hook in it, after the budget has had its say', () => {
        const start = lines.indexOf('    beforeSend(event, hint) {');
        expect(start, 'beforeSend was not found').toBeGreaterThan(-1);
        const end = lines.indexOf('    },', start);
        expect(end, 'the end of beforeSend was not found').toBeGreaterThan(start);
        const hook = lines
            .slice(start + 1, end)
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('//'));
        expect(hook[hook.length - 1]).toBe('return withoutLocation(scrubbed);');
        // No other way out of the hook hands back an event.
        const returned = [...hook.join('\n').matchAll(/\breturn ([^;]+);/g)].map((m) => m[1]);
        expect(returned.filter((r) => r !== 'null')).toEqual(['withoutLocation(scrubbed)']);
    });

    it('ends the transaction hook in it, outside the scrub and the hint strip', () => {
        expect(lines).toContain('        return withoutLocation(stripDeviceHints(scrubTransactionEvent(event)));');
    });
});

// The server and the edge runtime send reports too. Theirs arrive from the
// hosting provider's address, so a location on one is a data center's and
// names no visitor (measured in Sentry on 2026-10-13: every server span since
// the browser change held the same city). They leave empty all the same, so
// that a location anywhere in the project is a regression to look into and
// never a judgment call about whose it is.
for (const config of ['sentry.server.config.ts', 'sentry.edge.config.ts']) {
    describe(config, () => {
        const lines = readFileSync(fileURLToPath(new URL(`../${config}`, import.meta.url)), 'utf8').split(/\r?\n/);

        it('imports the function', () => {
            expect(lines).toContain("import { withoutLocation } from './lib/noLocation';");
        });

        it('ends both hooks in it, outside the scrub', () => {
            expect(lines).toContain('        return withoutLocation(scrubServerErrorEvent(event));');
            expect(lines).toContain('        return withoutLocation(scrubServerTransactionEvent(event));');
            // Neither hook has another way out.
            const returned = lines.map((l) => l.trim()).filter((l) => l.startsWith('return '));
            expect(returned).toEqual([
                'return withoutLocation(scrubServerErrorEvent(event));',
                'return withoutLocation(scrubServerTransactionEvent(event));',
            ]);
        });
    });
}
