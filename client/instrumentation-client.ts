// instrumentation-client.ts
// Next.js 15+ runs this file in the browser before hydration.
// This is the correct entry point for client-side Sentry initialization
// in the App Router. The server-side configs are handled by instrumentation.ts.
import './sentry.client.config';
