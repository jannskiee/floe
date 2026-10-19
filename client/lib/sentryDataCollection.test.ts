import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NodeClient, createTransport } from '@sentry/nextjs';
import { DATA_COLLECTION } from './sentryDataCollection';

// What @sentry/core 10.76.2 resolved sendDefaultPii false to
// (defaultPiiToCollectionOptions.js), as getDataCollectionOptions() handed it
// back. The commit that added the block showed, on real 10.76.2 clients, that
// the block resolved to exactly this; 11.8.0 has no sendDefaultPii, and adds
// queues, which the block sets false.
const D = ['forwarded', '-ip', 'remote-', 'via', '-user'];
const SEND_DEFAULT_PII_FALSE = {
    userInfo: false,
    cookies: { deny: D },
    httpHeaders: { request: { deny: D }, response: { deny: D } },
    httpBodies: [],
    urlQueryParams: { deny: D },
    graphQL: { document: true, variables: true },
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    stackFrameVariables: true,
    frameContextLines: 7,
};

const transport = (options: Parameters<typeof createTransport>[0]) =>
    createTransport(options, async () => ({ statusCode: 200 }));

// A real client, as Sentry.init builds one, asked what it will collect.
// NodeClient because vitest resolves @sentry/nextjs to its server build; the
// resolution is @sentry/core's Client constructor, which every runtime's
// client inherits.
async function resolvedBy(options: Record<string, unknown>) {
    const client = new NodeClient({
        dsn: 'https://public@o0.ingest.sentry.io/0',
        integrations: [],
        sendClientReports: false,
        stackParser: () => [],
        transport,
        ...options,
    });
    const resolved = client.getDataCollectionOptions();
    await client.close(0);
    return resolved;
}

interface BrowserSdk {
    BrowserClient: new (options: Record<string, unknown>) => {
        getOptions(): {
            _metadata?: { sdk?: { settings?: { infer_ip?: string } } };
        };
        close(timeout?: number): Promise<boolean>;
    };
}

// The browser SDK, through the chain the client resolves it by, as
// sentryIntegrations.test.ts loads it.
function browserSdk(): BrowserSdk {
    const fromHere = createRequire(import.meta.url);
    const fromNext = createRequire(fromHere.resolve('@sentry/nextjs'));
    const fromReact = createRequire(fromNext.resolve('@sentry/react'));
    return fromReact('@sentry/browser') as BrowserSdk;
}

describe('the data collection block', () => {
    it('resolves on the installed SDK to what sendDefaultPii false resolved to on 10.76.2', async () => {
        expect(await resolvedBy({ dataCollection: DATA_COLLECTION })).toEqual({
            ...SEND_DEFAULT_PII_FALSE,
            queues: false,
        });
    });

    // Why the block is there: with no dataCollection the installed SDK
    // collects the address, every cookie and header, and the bodies, and a
    // sendDefaultPii left in a config changes none of it.
    it('is what stands between the installed SDK and its defaults', async () => {
        const defaults = await resolvedBy({});
        expect(defaults.userInfo).toBe(true);
        expect(defaults.cookies).toBe(true);
        expect(defaults.httpHeaders).toEqual({ request: true, response: true });
        expect(defaults.httpBodies).toHaveLength(4);
        expect(await resolvedBy({ sendDefaultPii: false })).toEqual(defaults);
    });

    // The one place a browser report says whether Sentry may work out the
    // visitor's address: the browser client writes it from userInfo.
    it('has the browser client tell Sentry never to infer the address', async () => {
        const { BrowserClient } = browserSdk();
        const make = (options: Record<string, unknown>) =>
            new BrowserClient({
                dsn: 'https://public@o0.ingest.sentry.io/0',
                integrations: [],
                sendClientReports: false,
                stackParser: () => [],
                transport,
                ...options,
            });
        const client = make({ dataCollection: DATA_COLLECTION });
        expect(client.getOptions()._metadata?.sdk?.settings?.infer_ip).toBe(
            'never'
        );
        await client.close(0);
        const unset = make({});
        expect(unset.getOptions()._metadata?.sdk?.settings?.infer_ip).toBe(
            'auto'
        );
        await unset.close(0);
    });
});

// The configs import the SDK and cannot load here, so their wiring is read as
// text, as failClosed.test.ts and sentryIntegrations.test.ts do.
describe('every Sentry config passes the block and keeps transactions', () => {
    const read = (rel: string) =>
        readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    it.each([
        'sentry.client.config.ts',
        'sentry.server.config.ts',
        'sentry.edge.config.ts',
    ])('%s', (name) => {
        const src = read(`../${name}`);
        expect(src).toContain(
            "import { DATA_COLLECTION } from './lib/sentryDataCollection';"
        );
        // Whole code lines, so a commented-out one fails.
        expect(src).toMatch(/^\s+dataCollection: DATA_COLLECTION,\r?$/m);
        expect(src).toMatch(/^\s+traceLifecycle: 'static',\r?$/m);
        // A key the installed SDK no longer reads, which would only look
        // like a setting.
        expect(src).not.toMatch(/^\s*sendDefaultPii\b/m);
    });
});
