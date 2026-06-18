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
