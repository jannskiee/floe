// Which paths the Umami tracker is allowed to load on.
//
// The tracker reports location.href. data-exclude-hash and data-exclude-search
// strip the fragment and the query, which is what keeps a share link's room id
// out of it, but neither strips the PATH, and a request link carries its link id
// in the path. So the tracker is not configured differently on /r; it is not
// loaded there at all.
//
// Pure and window-free so client/vitest.config.ts (environment: 'node') can
// cover it. components/UmamiScript.tsx is the one caller.

/** True when the Umami script may load for this pathname.
 *
 *  Compared lowercased, deliberately, even though Next routes are
 *  case-sensitive and /R/<id> never reaches the page. This function's job is to
 *  keep a tracker off a family of URLs, so it errs toward silence: a host,
 *  proxy or future redirect that folds case must not be able to turn the
 *  tracker back on.
 *
 *  An absent pathname also returns false. usePathname() returns a string in the
 *  App Router, but if it ever did not, the cost of being wrong in this direction
 *  is a missing pageview, and in the other direction it is a link id in an
 *  analytics record. */
export function loadsUmami(pathname: string | null | undefined): boolean {
    if (!pathname) return false;
    const path = pathname.toLowerCase();
    // Exactly /r, or something under it. Not a bare prefix test: /relay and
    // /robots.txt start with the same letters and are ordinary pages.
    return !(path === '/r' || path.startsWith('/r/'));
}
