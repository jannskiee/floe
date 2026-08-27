---
name: 'docs-verify'
description: 'Docs pre-flight for Floe: docs-check.mjs (links, nav, frontmatter, link labels, env-var fan-out, em dashes), then the claim map to diff each user-facing claim against its source symbol. Use when editing docs/**, README.md, CONTRIBUTING.md, SELF_HOSTING.md, DESKTOP.md, or .github templates, or when adding, renaming or changing a user-facing flag, limit, env var, default, or CLI string that the docs quote or should quote.'
---

# docs-verify

Two layers. The script settles what a script can settle; you settle the rest against source.

## 1. Mechanical pre-flight

From the repo root:

    node .claude/skills/docs-verify/scripts/docs-check.mjs [all|links|nav|frontmatter|labels|env|dashes] [--root <dir>]

`all` is the default; a single check name runs only that check; `--root` points it at
another checkout (default: the repo the script lives in).

Exit 1 is a decidable defect: a link target or anchor that does not exist, a nav entry
without a file or a page outside the nav (or a docs.json the script cannot parse or walk),
a page with no frontmatter block or missing title or description, an em or en dash, a
documented server default that contradicts server/server.js, or the env extractor's
self-check finding fewer keys than server.js reads. Fix, rerun. Exit 0 with NOTE lines is
the normal outcome. Read every NOTE and decide; do not skim.

- anchors: Mintlify keeps quotes, apostrophes and slashes in the ids it generates, so a
  heading containing one of those and no explicit `{#id}` is "unstable": a link to it is
  a NOTE (give the heading an explicit id and link to that), and every such heading gets
  one NOTE of its own. An anchor matching no stable heading and no explicit id is HARD.
- labels: prints each term-like link label against the target's title, sidebarTitle,
  anchor heading, and nav group. Report-only on purpose (a naive label heuristic is
  noisy). The #338 rule: a term-like label names the page by its title or sidebarTitle,
  case-sensitive. Escapes: prose labels (lowercase first word, backticks, more than 12
  words) and changelog.mdx. Never tune the escapes until it says nothing.
- env defaults: a contradiction is HARD in docs/self-hosting/configuration.mdx (the
  Default column of a server row) and in the CONTRIBUTING.md tables (`default:` in
  backticks); it is a NOTE in server/.env.example (the value line and the comment above
  it), .env.docker.example, docker-compose.yml `:-` defaults and unraid/\*.xml. Presence
  gaps are NOTEs; the deliberate subsets in SELF_HOSTING.md and unraid/ are one info
  line each (the `CURATED` constant).
- What no script sees: stale comments, numbers inside sentences, "always" and "never"
  claims. That is layer 2.

Tests: `node --test .claude/skills/docs-verify/scripts/docs-check.test.mjs` (a directory
argument fails on Node 22). That file is a self-test of the script over the tree the
skill lives in, with injected defects; it says nothing about the PR you are checking.
Run the script itself for that.

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
- docs/-only PRs go CI green in about a minute; any other path is the full matrix (CLAUDE.md "CI").
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
