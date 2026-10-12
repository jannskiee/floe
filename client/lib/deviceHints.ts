// Removes the device and network hints the browser SDK attaches to a traced
// page load or page change.
//
// browserTracing reads navigator and navigator.connection on every pageload
// and navigation span (_trackNavigator in @sentry/browser-utils) and writes
// what it finds onto the root span: the device's approximate memory, its
// processor count, the network type the browser reports, and on a page load
// the browser's round-trip estimate as a measurement. Nothing in Floe reads
// them, traffic is far too thin for a device or network split to mean
// anything, and beside a user agent and a time zone they help single out one
// visitor. The privacy page lists what Sentry is sent and names none of them
// for a trace, so they are deleted here instead of being added to that list:
// this file and that list move together.
//
// The "approximate device memory" the privacy page does name is a different
// field: deviceMemoryGiB, which Floe itself attaches to a receive error. An
// error event never passes through this function.

/** Every attribute name _trackNavigator can set. The first four are the ones
 *  in use; the rest are what the same function writes under the span-streaming
 *  lifecycle, which is not enabled (see sentry.client.config.ts) and must not
 *  start sending them the day it is. A test reads the installed SDK and fails
 *  when it names a hint this list does not. */
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

// Structural shapes for Sentry's TransactionEvent and SpanJSON, declared here
// rather than imported so this module and its vitest never load the SDK.
export interface HintBearing {
    data?: Record<string, unknown>;
    contexts?: { trace?: { data?: Record<string, unknown> } };
    measurements?: Record<string, unknown>;
    spans?: HintBearing[];
}

/** Deletes the hints from a span or a transaction event, in place, and
 *  returns the same item. In place on purpose: the SDK merges what
 *  beforeSendSpan returns for a root span back into the event, so a copy
 *  without the measurement would get it back. Never throws. */
export function stripDeviceHints<T extends HintBearing>(item: T): T {
    for (const bag of [item.data, item.contexts?.trace?.data]) {
        if (bag) for (const name of DEVICE_HINT_ATTRIBUTES) delete bag[name];
    }
    if (item.measurements) delete item.measurements[DEVICE_HINT_MEASUREMENT];
    for (const span of item.spans ?? []) stripDeviceHints(span);
    return item;
}
