/**
 * Tests for the pass or fail call render-audit.mjs makes on a page's chrome.
 *
 * The verdict lives in render-verdict.mjs, which imports nothing, so this file
 * runs where no Playwright is installed: the CI job that runs the skill suites
 * checks the repo out and installs nothing. render-audit.mjs itself is read
 * as text and never imported, because importing it starts a run and needs the
 * client install. The text checks pin the wiring a pure function cannot: that
 * the audit measures the chrome with the shared selectors and counts the
 * verdict as hard.
 *
 * Run: node --test .claude/skills/docs-verify/scripts/render-audit.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
    CHROME_SELECTORS,
    CHROME_SETTLE_MS,
    chromeProblems,
} from './render-verdict.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = (name) =>
    readFileSync(join(HERE, name), 'utf8').replace(/\r\n/g, '\n');

// Two real measurements from 2026-10-12, Chromium at 1280, one preview build:
// /quickstart with its chrome, and /introduction as it was served without it.
// That second page answered 200 with its article whole, and the audit as it
// then was ended "0 hard".
const WITH_CHROME = { logos: 1, sidebarLinks: 46 };
const WITHOUT_CHROME = { logos: 0, sidebarLinks: 0 };

test('a page with a logo and a sidebar passes', () => {
    assert.deepEqual(chromeProblems(WITH_CHROME), []);
    // One link is a sidebar: the count is a floor, not the size of the nav.
    assert.deepEqual(chromeProblems({ logos: 2, sidebarLinks: 1 }), []);
});

test('the page that was served without its chrome fails, and says what is missing', () => {
    assert.deepEqual(chromeProblems(WITHOUT_CHROME), [
        'no sidebar links',
        'no logo',
    ]);
});

test('either half missing is enough to fail', () => {
    assert.deepEqual(chromeProblems({ logos: 1, sidebarLinks: 0 }), [
        'no sidebar links',
    ]);
    assert.deepEqual(chromeProblems({ logos: 0, sidebarLinks: 46 }), [
        'no logo',
    ]);
});

test('a measurement that is absent or not a count fails closed', () => {
    const both = ['no sidebar links', 'no logo'];
    for (const chrome of [
        undefined,
        null,
        {},
        { logos: NaN, sidebarLinks: NaN },
        { logos: '1', sidebarLinks: '46' },
        { logos: -1, sidebarLinks: -1 },
    ])
        assert.deepEqual(chromeProblems(chrome), both, JSON.stringify(chrome));
});

test('the selectors and the settle are the ones the 2026-10-12 probe used', () => {
    assert.deepEqual(CHROME_SELECTORS, {
        navbar: '#navbar',
        sidebar: '#sidebar, #sidebar-content',
    });
    assert.equal(CHROME_SETTLE_MS, 4000);
});

test('render-verdict.mjs imports nothing, so no install is needed to test it', () => {
    const text = source('render-verdict.mjs');
    assert.doesNotMatch(text, /^\s*import\s/m);
    assert.doesNotMatch(text, /\brequire\(/);
});

test('render-audit.mjs measures the chrome and counts the verdict as hard', () => {
    const text = source('render-audit.mjs');
    assert.match(
        text,
        /import \{[^}]*\bchromeProblems\b[^}]*\} from '\.\/render-verdict\.mjs';/
    );
    // The selectors travel into the page as an argument: measure() is
    // serialized, so it cannot see this module's imports.
    assert.match(text, /page\.evaluate\(measure, CHROME_SELECTORS\)/);
    assert.match(text, /querySelector\(chromeAt\.navbar\)/);
    assert.match(text, /querySelector\(chromeAt\.sidebar\)/);
    // The count of bare pages is added to the number the exit code reads.
    assert.match(text, /hard \+=[^;]*\bbare\.length/);
    // Playwright stays behind createRequire inside the script: a static
    // import would make this suite need the client install.
    assert.doesNotMatch(text, /^import .*playwright/m);
});
