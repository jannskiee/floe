/**
 * The pass or fail call on a rendered docs page's chrome: the sidebar and the
 * logo that Mintlify puts around every article.
 *
 * Why it exists: on 2026-10-12 a preview served its front page with no site
 * configuration at all. The page answered 200 with its article whole, so
 * render-audit.mjs counted its tables, found nothing wrong and ended "0 hard",
 * while a reader saw no logo, a sidebar with 0 links where every other page
 * had 46, and a footer with one link. A page like that is not the page the
 * audit thinks it measured.
 *
 * Why a module of its own, importing nothing: render-audit.mjs needs
 * Playwright from the client install and starts a run when it is loaded. The
 * decision is kept here so render-audit.test.mjs can test it in the CI job
 * that runs the skill suites, which installs nothing.
 */

// Where the chrome is looked for, in the page. Mintlify's own ids, the ones
// the 2026-10-12 probe used in Chromium: a whole page read 1 logo and 46
// sidebar links at 1280 and at 390 alike, so the phone width needs no
// exception. Firefox and WebKit were not measured that day.
export const CHROME_SELECTORS = {
    navbar: '#navbar',
    sidebar: '#sidebar, #sidebar-content',
};

// How long a page that looks bare is given before it is measured again and
// called broken, so a page still loading is not mistaken for one. The probe
// waited this long on every page; the audit only pays it for a suspect.
export const CHROME_SETTLE_MS = 4000;

// What is missing from a page's chrome, as words for the report line; an
// empty list is a pass. `chrome` is what measure() in render-audit.mjs
// returns: the images visible in the navbar and the links in the sidebar.
// One of each is the floor: the broken page had 0 and 0, a whole one 1 and
// 46, and a floor tied to today's 46 would fail the day a page is removed.
// Anything that is not a count, or no measurement at all, fails as missing.
export function chromeProblems(chrome) {
    const count = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
    const problems = [];
    if (!count(chrome?.sidebarLinks)) problems.push('no sidebar links');
    if (!count(chrome?.logos)) problems.push('no logo');
    return problems;
}
