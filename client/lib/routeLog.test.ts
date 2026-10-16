import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createRouteLog, routeLabel } from './routeLog';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('the route log', () => {
    it('knows nothing about a connection it has no reading for', () => {
        const log = createRouteLog();
        expect(log.of({})).toBeNull();
        expect(routeLabel(log.of({}))).toBe('unknown');
    });

    it('keeps the latest reading of each connection, apart', () => {
        const log = createRouteLog();
        const first = {};
        const second = {};
        log.record(first, 'direct');
        log.record(second, 'relay');
        log.record(first, 'relay');
        expect(log.of(first)).toBe('relay');
        expect(log.of(second)).toBe('relay');
        expect(routeLabel(log.of(first))).toBe('relay');
    });

    it('never forgets a reading for a null one, so a closed connection keeps its route', () => {
        const log = createRouteLog();
        const peer = {};
        log.record(peer, 'direct');
        log.record(peer, null);
        expect(log.of(peer)).toBe('direct');
    });
});

// The page reads the route of the connection a report is about, by that
// connection, and never from the badge's state. The badge goes back to null
// at every close, and a receive whose sender had already closed (a Go sender
// closes about 50 ms after its last end frame, while the page may still be
// checking that file's SHA-256) read that null and was recorded "unknown".
// Read as text: the component is mounted by no unit test.
describe('the transfer page reports the route by connection', () => {
    const page = read('../components/P2PTransfer.tsx');

    it('reads it for every analytics event and error report', () => {
        expect(page).not.toContain('connectionTypeRef');
        expect(page.match(/connection: routeLabel\(routeOf\(peer\)\)/g)).toHaveLength(2);
        expect(page.match(/connectionType: routeOf\(peer\)/g)).toHaveLength(2);
        expect(page).toContain('connectionType: routeLabel(routeOf(peer)),');
    });

    it('records each reading against the connection it came from', () => {
        const hook = read('../hooks/useConnectionType.ts');
        expect(hook).toContain('routes.record(peer, next);');
        expect(hook).toContain('routeOf: routes.of');
    });
});
