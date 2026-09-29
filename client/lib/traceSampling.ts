// The performance-trace sample on every runtime, and why it ignores the caller.
//
// The privacy page promises "a 10% sample of page performance traces". Set as
// tracesSampleRate, a rate only applies to a trace that starts where it is set:
// @sentry/core's sampleSpan takes a parent's decision first. /r is the site's
// one dynamic page, and its server render embeds a sentry-trace meta tag
// carrying the server's decision, made at the server's old rate of 1.0, so
// every /r pageload continued a sampled trace. Measured on a production build
// (CP-QA F3-04): three fresh /r loads sent three pageload transactions, with
// sample_rand 0.96, 0.27 and 0.24, where 10% would have sent none.
//
// A tracesSampler replaces the parent rule: whatever it returns is the rate,
// with a parent or without one. This one returns the documented rate for every
// root span, pageload, navigation and standalone alike, so no root span can
// inherit a higher rate from its parent.
//
// The server and edge use it too, so the 10% holds for every trace and not
// only the browser's. A server request's parent is whatever sentry-trace
// header its caller sent; under tracesSampleRate any caller could have its
// requests traced at 100%, and under the sampler none can. Traces still stay
// whole: every runtime samples when sample_rand < rate, and sample_rand
// travels in baggage (or, when missing, is derived to agree with the parent's
// decision), so with one rate everywhere a browser trace and the server spans
// it causes are kept or dropped together.
//
// Pure and SDK-free so client/vitest.config.ts can cover it; the callers are
// sentry.client.config.ts, sentry.server.config.ts and sentry.edge.config.ts.

/** The share of traces sent, on every runtime, as the privacy page states it. */
export const TRACES_SAMPLE_RATE = 0.1;

/** Sentry's tracesSampler: the documented rate, whatever the sampling context
 *  says, the parent's decision included, which is why it reads none of it. */
export function tracesSampler(): number {
    return TRACES_SAMPLE_RATE;
}
