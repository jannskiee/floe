// Where /docs goes, for next.config.mjs. Plain JavaScript because Node loads
// next.config.mjs, and this, without a compiler; lib/docsRoutes.test.ts runs
// it both ways.
//
// The documentation is a Mintlify deployment served at floe.one/docs (a path
// of the primary domain, for SEO) through a reverse proxy: every /docs request
// is rewritten to the deployment, which is configured with base path /docs so
// its own links and assets resolve under /docs too. That proxy belongs to
// floe.one alone. A self-hosted web app used to carry it as well, serving
// floe.one's docs from a third party under the operator's own domain, with
// that domain's cookies and headers in front of it. Every other build now
// redirects /docs to the same path on floe.one (owner answer 20). Temporary,
// not permanent: an operator who later serves docs of their own must not find
// the redirect cached in every browser that ever followed it.
//
// The signal is VERCEL, the variable next.config.mjs already reads for
// `output`: set by Vercel's builder, and by nothing else that builds Floe.

const MINTLIFY = 'https://floe.mintlify.site/docs';
const PUBLIC_DOCS = 'https://www.floe.one/docs';

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ source: string, destination: string }[]}
 */
export function docsRewrites(env) {
    if (!env.VERCEL) return [];
    return [
        { source: '/docs', destination: MINTLIFY },
        { source: '/docs/:path*', destination: `${MINTLIFY}/:path*` },
    ];
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ source: string, destination: string, permanent: boolean }[]}
 */
export function docsRedirects(env) {
    if (env.VERCEL) return [];
    return [
        { source: '/docs', destination: PUBLIC_DOCS, permanent: false },
        { source: '/docs/:path*', destination: `${PUBLIC_DOCS}/:path*`, permanent: false },
    ];
}
