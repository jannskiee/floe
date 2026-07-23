import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
    // Emit a self-contained production server (.next/standalone) so the Docker
    // image can run with only the built output — no full node_modules at runtime.
    // Vercel ignores this flag, so the hosted deploy is unaffected.
    output: 'standalone',

    // React Strict Mode intentionally double-mounts components in development
    // to surface side-effect bugs. This would create two Socket.io connections
    // and two WebRTC peer instances — breaking the transfer logic entirely.
    // Strict Mode is therefore kept off. All socket/peer logic uses refs +
    // cleanup functions to avoid the double-mount problem if re-enabled later.
    reactStrictMode: false,

    // Documentation lives on Mintlify and is served at floe.one/docs (a subpath
    // of the primary domain, for SEO) via a reverse proxy: every /docs request
    // is rewritten to the Mintlify deployment, which is configured with base
    // path /docs so its own links and assets resolve under /docs too. The single
    // /docs/:path* rule also covers Mintlify's re-rooted assets.
    async rewrites() {
        return [
            { source: '/docs', destination: 'https://floe.mintlify.site/docs' },
            { source: '/docs/:path*', destination: 'https://floe.mintlify.site/docs/:path*' },
        ];
    },

    // The docs used to live at docs.floe.one; they permanently moved onto the
    // subpath. Once docs.floe.one points at this Vercel project, a request on
    // that host is 301'd to the matching www.floe.one/docs URL with the full
    // path preserved. Scoped by host so it never touches the main site. This is
    // inert until docs.floe.one's DNS is repointed here during cutover.
    async redirects() {
        return [
            {
                source: '/:path*',
                has: [{ type: 'host', value: 'docs.floe.one' }],
                destination: 'https://www.floe.one/docs/:path*',
                statusCode: 301,
            },
        ];
    },
};

export default withSentryConfig(nextConfig, {
    // Set SENTRY_ORG and SENTRY_PROJECT in your environment for source map uploads.
    // Leave empty to skip (the app still works; you just won't get annotated stack traces).
    org: process.env.SENTRY_ORG || '',
    project: process.env.SENTRY_PROJECT || '',

    // Suppress non-error logs during build
    silent: !process.env.CI,

    // Annotate React components with their names for clearer error reports
    webpack: {
        reactComponentAnnotation: {
            enabled: true,
        },
        // Strip Sentry debug logging from the production bundle. Replaces the
        // deprecated top-level `disableLogger`. This is webpack-only; Turbopack
        // builds ignore it, which is fine as debug logging is already disabled.
        treeshake: {
            removeDebugLogging: true,
        },
    },

    // Hide Sentry source maps from the browser bundle
    hideSourceMaps: true,

    // Source map uploads require SENTRY_AUTH_TOKEN env var.
    // Add it to Vercel project settings to enable detailed stack traces.
    // Left disabled by default — works without it, stack traces still function.
    sourcemaps: {
        disable: true,
    },
});
