/**
 * The report address the e2e client runs with.
 *
 * The suite's pages are served from localhost, which is not floe.one, so a
 * request link's page shows "Report this link" only when the client was given
 * an address (REQUEST_REPORT_EMAIL, lib/request/report.ts). playwright.config.ts
 * gives it this one, and request-privacy.spec.ts expects exactly it in the
 * link.
 *
 * example.org is reserved for documentation (RFC 2606), so no mailbox is
 * behind it: a test that ever followed the link could write to nobody.
 *
 * No imports, for the reason cli-binary.ts gives: playwright.config.ts loads
 * this in-process.
 */

/** What REQUEST_REPORT_EMAIL is for every e2e run, local and CI. */
export const E2E_REPORT_EMAIL = 'reports@example.org';
