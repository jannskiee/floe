// Removes the device and network hints the browser SDK attaches to a traced
// page load or page change.
//
// browserTracing reads navigator and navigator.connection on every pageload
// and navigation span (_trackNavigator in @sentry/browser-utils) and writes
// what it finds onto the root span: the device's approximate memory, its
// processor count, the network type the browser reports, and on a page load
// the browser's round-trip estimate as a measurement. It also stamps every
// resource, fetch and XHR span with the HTTP protocol the visitor's network
// negotiated for that request. Nothing in Floe reads any of them, traffic is
// far too thin for a device or network split to mean anything, and beside a
// user agent and a time zone they help single out one visitor. The privacy
// page lists what Sentry is sent and names none of them for a trace, so they
// are deleted here instead of being added to that list: this file and that
// list move together.
//
// The "approximate device memory" the privacy page does name is a different
// field: deviceMemoryGiB, which Floe itself attaches to a receive error. An
// error event never passes through this function.
//
// Known and left: the SDK's culture context also carries the calendar system
// ("gregory") beside the language and time zone the privacy page names.

/** Every attribute name _trackNavigator can set. The first four are the ones
 *  in use; the rest are what the same function writes under the span-streaming
 *  lifecycle, which is not enabled (see sentry.client.config.ts) and must not
 *  start sending them the day it is. A test reads that function out of the
 *  installed SDK and fails when it names a hint this list does not. */
export const DEVICE_HINT_ATTRIBUTES = [
    'deviceMemory',
    'hardwareConcurrency',
    'effectiveConnectionType',
    'connectionType',
    'device.memory.estimated_capacity',
    'device.processor_count',
    'network.connection.effective_type',
    'network.connection.type',
    'network.connection.rtt',
] as const;

/** The round-trip estimate, which outside span streaming is a measurement on
 *  a page load rather than an attribute. */
export const DEVICE_HINT_MEASUREMENT = 'connection.rtt';

/** What the SDK copies from each request's nextHopProtocol onto its resource,
 *  fetch and XHR spans (resourceTiming.js in @sentry/browser-utils). A list of
 *  its own, because the test for the list above pins one function exactly and
 *  these are written by another. */
export const NETWORK_PROTOCOL_ATTRIBUTES = ['network.protocol.name', 'network.protocol.version'] as const;

// Structural shapes for Sentry's TransactionEvent and SpanJSON, declared here
// rather than imported so this module and its vitest never load the SDK.
export interface HintBearing {
    data?: Record<string, unknown>;
    contexts?: { trace?: { data?: Record<string, unknown> } };
    measurements?: Record<string, unknown>;
    spans?: HintBearing[];
}

const ATTRIBUTES: readonly string[] = [...DEVICE_HINT_ATTRIBUTES, ...NETWORK_PROTOCOL_ATTRIBUTES];

// One bag at a time, so that one that cannot be changed costs only itself.
function clear(bag: Record<string, unknown> | undefined, names: readonly string[]): void {
    if (!bag) return;
    try {
        for (const name of names) delete bag[name];
    } catch {
        // A frozen bag stays as it is.
    }
}

function strip(item: HintBearing): void {
    clear(item.data, ATTRIBUTES);
    clear(item.contexts?.trace?.data, ATTRIBUTES);
    clear(item.measurements, [DEVICE_HINT_MEASUREMENT]);
}

/** Deletes the hints from a span or a transaction event, in place, and
 *  returns the same item. In place on purpose: the SDK merges what
 *  beforeSendSpan returns for a root span back into the event, so a copy
 *  without the measurement would get it back.
 *
 *  It never throws, whatever it is handed. A send hook that throws does not
 *  just lose its trace: the SDK reports the throw as an error event of its
 *  own, and that event skips beforeSend, so it would leave with the page
 *  address unscrubbed. A bag that cannot be changed is left as it is. */
export function stripDeviceHints<T extends HintBearing>(item: T): T {
    try {
        strip(item);
    } catch {
        // A frozen bag, or something that is not an item at all.
    }
    try {
        const spans: unknown = item?.spans;
        if (Array.isArray(spans)) {
            for (const span of spans) {
                if (span !== null && typeof span === 'object') stripDeviceHints(span as HintBearing);
            }
        }
    } catch {
        // A span list that cannot be read.
    }
    return item;
}
