// "Report this link" (C-12, spec 07 4.16).
//
// A mailto: link carrying the link id and the origin, and nothing else. The
// room id is the capability and lives only in the fragment, so the report is
// built from location.pathname and location.origin and never from
// location.href or location.hash: a report that carried the fragment would
// hand whoever reads the report mailbox the seat of an unused link. The link id
// is not secret; the visitor's own mail provider seeing it is accepted (08 13.1
// item 2).

import { linkIdFromPath, LINK_ID_RE } from './requestLink';

/** Placeholder until the owner supplies the dedicated address at Phase F
 *  (OD-23). The `.invalid` top-level domain can never deliver, so a mail sent
 *  before the swap bounces rather than landing anywhere. The release checklist
 *  row that replaces it is part 06's. */
export const REQUEST_REPORT_ADDRESS = 'request-link-reports@example.invalid';

/** A plain http or https origin: scheme, host and optional port, with no path,
 *  query or fragment. */
const ORIGIN_RE = /^https?:[/][/][^/?#\s]+$/;

/** The report mailto for this link, or null when either input is not the
 *  shape it must be. */
export function reportMailto(origin: string, linkId: string): string | null {
    if (!ORIGIN_RE.test(origin) || !LINK_ID_RE.test(linkId)) return null;
    const subject = encodeURIComponent(`Report Floe request link ${linkId}`);
    const body = encodeURIComponent(`Link: ${origin}/r/${linkId}`);
    return `mailto:${REQUEST_REPORT_ADDRESS}?subject=${subject}&body=${body}`;
}

/** The report mailto for the page the visitor is on. Reads the origin and the
 *  pathname, and nothing else of the location. */
export function reportMailtoFromLocation(loc: { origin: string; pathname: string }): string | null {
    const linkId = linkIdFromPath(loc.pathname);
    return linkId === null ? null : reportMailto(loc.origin, linkId);
}
