import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    BROWSER_SESSION_INTEGRATION,
    HTTP_INTEGRATION,
    PROCESS_SESSION_INTEGRATION,
    BROWSER_TRACING_INTEGRATION,
    withoutBrowserSession,
    withoutInteractionSpans,
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
        expect(src).toContain("import { withoutBrowserSession, withoutInteractionSpans } from './lib/sentryIntegrations';");
        expect(src).toContain('    integrations: (defaults) =>');
        expect(src).toContain('withoutInteractionSpans(withoutBrowserSession(defaults), () =>');
        expect(src).not.toContain('integrations: [');
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

// Not an integration, but the same kind of default: with sendClientReports on,
// the SDK counts every event it decides not to send (an unsampled trace, a
// filtered error, a request made outside a trace) and posts the counts to
// Sentry, from the browser each time the tab is hidden and from the server
// once a minute. That reached Sentry from nearly every visit, where the
// privacy page describes errors and a 10% sample of traces, so it is off in
// all three configs. Read as text, for the reason given above.
describe('client reports are off', () => {
    const config = (name: string) => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');

    const installed = (pkg: 'core' | 'browser' | 'node-core' | 'vercel-edge', rel: string) => {
        const fromNext = createRequire(createRequire(import.meta.url).resolve('@sentry/nextjs'));
        const entry =
            pkg === 'browser'
                ? createRequire(fromNext.resolve('@sentry/react')).resolve('@sentry/browser')
                : pkg === 'node-core'
                  ? createRequire(fromNext.resolve('@sentry/node')).resolve('@sentry/node-core')
                  : fromNext.resolve(`@sentry/${pkg}`);
        return readFileSync(join(dirname(entry), rel), 'utf8');
    };

    it.each(['sentry.client.config.ts', 'sentry.server.config.ts', 'sentry.edge.config.ts'])('%s sets the option to false', (name) => {
        expect(config(name)).toMatch(/^\s+sendClientReports: false,$/m);
    });

    // If a release renames the option or stops reading it where it is read
    // today, the three lines above would go on passing while the counts came
    // back. Each runtime's gate is pinned to the installed SDK instead.
    it('the installed SDK still records a dropped event only when the option is set', () => {
        expect(installed('core', 'client.js')).toContain('if (this._options.sendClientReports) {');
    });

    it('the installed browser SDK still defaults it to true and flushes only when it is set', () => {
        const browser = installed('browser', 'client.js');
        expect(browser).toContain('sendClientReports: true,');
        expect(browser).toContain('const { sendClientReports } = this._options;');
        expect(browser).toContain('if (sendClientReports) {');
    });

    it('the installed Node SDK still keeps an explicit false, and starts its flush timer only when it is set', () => {
        expect(installed('node-core', 'sdk/index.js')).toContain('sendClientReports: options.sendClientReports ?? true,');
        const client = installed('node-core', 'sdk/client.js');
        expect(client).toContain('if (this.getOptions().sendClientReports) {');
        expect(client).toContain('if (clientOptions.sendClientReports) {');
    });

    it('the installed edge SDK still flushes only when it is set', () => {
        expect(installed('vercel-edge', 'index.js')).toContain('if (this.getOptions().sendClientReports) {');
    });
});

// Interaction timings (INP) are the one thing the browser SDK sends on its
// own, outside any page-load trace: a "standalone span" per timed click or key
// press. Sentry's servers store the address such a span arrives from as
// client.address, whatever sendDefaultPii says, which they do not do for an
// error report or a page-load trace. Measured in Sentry on 2026-10-12: all 24
// stored interaction spans of the last 30 days held one. So the tracing
// integration is rebuilt with them off, and nothing standalone leaves the page.
describe('withoutInteractionSpans', () => {
    const named = (...names: string[]) => names.map((name) => ({ name }));
    const config = () => readFileSync(fileURLToPath(new URL('../sentry.client.config.ts', import.meta.url)), 'utf8');
    const sdk = (pkg: 'browser' | 'nextjs', rel: string) => {
        const nextEntry = createRequire(import.meta.url).resolve('@sentry/nextjs');
        const entry =
            pkg === 'nextjs'
                ? nextEntry
                : createRequire(createRequire(nextEntry).resolve('@sentry/react')).resolve('@sentry/browser');
        return readFileSync(join(dirname(entry), rel), 'utf8');
    };

    it('puts the rebuilt tracing integration where the default one stood', () => {
        const rebuilt = { name: 'BrowserTracing' };
        const defaults = named('EventFilters', 'HttpContext', 'BrowserTracing', 'Dedupe');
        const out = withoutInteractionSpans(defaults, () => rebuilt);
        expect(out.map((i) => i.name)).toEqual(['EventFilters', 'HttpContext', 'BrowserTracing', 'Dedupe']);
        expect(out[2]).toBe(rebuilt);
        expect(out[0]).toBe(defaults[0]);
    });

    it('builds nothing when the defaults hold no tracing integration', () => {
        let built = 0;
        const defaults = named('EventFilters', 'HttpContext');
        const out = withoutInteractionSpans(defaults, () => {
            built += 1;
            return { name: 'BrowserTracing' };
        });
        expect(out).toEqual(defaults);
        expect(built).toBe(0);
    });

    it('names the tracing integration as the installed SDK does', () => {
        expect(sdk('browser', 'tracing/browserTracingIntegration.js')).toContain(
            'const BROWSER_TRACING_INTEGRATION_ID = "' + BROWSER_TRACING_INTEGRATION + '";'
        );
    });

    // On by default, and off only through this option: if a release renames it
    // or stops reading it here, the config line below would go on passing while
    // the spans, and the addresses, came back.
    it('the installed SDK still sends interaction spans unless enableInp is false', () => {
        const tracing = sdk('browser', 'tracing/browserTracingIntegration.js');
        expect(tracing).toContain('enableInp: true,');
        expect(tracing).toContain('ignore: enableInp ? [] : ["inp"],');
    });

    it('@sentry/nextjs still builds its own with no options, so it has to be replaced', () => {
        expect(sdk('nextjs', 'client/index.js')).toContain(
            'customDefaultIntegrations.push(browserTracingIntegration.browserTracingIntegration());'
        );
    });

    // The two other standalone spans the SDK can send (layout shift and
    // largest paint) are experiments, off unless a config asks for them.
    it('sentry.client.config.ts rebuilds it with interaction spans off and turns no experiment on', () => {
        const src = config();
        expect(src).toContain('Sentry.browserTracingIntegration({ enableInp: false })');
        expect(src).not.toContain('_experiments');
        const tracing = sdk('browser', 'tracing/browserTracingIntegration.js');
        expect(tracing).toContain('enableStandaloneClsSpans');
        expect(tracing).toContain('enableStandaloneLcpSpans');
    });
});
