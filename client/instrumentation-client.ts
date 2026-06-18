// instrumentation-client.ts
// Next.js 15+ runs this file in the browser before hydration.
// This is the correct entry point for client-side Sentry initialization
// in the App Router. The server-side configs are handled by instrumentation.ts.
import * as Sentry from '@sentry/nextjs';
import './sentry.client.config';
import { registerStaleBundleReload } from './lib/staleBundle';

// Auto-recover from "stale bundle" errors after a redeploy by reloading the
// page once. Registered here (before hydration) so it catches chunk-load
// failures that happen during the very first client-side navigation.
registerStaleBundleReload();

// Required by @sentry/nextjs to trace client-side App Router navigations.
// Without it, navigation transactions (e.g. moving between /privacy and /terms)
// are not instrumented, so errors that surface during navigation lack trace
// context. The build emits an "ACTION REQUIRED" warning until this is exported.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
