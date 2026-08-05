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

    images: {
        // Next 16 treats this as an allow-list, not a default: any quality the
        // components request must appear here or the optimizer answers 400.
        // The app screenshots need 90 because their content (10-13px mono type
        // and hairline UI borders) is exactly what lossy compression destroys first.
        // 100 was measured and rejected: +0.5% sharpness for +37% bytes. The
        // lossy step costs ~1% here; the master's pixel count is what matters.
        qualities: [75, 90],
        // WebP only, deliberately. AVIF wins on photographs but its artifact
        // profile is edge softening, which is the worst possible failure mode
        // for fine UI text and hairline borders.
        formats: ['image/webp'],
    },

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

    // Annotate React components with their names, so Sentry breadcrumbs, UI
    // click spans and Session Replay show component names instead of raw DOM
    // nodes. The Babel transform writes data-sentry-component /
    // data-sentry-element / data-sentry-source-file attributes into the JSX, so
    // it still pays off with `sourcemaps.disable` set below: it annotates the
    // DOM rather than symbolicating stack traces.
    //
    // This MUST be the _experimental key. Production builds use Turbopack (Next
    // 16 defaults to it, and Next sets TURBOPACK=auto before this config is even
    // loaded), and the `webpack.reactComponentAnnotation` equivalent is inert
    // there: the webpack config is never constructed, and getBuildPluginOptions
    // separately forces the option to undefined. It was configured under
    // `webpack` here until 2026-07 and silently annotated nothing.
    //
    // Turbopack has no equivalent for `webpack.treeshake.removeDebugLogging`,
    // so Sentry's debug logging stays in the production bundle. That was already
    // true; the old comment claiming otherwise was wrong.
    //
    // _experimental options may be renamed without notice, so re-check on any
    // @sentry/nextjs upgrade. Requires Next 16+.
    _experimental: {
        turbopackReactComponentAnnotation: {
            enabled: true,
        },
    },

    // Source map uploads require SENTRY_AUTH_TOKEN env var.
    // Add it to Vercel project settings to enable detailed stack traces.
    // Left disabled by default — works without it, stack traces still function.
    sourcemaps: {
        disable: true,
    },
});
