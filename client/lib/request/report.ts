// "Report this link" (C-12, spec 07 4.16).
//
// A mailto: link carrying the link id and the origin, and nothing else. The
// room id is the capability and lives only in the fragment, so the report is
// built from location.pathname and location.origin and never from
// location.href or location.hash: a report that carried the fragment would
// hand whoever reads the report mailbox the seat of an unused link. The link id
// is not secret; the visitor's own mail provider seeing it is accepted (08 13.1
// item 2).
//
// Where it goes depends on whose page this is (the owner's decision of
// 2026-10-14). floe.one's own pages write to the built-in address below. Any
// other origin is someone else's server, whose links the maintainer cannot act
// on, so it writes to the address that server's operator set in
// REQUEST_REPORT_EMAIL, and with none set there is no link at all.

import { linkIdFromPath, LINK_ID_RE } from './requestLink';

/** Where a report from floe.one goes: the owner's own address, the one
 *  SECURITY.md and CODE_OF_CONDUCT.md already publish for security and conduct
 *  reports. The owner chose it over a dedicated mailbox (OD-23, D-152).
 *  report.test.ts pins it against both files, so a change here is a change
 *  there too. /privacy and /terms print it as floe.one's contact on every
 *  server; only the link on /r follows the operator's setting. */
export const REQUEST_REPORT_ADDRESS = 'paredesjancarlo99@gmail.com';

/** The origins floe.one's own web app is served from, spelled as
 *  location.origin spells them. Matched whole: a port, a subdomain or plain
 *  http is another server. */
const FLOE_ORIGINS = ['https://www.floe.one', 'https://floe.one'];

/** One address in a deliberately narrow shape: letters, digits and . _ + -
 *  before the @, then a host name with at least one dot. Narrower than what
 *  mail allows, because the value goes into a mailto: URL as it is: none of
 *  these characters can end the address or start a second field there, so
 *  there is nothing to encode and nothing to get wrong. */
const ADDRESS_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:[.][A-Za-z0-9-]+)+$/;

/** The longest address mail can carry (RFC 5321's 256-character path, less
 *  its two angle brackets). */
const ADDRESS_MAX = 254;

/** A plain http or https origin: scheme, host and optional port, with no path,
 *  query or fragment. */
const ORIGIN_RE = /^https?:[/][/][^/?#\s]+$/;

/** The operator's report address out of REQUEST_REPORT_EMAIL, or null when the
 *  value is unset or is not one plain address. Nothing is trimmed or repaired:
 *  a value with a space, a second address or anything else around it counts as
 *  not configured. */
export function configuredReportAddress(value: string | null | undefined): string | null {
    if (typeof value !== 'string' || value.length > ADDRESS_MAX) return null;
    return ADDRESS_RE.test(value) ? value : null;
}

/** Where a report from a page on this origin goes, or null for no link. On
 *  floe.one the setting is not consulted at all. */
export function reportAddressFor(origin: string, configured: string | null | undefined): string | null {
    if (FLOE_ORIGINS.includes(origin)) return REQUEST_REPORT_ADDRESS;
    return configuredReportAddress(configured);
}

/** The report mailto for this link, or null when either input is not the
 *  shape it must be or this origin has nowhere to send a report. `configured`
 *  is checked again here whatever the caller did with it. */
export function reportMailto(origin: string, linkId: string, configured: string | null | undefined): string | null {
    if (!ORIGIN_RE.test(origin) || !LINK_ID_RE.test(linkId)) return null;
    const address = reportAddressFor(origin, configured);
    if (address === null) return null;
    const subject = encodeURIComponent(`Report Floe request link ${linkId}`);
    const body = encodeURIComponent(`Link: ${origin}/r/${linkId}`);
    return `mailto:${address}?subject=${subject}&body=${body}`;
}

/** The report mailto for the page the visitor is on. Reads the origin and the
 *  pathname, and nothing else of the location. */
export function reportMailtoFromLocation(
    loc: { origin: string; pathname: string },
    configured: string | null | undefined
): string | null {
    const linkId = linkIdFromPath(loc.pathname);
    return linkId === null ? null : reportMailto(loc.origin, linkId, configured);
}
