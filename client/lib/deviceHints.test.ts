import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEVICE_HINT_ATTRIBUTES, DEVICE_HINT_MEASUREMENT, NETWORK_PROTOCOL_ATTRIBUTES, stripDeviceHints } from './deviceHints';

// A page-load root span as beforeSendSpan sees it on Chromium, hints included.
const rootSpan = () => ({
    op: 'pageload',
    description: '/',
    is_segment: true,
    data: {
        'sentry.op': 'pageload',
        'sentry.origin': 'auto.pageload.nextjs.app_router_instrumentation',
        deviceMemory: '8 GB',
        hardwareConcurrency: '12',
        effectiveConnectionType: '4g',
        connectionType: 'wifi',
        'lcp.element': 'body > main > h1',
    },
    measurements: {
        'connection.rtt': { value: 50, unit: 'millisecond' },
        lcp: { value: 812.4, unit: 'millisecond' },
        ttfb: { value: 96.1, unit: 'millisecond' },
    },
});

describe('stripDeviceHints', () => {
    it('removes every hint from a root span and keeps the rest', () => {
        const span = rootSpan();
        stripDeviceHints(span);
        expect(span.data).toEqual({
            'sentry.op': 'pageload',
            'sentry.origin': 'auto.pageload.nextjs.app_router_instrumentation',
            'lcp.element': 'body > main > h1',
        });
        expect(span.measurements).toEqual({
            lcp: { value: 812.4, unit: 'millisecond' },
            ttfb: { value: 96.1, unit: 'millisecond' },
        });
    });

    it('removes them from a transaction event: the trace data, each span and the measurement', () => {
        const root = rootSpan();
        const event = {
            type: 'transaction',
            transaction: '/',
            contexts: { trace: { op: 'pageload', data: root.data }, culture: { timezone: 'Asia/Manila' } },
            measurements: root.measurements,
            spans: [{ op: 'navigation', data: { hardwareConcurrency: '12', 'sentry.op': 'navigation' } }],
        };
        stripDeviceHints(event);
        const json = JSON.stringify(event);
        for (const name of [...DEVICE_HINT_ATTRIBUTES, DEVICE_HINT_MEASUREMENT]) expect(json).not.toContain(`"${name}"`);
        expect(event.contexts.culture).toEqual({ timezone: 'Asia/Manila' });
        expect(event.measurements).toEqual({
            lcp: { value: 812.4, unit: 'millisecond' },
            ttfb: { value: 96.1, unit: 'millisecond' },
        });
        expect(event.spans[0].data).toEqual({ 'sentry.op': 'navigation' });
    });

    it('removes the names the span-streaming lifecycle uses as well', () => {
        const span = {
            data: {
                'device.memory.estimated_capacity': 8,
                'device.processor_count': 12,
                'network.connection.effective_type': '4g',
                'network.connection.type': 'wifi',
                'network.connection.rtt': 50,
                'sentry.op': 'pageload',
            },
        };
        expect(stripDeviceHints(span).data).toEqual({ 'sentry.op': 'pageload' });
    });

    // Every resource span and every fetch or XHR span of a traced page load
    // also carried the HTTP protocol the visitor's network negotiated for that
    // request (nextHopProtocol: "h2", "http/1.1"), which is a fact about the
    // network between the visitor and the site and is named by no privacy
    // text. It is not written by _trackNavigator, so it has a list of its own.
    it('removes the negotiated network protocol from every span of a trace', () => {
        const event = {
            contexts: { trace: { data: { 'network.protocol.name': 'http', 'network.protocol.version': '2', 'sentry.op': 'pageload' } } },
            spans: [
                { op: 'resource.script', data: { 'network.protocol.name': 'http', 'network.protocol.version': '2', 'http.response_content_length': 512 } },
                { op: 'http.client', data: { 'network.protocol.version': '1.1', 'http.method': 'GET' } },
            ],
        };
        stripDeviceHints(event);
        const json = JSON.stringify(event);
        for (const name of NETWORK_PROTOCOL_ATTRIBUTES) expect(json).not.toContain(name);
        expect(event.contexts.trace.data).toEqual({ 'sentry.op': 'pageload' });
        expect(event.spans[0].data).toEqual({ 'http.response_content_length': 512 });
        expect(event.spans[1].data).toEqual({ 'http.method': 'GET' });
        expect(NETWORK_PROTOCOL_ATTRIBUTES).toEqual(['network.protocol.name', 'network.protocol.version']);
    });

    // The SDK hands beforeSendSpan a root span whose data and measurements ARE
    // the event's own objects, then merges what the hook returns back into the
    // event (processBeforeSend in @sentry/core client.js). A hook that returned
    // a copy without the measurement would get it back from that merge, so the
    // bags are edited where they are and the same item is returned.
    it('edits the bags in place and returns the same item', () => {
        const span = rootSpan();
        const { data, measurements } = span;
        expect(stripDeviceHints(span)).toBe(span);
        expect(span.data).toBe(data);
        expect(span.measurements).toBe(measurements);
        expect(data).not.toHaveProperty('hardwareConcurrency');
        expect(measurements).not.toHaveProperty('connection.rtt');
    });

    // A send hook that throws does not just lose its trace. The SDK reports
    // the throw as an error event of its own, and that event skips beforeSend,
    // so it would carry the page address, room link and all, unscrubbed. The
    // SDK does not hand the hooks a frozen bag or a hole in the span list
    // today; this is so that it cannot matter when it does.
    it('never throws, whatever it is handed', () => {
        const frozen = { data: Object.freeze({ deviceMemory: '8 GB', 'sentry.op': 'pageload' }) };
        const frozenMeasurements = { measurements: Object.freeze({ 'connection.rtt': { value: 50, unit: 'millisecond' } }) };
        const holes = { spans: [null, undefined, 7, 'x', { data: { hardwareConcurrency: '12' } }] };
        for (const item of [frozen, frozenMeasurements, holes, null, undefined, 7, 'text']) {
            expect(() => stripDeviceHints(item as never)).not.toThrow();
        }
        expect(stripDeviceHints(frozen as never)).toBe(frozen);
        // What could be removed around the hole still was.
        expect((holes.spans[4] as { data: object }).data).toEqual({});
    });

    it('is idempotent, and safe on an item that holds no bag', () => {
        const once = stripDeviceHints(rootSpan());
        expect(stripDeviceHints(JSON.parse(JSON.stringify(once)))).toEqual(once);
        for (const item of [{}, { data: undefined }, { contexts: {} }, { contexts: { trace: {} } }, { spans: [] }, { spans: [{}] }]) {
            const before = JSON.stringify(item);
            expect(() => stripDeviceHints(item)).not.toThrow();
            expect(JSON.stringify(item)).toBe(before);
        }
    });

    // The list is only complete for the SDK it was read from. This reads the
    // one function that attaches these hints out of the SDK that is installed,
    // as text, and fails when it names anything the list does not: an upgrade
    // that adds a hint has to add it here, or decide to disclose it on the
    // privacy page.
    it('knows every hint the installed SDK attaches', () => {
        const fromHere = createRequire(import.meta.url);
        const fromNext = createRequire(fromHere.resolve('@sentry/nextjs'));
        const fromReact = createRequire(fromNext.resolve('@sentry/react'));
        const fromBrowser = createRequire(fromReact.resolve('@sentry/browser'));
        const utils = dirname(fromBrowser.resolve('@sentry/browser-utils'));
        const source = readFileSync(join(utils, 'metrics/browserMetrics.js'), 'utf8');

        const body = /\nfunction _trackNavigator\([^)]*\) \{\n([\s\S]*?)\n\}\n/.exec(source)?.[1];
        expect(body, '_trackNavigator was not found in the installed SDK').toBeTruthy();

        // Every quoted string in the function is an attribute name, a
        // measurement name, or one of two words that are neither.
        const NOT_A_NAME = ['pageload', 'millisecond'];
        const named = [...new Set([...body!.matchAll(/"([^"]+)"/g)].map((m) => m[1]))].filter((s) => !NOT_A_NAME.includes(s));
        expect(named.sort()).toEqual([...DEVICE_HINT_ATTRIBUTES, DEVICE_HINT_MEASUREMENT].sort());
    });

    // The config imports the SDK and cannot load here, so its wiring is read
    // as text, as sentryIntegrations.test.ts does. Both hooks: the transaction
    // hook has the last word on a page load, and the span hook is the only one
    // a standalone span passes through.
    it('sentry.client.config.ts strips them in both send hooks, after the URL scrub', () => {
        const src = readFileSync(fileURLToPath(new URL('../sentry.client.config.ts', import.meta.url)), 'utf8');
        expect(src).toMatch(/import \{ stripDeviceHints \} from '\.\/lib\/deviceHints';/);
        expect(src).toMatch(/^\s+return stripDeviceHints\(scrubTransactionEvent\(event\)\);$/m);
        expect(src).toMatch(/^\s+return stripDeviceHints\(scrubSpanJson\(span\)\);$/m);
    });
});
