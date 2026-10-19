// Every Sentry send hook fails closed (C1-04 (b)).
//
// A hook that throws does not stop a report. @sentry/core's Client catches the
// throw in _processEvent and captures it as a new exception marked
// data.__sentry__, and an event so marked never reaches beforeSend
// (isInternalException). It still gets the page address: the browser's
// HttpContext integration writes request.url in preprocessEvent, which the
// client emits for that event too, and on a receiving page that address is
// the whole share link, room id and all. Read in @sentry/core 10.76.2
// (build/esm/client.js _processEvent and _prepareEvent) and proved against the
// real client in failClosed.test.ts. Floe's scrub hooks are written never to
// throw (scrubUrl.ts, W3 R5-01); this is the floor under them.
//
// So each hook runs inside a try. An error event or a transaction whose hook
// threw is dropped, and so is a breadcrumb. A span cannot be dropped: null
// from beforeSendSpan keeps the span exactly as it was (processBeforeSend and
// createSpanEnvelope in @sentry/core), so a span whose hook threw is cut down
// to its ids and times, with no name and no attributes. Inside a transaction
// the transaction hook still runs after it and has the last word.
//
// Every runtime: the three Sentry configs pass their options through
// failClosedHooks. Shapes are declared here rather than imported, so this
// module never loads the SDK.

const DROPPED_ON_THROW = ['beforeSend', 'beforeSendTransaction', 'beforeBreadcrumb'] as const;

/** What a span's JSON carries that names nothing: ids, times, the
 *  operation and the outcome. */
export interface SpanIdentity {
    span_id: string;
    trace_id: string;
    parent_span_id?: string;
    start_timestamp: number;
    timestamp?: number;
    op?: string;
    status?: string;
    origin?: string;
}

function bareSpan(span: SpanIdentity): SpanIdentity & { data: Record<string, never> } {
    return {
        trace_id: span.trace_id,
        span_id: span.span_id,
        parent_span_id: span.parent_span_id,
        start_timestamp: span.start_timestamp,
        timestamp: span.timestamp,
        op: span.op,
        status: span.status,
        origin: span.origin,
        data: {},
    };
}

type AnyHook = (...args: unknown[]) => unknown;

/**
 * The same options with beforeSend, beforeSendTransaction, beforeSendSpan and
 * beforeBreadcrumb wrapped so that none of them can throw into the SDK.
 * Every other option is handed through untouched.
 */
export function failClosedHooks<T extends object>(options: T): T {
    const out = { ...options } as Record<string, unknown>;
    for (const name of DROPPED_ON_THROW) {
        const hook = out[name];
        if (typeof hook !== 'function') continue;
        out[name] = (...args: unknown[]) => {
            try {
                return (hook as AnyHook)(...args);
            } catch {
                return null;
            }
        };
    }
    const spanHook = out.beforeSendSpan;
    if (typeof spanHook === 'function') {
        const wrapped = (span: SpanIdentity) => {
            try {
                return (spanHook as AnyHook)(span);
            } catch {
                return bareSpan(span);
            }
        };
        // Under traceLifecycle 'static', @sentry/core 11 calls beforeSendSpan
        // only when withStaticSpan has marked it with a non-enumerable _static
        // property (isStaticBeforeSendSpanCallback). A new function carries no
        // such mark, so it is copied as the SDK sets it, or the SDK would skip
        // the wrapper and send every span unscrubbed.
        if ('_static' in spanHook) {
            Object.defineProperty(wrapped, '_static', {
                value: spanHook._static,
                writable: true,
                configurable: true,
            });
        }
        out.beforeSendSpan = wrapped;
    }
    return out as T;
}
