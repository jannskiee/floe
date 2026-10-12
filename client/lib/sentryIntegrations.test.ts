import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    BROWSER_SESSION_INTEGRATION,
    HTTP_INTEGRATION,
    PROCESS_SESSION_INTEGRATION,
    withoutBrowserSession,
    withoutServerSessions,
} from './sentryIntegrations';

describe('withoutBrowserSession', () => {
    const named = (...names: string[]) => names.map((name) => ({ name }));

    it('drops the session integration and keeps every other one, in order', () => {
        // Order is part of the contract: EventFilters has to stay ahead of the
        // integrations that rewrite frames, which is what denyUrls relies on
        // (see lib/browserExtensions.ts).
        const defaults = named('InboundFilters', 'EventFilters', 'BrowserSession', 'HttpContext', 'Dedupe');
        expect(withoutBrowserSession(defaults).map((i) => i.name)).toEqual([
            'InboundFilters',
            'EventFilters',
            'HttpContext',
            'Dedupe',
        ]);
    });

    it('returns the same integrations when there is no session integration to drop', () => {
        const defaults = named('EventFilters', 'HttpContext');
        expect(withoutBrowserSession(defaults)).toEqual(defaults);
        expect(withoutBrowserSession([])).toEqual([]);
    });

    it('keeps the objects themselves, not copies', () => {
        const [filters, session, http] = named('EventFilters', 'BrowserSession', 'HttpContext');
        const out = withoutBrowserSession([filters, session, http]);
        expect(out[0]).toBe(filters);
        expect(out[1]).toBe(http);
    });

    // The filter matches by name, and a name is a string the SDK is free to
    // change. If it does, the filter silently stops matching and every page
    // load sends a session record again, while the privacy page lists none.
    // This reads the name from the SDK that is actually installed, by
    // walking the dependency chain the client resolves it through.
    //
    // The explicit timeout is for the load itself. Requiring the SDK's
    // CommonJS build takes under a second alone and took 7.9 s once inside the
    // full suite on a cold disk, past vitest's 5 s default.
    it('names the session integration the installed SDK ships', () => {
        const fromHere = createRequire(import.meta.url);
        const fromNext = createRequire(fromHere.resolve('@sentry/nextjs'));
        const fromReact = createRequire(fromNext.resolve('@sentry/react'));
        const browser = fromReact('@sentry/browser') as { browserSessionIntegration: () => { name: string } };
        expect(browser.browserSessionIntegration().name).toBe(BROWSER_SESSION_INTEGRATION);
    }, 30_000);

    // The config imports the SDK and cannot load here, so its wiring is read as
    // text, as traceSampling.test.ts does. The function form matters: an array
    // is ADDED to the defaults, so `integrations: []` would leave the session
    // integration in place.
    it('sentry.client.config.ts hands it to init in the function form', () => {
        const src = readFileSync(fileURLToPath(new URL('../sentry.client.config.ts', import.meta.url)), 'utf8');
        expect(src).toMatch(/import \{ withoutBrowserSession \} from '\.\/lib\/sentryIntegrations';/);
        expect(src).toMatch(/^\s+integrations: withoutBrowserSession,$/m);
        expect(src).not.toMatch(/^\s*integrations:\s*\[/m);
    });
});

describe('withoutServerSessions', () => {
    const named = (...names: string[]) => names.map((name) => ({ name }));

    it('drops the process session and swaps the Http integration where it stood', () => {
        const replacement = { name: 'Http' };
        const defaults = named('InboundFilters', 'Http', 'NodeFetch', 'ProcessSession', 'Modules');
        const out = withoutServerSessions(defaults, () => replacement);
        expect(out.map((i) => i.name)).toEqual(['InboundFilters', 'Http', 'NodeFetch', 'Modules']);
        expect(out[1]).toBe(replacement);
        expect(out[0]).toBe(defaults[0]);
    });

    it('builds no replacement when the defaults hold no Http integration', () => {
        let built = 0;
        const out = withoutServerSessions(named('InboundFilters', 'ProcessSession'), () => {
            built += 1;
            return { name: 'Http' };
        });
        expect(out.map((i) => i.name)).toEqual(['InboundFilters']);
        expect(built).toBe(0);
    });

    // Everything below is read as text from the SDK that is installed, without
    // loading it: the Node SDK pulls in OpenTelemetry, and none of it is needed
    // to read three names and one call. If a release renames an integration or
    // changes how @sentry/nextjs builds its Http integration, these fail here
    // instead of the server quietly sending session counts again.
    const sdkFile = (pkg: 'nextjs' | 'node' | 'node-core', rel: string) => {
        const nextEntry = createRequire(import.meta.url).resolve('@sentry/nextjs');
        const nodeEntry = createRequire(nextEntry).resolve('@sentry/node');
        const coreEntry = createRequire(nodeEntry).resolve('@sentry/node-core');
        const entry = pkg === 'nextjs' ? nextEntry : pkg === 'node' ? nodeEntry : coreEntry;
        return readFileSync(join(dirname(entry), rel), 'utf8');
    };

    it('names the two integrations as the installed SDK does', () => {
        expect(sdkFile('node', 'integrations/http.js')).toContain(`const INTEGRATION_NAME = "${HTTP_INTEGRATION}";`);
        expect(sdkFile('node-core', 'integrations/processSession.js')).toContain(
            `const INTEGRATION_NAME = "${PROCESS_SESSION_INTEGRATION}";`,
        );
    });

    it('the installed SDK still reads the option that turns request sessions off', () => {
        expect(sdkFile('node', 'integrations/http.js')).toContain('sessions: options.trackIncomingRequestsAsSessions');
    });

    it('sentry.server.config.ts keeps the Http options @sentry/nextjs passes, and adds sessions off', () => {
        // What the SDK builds for itself, and replaces by name.
        const server = sdkFile('nextjs', 'server/index.js');
        expect(server).toMatch(/integration\.name !== "Http"/);
        expect(server).toMatch(/node\.httpIntegration\(\{\s*disableIncomingRequestSpans: true\s*\}\)/);

        const src = readFileSync(fileURLToPath(new URL('../sentry.server.config.ts', import.meta.url)), 'utf8');
        expect(src).toMatch(/import \{ withoutServerSessions \} from '\.\/lib\/sentryIntegrations';/);
        expect(src).toMatch(/^\s+integrations: \(defaults\) =>$/m);
        expect(src).toMatch(/Sentry\.httpIntegration\(\{\s*disableIncomingRequestSpans: true,\s*trackIncomingRequestsAsSessions: false,?\s*\}\)/);
        expect(src).not.toMatch(/^\s*integrations:\s*\[/m);
    });
});
