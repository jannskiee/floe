---
name: 'docs-verify'
description: 'Docs pre-flight for Floe: docs-check.mjs, the same script CI runs (links and anchors, nav, frontmatter, raw tags in headings, link labels, table shape, snippet and image paths in exact letter case, /docs paths in client code, env-var fan-out, em and en dashes), then the claim map to diff each user-facing claim against its source symbol, then render-audit.mjs on the rendered pages. Use when editing docs/**, docs/style.css, README.md, CONTRIBUTING.md, SELF_HOSTING.md, DESKTOP.md, unraid/, .goreleaser.yml, docker-compose.yml, an env example file or .github templates, or when adding, renaming or changing a user-facing flag, limit, env var, default, CLI string or in-app string that the docs quote or should quote.'
---

# docs-verify

Two layers. The script settles what a script can settle; you settle the rest against source.

## 1. Mechanical pre-flight

From the repo root:

    node .claude/skills/docs-verify/scripts/docs-check.mjs [all|links|nav|frontmatter|headings|labels|tables|env|dashes] [--root <dir>]

`all` is the default; a single check name runs only that check; `--root` points it at
another checkout (default: the repo the script lives in). `links` also runs the footer
mirror, the image and snippet paths and the client `/docs` paths.

CI runs `docs-check.mjs all` on every PR: it is the `Docs pre-flight` step of the
`Repo guardrails` job, which the `CI green` gate needs, so a HARD line blocks the merge.
Run it before you push and the failure is yours to see first.

Exit 1 is a decidable defect: a link target or anchor that does not exist, an image `src`
or a snippet import that names a file which is not under docs/ (or names it in a different
letter case), a bare `/docs/...` path in client code that names no page, a nav entry
without a file or a page outside the nav (or a docs.json the script cannot parse or walk),
a page with no frontmatter block or missing title or description, two hyphens in a title,
sidebarTitle or description, a `<` in a heading that MDX cannot read as a closed tag, a table whose
delimiter row and header differ in cell count, a straight double quote that opens a table
cell or closes one after punctuation, an em or en dash (in the docs, the root
and unraid Markdown, the desktop READMEs, `.goreleaser.yml` and `docs/style.css`), a
documented server default that contradicts server/server.js, or one
of the env self-checks failing (fewer keys than the server modules read, or a configuration
page that yields no variable rows). Fix, rerun. Exit 2 is a usage error or a root with no
docs/docs.json. Exit 0 with NOTE lines is the normal outcome. Read every NOTE and decide;
do not skim.

- anchors: Mintlify keeps quotes, apostrophes and slashes in the ids it generates, so a
  heading containing one of those and no explicit `{#id}` is "unstable": a link to it is
  a NOTE (give the heading an explicit id and link to that), and every such heading gets
  one NOTE of its own. An anchor matching no stable heading and no explicit id is HARD.
- snippets and images: a page renders a snippet with `import Name from '/snippets/x.mdx';`
  and `<Name />`. A missing file is HARD, because Mintlify fails that page's build and
  keeps serving its previous build while every check stays green. An import that is never
  rendered and a snippet no page imports are NOTEs. Images are checked by their `src`, when it is
  double-quoted and starts at the docs root (`src="/images/x.png"`); any other form is not read.
  Paths are compared in exact letter case, on Windows too: Mintlify builds on Linux.
- tables: what Mintlify does to a table is invisible in the source. A delimiter row that
  does not match its header in cell count is HARD, because the block then renders as a
  paragraph of raw pipes (reference/limits shipped five of those in #518). A straight
  double quote that opens a cell is HARD too: Mintlify's smart quotes render it as a
  closing mark, so type that quotation with curly marks (the docs had 93 before #526). One
  that closes a cell straight after a colon or a parenthesis is HARD the same way: it
  renders as an opening mark. A
  table of five or more columns is a NOTE. The theme gives every cell a 150 px floor, and
  `docs/style.css` lowers it only for a table with a fourth header cell, so that the
  four-column comparison grid on choosing-floe fits at 1280. Three columns is still the
  rule for any other table.
- frontmatter: `--` in a title, sidebarTitle or description is HARD. Mintlify renders it
  as an em dash in the visible page, so a flag named there comes out wrong. A page with no
  sidebarTitle is a NOTE (the sidebar falls back to the title).
- headings: nothing in this repo compiles MDX, here or in CI. A heading that quotes a
  string with a placeholder, `### Could not read <name>`, is a tag that never closes, and
  the page stops compiling on Mintlify while every check stays green (it happened on a
  release day). MDX reads any `<` with no space after it as the start of a tag, so HARD
  is: a tag opened and not closed in the same heading (`<br>` without its slash too), a
  closing tag with nothing open, and a `<` that starts no tag (`<2 GB`, `<=`, an autolink
  such as `<https://floe.one>`). Write `&lt;` or put the text in backticks. Not flagged,
  because MDX accepts them: `< 2 GB` with a space, a tag that closes, a `>` inside a
  quoted attribute or an attribute's braces, a `[text](<dest>)` link destination, and
  anything inside braces, which the script skips whole and never judges (`{#id}` is
  Mintlify's own). The rule is held to @mdx-js/mdx 3.1.1 by a table in the test file.
  Body text is not checked: a raw `<word>` in a paragraph or a table cell breaks the page
  the same way, and only the rendered page will show it, so open every page you touched
  on the preview.
- nav and footer: a page listed twice in docs.json is a NOTE. So is each item where
  docs.json `footer.links` and Footer.tsx `columns` differ; the script cannot know which
  side is right.
- client docs paths: the web client links into the docs through the `/docs` rewrite, so a
  path it writes without the site origin (`REQUEST_LINK_DOCS_PATH` in
  client/lib/request/constants.ts) is checked like any other link. Move a docs section and
  this is the link nobody remembers.
- labels: prints each term-like link label against the target's title, sidebarTitle,
  anchor heading, and nav group. Report-only on purpose (a naive label heuristic is
  noisy). The #338 rule: a term-like label names the page by its title or sidebarTitle,
  case-sensitive. Escapes: prose labels (lowercase first word, backticks, more than 12
  words) and changelog.mdx. Never tune the escapes until it says nothing.
- env defaults: a contradiction is HARD in docs/self-hosting/configuration.mdx (the
  Default column of a server row; the table is found by its Variable, Service and Default
  column names, so it may gain, lose or reorder other columns, but renaming one of those
  three makes the page yield no rows, which is HARD) and in the CONTRIBUTING.md tables (`default:` in
  backticks); it is a NOTE in server/.env.example (the value line and the comment above
  it), .env.docker.example, docker-compose.yml `:-` defaults and unraid/\*.xml. Presence
  gaps are NOTEs; the deliberate subsets in SELF_HOSTING.md and unraid/ are one info
  line each (the `CURATED` constant). When the server reads more keys than
  `SERVER_KEY_FLOOR`, a NOTE says the floor is behind: raise the constant in the PR that
  adds the key (fewer keys than the floor is the HARD above). Only the summary table of
  configuration.mdx is compared: the entry per variable under "Variable reference" states
  windows, limits and behavior in sentences, and those are yours to read.
- What no script sees: stale comments, numbers inside sentences, "always" and "never"
  claims. That is layer 2.

Tests: `node --test .claude/skills/docs-verify/scripts/docs-check.test.mjs` (a directory
argument fails on Node 22). That file is a self-test of the script over the tree the
skill lives in, with injected defects; it says nothing about the PR you are checking.
Run the script itself for that.

### After the PR exists: the rendered check

Some defects only exist once Mintlify has rendered the page, and the source looks fine:
a table that did not parse, a table wider than its box, a quotation mark turned the wrong
way, a flag broken at its hyphens, a contents list that outgrew its box. Once the PR has a
preview, run

    node .claude/skills/docs-verify/scripts/render-audit.mjs --base <preview origin>

and again with `--base https://www.floe.one/docs` after the merge. It loads every page in
the navigation in a headless browser and prints one block per width and theme. Playwright
comes from client/node_modules, so the client install has to exist, and so do the browser
binaries (`corepack pnpm exec playwright install chromium` in client/, plus firefox or
webkit when you ask for them); from a linked worktree that has no install, add
`--playwright <a checkout that has it>`, which leaves the docs source being compared where
it is. CI does not run it.

Exit 1 means a table in the source did not come out as a table, a delimiter row is showing
as text, a page did not answer 200 or did not load, a page came without its chrome (no logo
in the navbar or no links in the sidebar), or fewer pages loaded than were asked for. Exit 2
is a usage error, a root with no docs/docs.json, or no Playwright to load. The chrome line
is there because a preview once served its front page with no site configuration: status
200, the article whole, no logo, no sidebar links, and the audit ended "0 hard". A page
that looks bare is given 4 seconds and measured again before it counts. A preview page
fetched seconds after a push can be cached in that state, so wait for the PR's Mintlify
check before the first run.

Every other number is for you to compare with the last run: on 2026-10-11 production read 0
tables wider than their box at 1280, 0 wrong-way quotation marks of 786, 262 inline code
chips split of 2,913, and no contents list over 30 entries.

| Flag                                | Default                   | What it does                                                                                                                 |
| ----------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--base <url>`                      | none, required            | The docs root: the preview origin, or `https://www.floe.one/docs`                                                            |
| `--pages a,b`                       | every page in the nav     | Only these pages, by their nav path                                                                                          |
| `--widths 1280,390`                 | `1280,390`                | Viewport widths, one pass each                                                                                               |
| `--themes light,dark`               | `light,dark`              | Measured once per theme on each load                                                                                         |
| `--engines chromium,firefox,webkit` | `chromium`                | Repeats the run in each engine                                                                                               |
| `--jobs 4`                          | `4`                       | Pages loaded at once; a whole number, 1 or more                                                                              |
| `--out file.json`                   | not written               | Every measurement, for a later diff                                                                                          |
| `--css <file>`                      | none                      | Adds a candidate stylesheet to every page: how a `docs/style.css` rule is measured against production before it is committed |
| `--root <repo>`                     | the repo the script is in | Where the docs source and docs.json are read from                                                                            |
| `--playwright <repo>`               | the same as `--root`      | The checkout whose client install has Playwright                                                                             |

The pass or fail call on the chrome lives in `scripts/render-verdict.mjs`, and
`node --test .claude/skills/docs-verify/scripts/render-audit.test.mjs` tests it with no
browser and no install.

Run it again after any fix made in response to it. reference/limits broke because a fix
that followed a rendered check was merged without a second look at the rendered page.

## 2. Claim check

Open references/claim-map.md. For every sentence you touched, and every sentence that
states a number, flag, default, version, or protocol fact about the thing you changed,
open the symbol the map names and diff the sentence against it. Code is the truth unless
the PR is intentionally changing behavior, in which case code and every doc surface move
in the same PR. The map names where a value is stated; grep the old literal repo-wide
before finishing, the map is not exhaustive.

Rules that keep biting (each cost a real PR):

- Sweep ALL of docs/ for every label pointing at the page you touched. #330 scanned one
  subdirectory, #332 finished it, #338 still found 14 labels across 11 files.
- Mintlify's PR preview serves at the root with no /docs prefix; production has it.
  Take the URL from the bot comment, never construct it.
- docs/-only PRs go CI green in about a minute, and .claude/skills/-only PRs in a minute or
  two (`Repo guardrails` plus `Skill test suites`); any other path is the full matrix
  (CLAUDE.md "CI").
- configuration.mdx is canonical for env vars. A key or default change touches every
  surface that states it: CONTRIBUTING.md (two tables), server/.env.example,
  .env.docker.example, docker-compose.yml, unraid/\*.xml, and the prose in CLAUDE.md and
  docs/reference/architecture.mdx, which carry numbers too. SELF_HOSTING.md and unraid
  omit some keys on purpose, and compose carries no defaults for most of them.
- A server default change gets a changelog line under the next `v*` entry only if a
  self-hoster can notice it (a limit, a port, a behavior); an internal constant does not.
- Vale runs on Mintlify's side; `dashes` is the local proxy for EmDash.yml, spelling has none (CLAUDE.md "Writing Style").
- Footer.tsx `columns` and docs.json `footer.links` are mirrors; change both.

## 3. Done means

Script exit 0, every NOTE adjudicated in the PR body or fixed, every touched claim diffed
against its symbol, and the test plan names the preview pages you opened, once the PR
exists (before that, the script run and the claim diff are the whole check). Green is a
gate, not proof of correctness: the script cannot see a wrong number inside a sentence,
a stale comment, or a claim about behavior.

## Pointers

- CLAUDE.md "Documentation Site", "Writing Style", and "CI"
- CONTRIBUTING.md "Documentation (Only needed if you're changing docs)" and "Pull Request Process" step 10
- Memory: reference_page_title_mechanics, project_footer_content_model, project_mintlify_preview_check_flake
