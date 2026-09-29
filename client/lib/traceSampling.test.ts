import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TRACES_SAMPLE_RATE, tracesSampler } from './traceSampling';

// The fields of the SDK's sampling context this cares about, declared here so
// the test never loads the SDK (as lib/scrubUrl.ts does).
interface SamplingContext {
    name: string;
    attributes?: Record<string, unknown>;
    parentSampled?: boolean;
    parentSampleRate?: number;
    inheritOrSampleWith: (fallback: number) => number;
}

// Sentry calls the sampler with the context; this one reads none of it.
const sampler: (context: SamplingContext) => number = tracesSampler;

const NAMES: Record<string, string> = { pageload: '/r/:linkId', 'http.server': 'GET /r/[linkId]' };

/** A root span's context, with the SDK's own inheritOrSampleWith rule. */
function context(op: string, parentSampled?: boolean, parentSampleRate?: number): SamplingContext {
    return {
        name: NAMES[op] ?? 'Main UI thread blocked',
        attributes: { 'sentry.op': op },
        parentSampled,
        parentSampleRate,
        inheritOrSampleWith: vi.fn((fallback: number) =>
            typeof parentSampleRate === 'number'
                ? parentSampleRate
                : typeof parentSampled === 'boolean'
                  ? Number(parentSampled)
                  : fallback
        ),
    };
}

describe('tracesSampler', () => {
    it('is the rate the privacy page states', () => {
        expect(TRACES_SAMPLE_RATE).toBe(0.1);
    });

    it('samples a /r pageload that continues a sampled server trace at 10%, not 100% (CP-QA F3-04)', () => {
        // The meta tags /r serves: sentry-trace ...-1, baggage sample_rate=1.
        const ctx = context('pageload', true, 1);
        expect(sampler(ctx)).toBe(0.1);
        expect(ctx.inheritOrSampleWith).not.toHaveBeenCalled();
        // sampleSpan sends when sample_rand < rate. The three captured /r
        // pageloads carried these, and each was sent at the inherited 1.0.
        for (const sampleRand of [0.959, 0.272, 0.244]) {
            expect(sampleRand < sampler(ctx), String(sampleRand)).toBe(false);
        }
    });

    it('gives every root span the same rate, whatever its parent said', () => {
        // http.server is a server or edge request, whose parent is whatever
        // sentry-trace header the caller sent.
        for (const op of ['pageload', 'navigation', 'ui.interaction.click', 'ui.long-animation-frame', 'http.server']) {
            for (const [sampled, rate] of [[true, 1], [true, undefined], [false, 0], [undefined, undefined]] as const) {
                const ctx = context(op, sampled, rate);
                expect(sampler(ctx), `${op} parent ${sampled}`).toBe(0.1);
                expect(ctx.inheritOrSampleWith).not.toHaveBeenCalled();
            }
        }
    });

    // The configs import the SDK and cannot load here, so their wiring is read
    // as text. The browser's tracesSampleRate 0.1 lost to every sampled parent,
    // and the server and edge ran at 1.0, the parent /r's pageloads inherited.
    // A tracesSampleRate left beside the sampler would be dead code today and
    // the parent-first rule again the day the sampler went.
    it.each(['sentry.client.config.ts', 'sentry.server.config.ts', 'sentry.edge.config.ts'])(
        '%s samples with it and sets no rate of its own',
        (file) => {
            const src = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
            // A property at the start of a line, so a comment naming it passes.
            expect(src).not.toMatch(/^\s*tracesSampleRate\b/m);
            expect(src).toMatch(/import \{ tracesSampler \} from '\.\/lib\/traceSampling';/);
            expect(src).toMatch(/^\s+tracesSampler,$/m);
        }
    );
});
