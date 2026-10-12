import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BROWSER_SESSION_INTEGRATION, withoutBrowserSession } from './sentryIntegrations';

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
