import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Guards the options next.config.mjs hands withSentryConfig, read as text for
 * the reason lib/nextHeaders.test.ts gives: importing the config would load
 * the Next and Sentry SDKs into a node-environment vitest.
 */
const CONFIG = readFileSync(fileURLToPath(new URL('../next.config.mjs', import.meta.url)), 'utf8');

const OPTIONS = (() => {
    const start = CONFIG.indexOf('export default withSentryConfig(nextConfig, {');
    if (start < 0) throw new Error('next.config.mjs no longer exports withSentryConfig(nextConfig, {...})');
    return CONFIG.slice(start);
})();

describe('withSentryConfig options', () => {
    it('turn the build plugin\'s own telemetry off', () => {
        // Without it every build (Vercel, CI, local, a self-hosted image build)
        // sends Sentry a session and a sampled transaction about the build,
        // whatever NEXT_TELEMETRY_DISABLED says.
        expect(OPTIONS).toMatch(/^\s*telemetry: false,$/m);
    });

    it('keep source map uploads off', () => {
        expect(OPTIONS).toMatch(/sourcemaps: \{\s*disable: true,\s*\}/);
    });
});
