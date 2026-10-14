import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { docsRedirects, docsRewrites } from './docsRoutes.mjs';

// Where /docs goes (owner answer 20). floe.one, built on Vercel, keeps its
// reverse proxy to the Mintlify deployment. Every other build, the self-hosted
// image above all, sends /docs to floe.one's docs instead of proxying a third
// party's site under the operator's own domain.
describe('docs routes', () => {
    it('floe.one proxies /docs to Mintlify and redirects nothing', () => {
        const env = { VERCEL: '1' };
        expect(docsRewrites(env)).toEqual([
            { source: '/docs', destination: 'https://floe.mintlify.site/docs' },
            { source: '/docs/:path*', destination: 'https://floe.mintlify.site/docs/:path*' },
        ]);
        expect(docsRedirects(env)).toEqual([]);
    });

    it('a self-hosted build redirects /docs, path kept, and proxies nothing', () => {
        const env = {};
        expect(docsRewrites(env)).toEqual([]);
        expect(docsRedirects(env)).toEqual([
            { source: '/docs', destination: 'https://www.floe.one/docs', permanent: false },
            { source: '/docs/:path*', destination: 'https://www.floe.one/docs/:path*', permanent: false },
        ]);
    });

    it('next.config.mjs takes its docs routes from here, beside the docs.floe.one host redirect', () => {
        const config = readFileSync(fileURLToPath(new URL('../next.config.mjs', import.meta.url)), 'utf8');
        expect(config).toContain("from './lib/docsRoutes.mjs'");
        expect(config).toContain('docsRewrites(process.env)');
        expect(config).toContain('...docsRedirects(process.env)');
        expect(config).toContain("has: [{ type: 'host', value: 'docs.floe.one' }]");
        expect(config).not.toContain("destination: 'https://floe.mintlify.site/docs'");
    });
});
