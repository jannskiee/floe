import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NodeClient, createTransport, withStaticSpan } from '@sentry/nextjs';
import { failClosedHooks } from './failClosed';

// The send hooks, driven through the REAL client. The configs call
// Sentry.init() at module scope and cannot be imported here, so this builds a
// client with the same kind of hooks and the configs' traceLifecycle. NodeClient
// because vitest resolves @sentry/nextjs to its server build; the path under
// test is processBeforeSend in @sentry/core's Client, which the browser's
// client inherits unchanged. Each test ends with close(), which flushes as
// flush() does and also takes off the process listeners each NodeClient adds
// (with flush() Node warned of a leak).

const ROOM = '3f2a8c1e-5b7d-4e9a-8c6f-1a2b3c4d5e6f';
const LINK = `https://www.floe.one/?s=n0nce#room=${ROOM}`;

// What the browser's HttpContext integration does to every event, error or
// transaction: in preprocessEvent, which the client emits for an internal
// event too (event processors it skips), it puts the page address on it,
// fragment included (@sentry/browser 11.8.0 integrations/httpcontext.js).
const pageAddress = {
    name: 'PageAddress',
    preprocessEvent(event: { request?: { url?: string } }) {
        event.request = { ...event.request, url: LINK };
    },
};

type Hooks = Record<string, unknown>;

function clientWith(hooks: Hooks) {
    const sent: string[] = [];
    const client = new NodeClient({
        dsn: 'https://public@o0.ingest.sentry.io/0',
        integrations: [pageAddress],
        sendClientReports: false,
        // As in the three configs: transactions, and a span hook that runs
        // only when withStaticSpan has marked it.
        traceLifecycle: 'static',
        stackParser: () => [],
        transport: (options) =>
            createTransport(options, async (request) => {
                sent.push(typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body));
                return { statusCode: 200 };
            }),
        ...hooks,
    });
    // Installs the integrations, as Sentry.init does.
    client.init();
    return { client, sent: () => sent.join('\n') };
}

interface SentSpan {
    description?: string;
    data?: Record<string, unknown>;
}

// The transaction an envelope carried: the one line that is a transaction
// payload rather than its item header.
function sentTransaction(body: string): { spans: SentSpan[] } | undefined {
    for (const line of body.split('\n')) {
        try {
            const item: unknown = JSON.parse(line);
            if (
                typeof item === 'object' &&
                item !== null &&
                'type' in item &&
                item.type === 'transaction' &&
                'spans' in item &&
                Array.isArray(item.spans)
            ) {
                return { spans: item.spans };
            }
        } catch {
            // Not JSON: an envelope line of another kind.
        }
    }
    return undefined;
}

// Takes any arguments, so it can stand in for every hook.
const thrower = (...args: unknown[]): never => {
    void args;
    throw new TypeError('a scrub hook met a shape it did not expect');
};

const transaction = () => ({
    type: 'transaction' as const,
    transaction: '/',
    start_timestamp: 1,
    timestamp: 2,
    contexts: { trace: { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16), op: 'pageload', data: {} } },
    spans: [
        {
            trace_id: 'a'.repeat(32),
            span_id: 'c'.repeat(16),
            parent_span_id: 'b'.repeat(16),
            start_timestamp: 1,
            timestamp: 2,
            status: 'ok',
            op: 'browser.domContentLoadedEvent',
            description: LINK,
            data: { 'url.full': LINK },
        },
    ],
});

describe('a Sentry hook that throws, as the SDK handles it (C1-04 (b))', () => {
    // In 10.76.2 the client caught a throw from beforeSend or
    // beforeSendTransaction and captured it as a new exception, which skipped
    // beforeSend and left with the page address. 11.8.0 runs both through
    // safeCallback and drops the event instead.
    it('drops an error event whose hook threw, and sends nothing in its place', async () => {
        let calls = 0;
        const { client, sent } = clientWith({
            beforeSend: () => {
                calls += 1;
                thrower();
            },
        });
        client.captureException(new Error('anything'));
        await client.close(2000);
        expect(calls).toBe(1);
        expect(sent()).toBe('');
    });

    it('does the same for the transaction hook', async () => {
        const { client, sent } = clientWith({ beforeSendTransaction: thrower });
        client.captureEvent(transaction());
        await client.close(2000);
        expect(sent()).toBe('');
    });

    // The span hook is different: a throw sends the span unmodified
    // (applyBeforeSendSpanCallback), room link and all.
    it('sends a span whose hook threw as it was', async () => {
        const { client, sent } = clientWith({
            beforeSendSpan: withStaticSpan(thrower),
        });
        client.captureEvent(transaction());
        await client.close(2000);
        expect(sentTransaction(sent())?.spans[0].description).toBe(LINK);
    });

    // Why a span is cut down rather than dropped: null from beforeSendSpan
    // keeps the span exactly as it was.
    it('keeps a span whose hook returned null as it was', async () => {
        const { client, sent } = clientWith({
            beforeSendSpan: withStaticSpan(() => null as never),
        });
        client.captureEvent(transaction());
        await client.close(2000);
        expect(sentTransaction(sent())?.spans[0].description).toBe(LINK);
    });

    // Under traceLifecycle 'static' an unmarked span hook is never called.
    it('skips a span hook withStaticSpan did not mark', async () => {
        let calls = 0;
        const { client, sent } = clientWith({
            beforeSendSpan: (span: SentSpan) => {
                calls += 1;
                return { ...span, description: 'scrubbed' };
            },
        });
        client.captureEvent(transaction());
        await client.close(2000);
        expect(calls).toBe(0);
        expect(sentTransaction(sent())?.spans[0].description).toBe(LINK);
    });
});

describe('failClosedHooks', () => {
    it('drops an error event whose hook threw, and sends nothing in its place', async () => {
        const { client, sent } = clientWith(failClosedHooks({ beforeSend: thrower }));
        client.captureException(new Error('anything'));
        await client.close(2000);
        expect(sent()).toBe('');
    });

    it('drops a transaction whose hook threw', async () => {
        const { client, sent } = clientWith(failClosedHooks({ beforeSendTransaction: thrower }));
        client.captureEvent(transaction());
        await client.close(2000);
        expect(sent()).toBe('');
    });

    it('cuts a span whose hook threw down to its ids and times', () => {
        const { beforeSendSpan } = failClosedHooks({ beforeSendSpan: thrower });
        const span = transaction().spans[0];
        expect(beforeSendSpan(span)).toEqual({
            trace_id: span.trace_id,
            span_id: span.span_id,
            parent_span_id: span.parent_span_id,
            start_timestamp: 1,
            timestamp: 2,
            op: 'browser.domContentLoadedEvent',
            status: 'ok',
            origin: undefined,
            data: {},
        });
    });

    // The wrapper is a new function, and the SDK reads the mark off the
    // function it is given, so the mark has to come across, as the SDK sets
    // it: non-enumerable.
    it('carries the withStaticSpan mark onto the function it wraps the hook in', () => {
        const marked = withStaticSpan((span) => span);
        const { beforeSendSpan } = failClosedHooks({ beforeSendSpan: marked });
        expect(beforeSendSpan).not.toBe(marked);
        expect(
            Object.getOwnPropertyDescriptor(beforeSendSpan, '_static')
        ).toEqual(Object.getOwnPropertyDescriptor(marked, '_static'));
        expect(Object.keys(beforeSendSpan)).toEqual([]);
        const unmarked = failClosedHooks({
            beforeSendSpan: (span: SentSpan) => span,
        });
        expect('_static' in unmarked.beforeSendSpan).toBe(false);
    });

    it('lets the SDK run a marked span hook through the wrapper', async () => {
        let calls = 0;
        const { client, sent } = clientWith(
            failClosedHooks({
                beforeSendSpan: withStaticSpan((span) => {
                    calls += 1;
                    span.description = 'scrubbed';
                    span.data = {};
                    return span;
                }),
            })
        );
        client.captureEvent(transaction());
        await client.close(2000);
        // The root span and the one child.
        expect(calls).toBe(2);
        expect(sentTransaction(sent())?.spans[0]).toMatchObject({
            description: 'scrubbed',
            data: {},
        });
    });

    it('lets a transaction whose span hook threw reach the transaction hook, without the span\'s address', async () => {
        let seen = 0;
        const { client, sent } = clientWith(
            failClosedHooks({
                beforeSendSpan: withStaticSpan(thrower),
                beforeSendTransaction: (event: { request?: { url?: string } }) => {
                    seen += 1;
                    // Stands in for the scrub, which owns the page address.
                    delete event.request;
                    return event;
                },
            }),
        );
        client.captureEvent(transaction());
        await client.close(2000);
        expect(seen).toBe(1);
        expect(sent()).not.toBe('');
        expect(sent()).not.toContain(ROOM);
        expect(sentTransaction(sent())?.spans[0].description).toBeUndefined();
    });

    it('drops a breadcrumb whose hook threw, and throws nothing into the caller', () => {
        const { beforeBreadcrumb } = failClosedHooks({ beforeBreadcrumb: thrower });
        expect(beforeBreadcrumb({ message: LINK })).toBeNull();
    });

    it('hands back what a hook that did not throw returned, and keeps every other option', () => {
        const event = { message: 'ok' };
        const options = failClosedHooks({
            dsn: 'x',
            tracesSampler: thrower,
            beforeSend: (e: typeof event) => e,
        });
        expect(options.beforeSend(event)).toBe(event);
        expect(options.dsn).toBe('x');
        // Only the four send hooks are wrapped.
        expect(options.tracesSampler).toBe(thrower);
    });
});

// The three configs import the SDK and cannot load here, so the wiring is
// read as text, as noLocation.test.ts and sentryIntegrations.test.ts do.
describe('every Sentry config passes its options through it', () => {
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    it.each(['sentry.client.config.ts', 'sentry.server.config.ts', 'sentry.edge.config.ts'])('%s', (name) => {
        const src = read(`../${name}`);
        expect(src).toContain("import { failClosedHooks } from './lib/failClosed';");
        // The one init, its whole options object inside the wrapper.
        expect(src.match(/Sentry\.init\(/g)).toHaveLength(1);
        expect(src).toMatch(/^Sentry\.init\(failClosedHooks\(\{\r?$/m);
        expect(src.trimEnd().endsWith('}));')).toBe(true);
    });

    // The browser's span hook carries the mark, or under the static
    // lifecycle the SDK never calls it.
    it('sentry.client.config.ts marks its span hook with withStaticSpan', () => {
        const src = read('../sentry.client.config.ts');
        expect(src).toMatch(
            /^\s+beforeSendSpan: Sentry\.withStaticSpan\(\(span\) => \{\r?$/m
        );
    });
});
