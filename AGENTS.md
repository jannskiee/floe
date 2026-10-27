# AGENTS.md

Rules for coding agents that work on Floe for an outside contributor, and for the person who runs them. They do not apply to the maintainer, the GitHub account jannskiee. [CONTRIBUTING.md](CONTRIBUTING.md) has the detail behind each rule. Where this file is stricter than CONTRIBUTING.md (an agent works only on an issue assigned to its account), that is on purpose.

## Before you write code

- Work only on an issue that is assigned to the account that will open the pull request. On a good first issue, start a comment with `/take` to claim it: a bot assigns the account or replies with the reason it can't. On any other issue, comment to ask for it. Then wait to be assigned. A pull request for an issue that is assigned to someone else is closed.
- For a change that has no issue, open an issue that describes it first, and wait for the maintainer's answer.
- One issue per pull request. An account can hold at most two open pull requests here, drafts included.
- Good first issues are for a first pull request here. After one is merged, pick an issue labeled help wanted instead.
- Read the whole issue first. Its tests, its acceptance list and its out-of-scope notes are the specification.

## While you work

- Write every test the issue names. A test that guards a fix must fail on `main` and pass with the change; a test the issue asks for only to pin what already works passes on both. Never delete or weaken an existing test to make a suite pass.
- Run the checks for the parts you touched, as CONTRIBUTING.md lists them under "What CI runs, and how to run it locally". Four of them run on every pull request, whatever it touched; run them from the repository root: `node .claude/skills/untrusted-peer-data/scripts/check-consumers.mjs`, `node .claude/skills/docs-verify/scripts/docs-check.mjs all`, `node --test ".github/scripts/*.test.mjs"` (they read CONTRIBUTING.md's headings) and `node --test ".claude/skills/**/*.test.mjs"` (some of those tests read product strings).
- Format every Go file you changed with `gofmt -w`.
- A value the other peer sent (a file name, a size, a count, a code) is untrusted. Read `.claude/skills/untrusted-peer-data/SKILL.md` before you display, log, store or compare one.
- User-facing text (window titles, status lines, errors, CLI output, docs) is product copy. Change it only where the issue asks. The request-link strings in `desktop/frontend/src/requestCopy.ts`, `client/lib/request/visitorCopy.ts` and `cli/cmd/floe/sendto.go` are frozen.
- Write American English, and use no em dash or en dash in Markdown: docs-check fails on both.
- Add no new dependency unless the issue asks for one.

## Files

You may also change these when your change needs it:

- the row in `.claude/skills/docs-verify/references/messages.json` for a message of the web app, the website, the server or the install scripts that you add or reword, then rewrite `docs/messages.mdx` with `node .claude/skills/docs-verify/scripts/messages-index.mjs --write`. Leave the CLI and desktop rows alone: they are held to a release snapshot that only the maintainer moves;
- a row in `.claude/skills/untrusted-peer-data/references/consumer-map.md` for new code that reads a value the other peer sent;
- one bullet in the `Unreleased` entry of `docs/changelog.mdx` (start that entry, as CONTRIBUTING.md describes, if the newest entry already carries a release tag).

Leave these alone unless the issue asks for a change in them:

- `AGENTS.md`, `CLAUDE.md` and every other file under `.claude/`, and any new `CLAUDE.md`, `AGENTS.md`, `.claude/` directory or `.mcp.json` anywhere in the tree;
- everything under `.github/`, including the workflows, `dependabot.yml`, `zizmor.yml` and the templates;
- lockfiles (`client/pnpm-lock.yaml`, the `package-lock.json` files, `go.sum`);
- the release files: `.goreleaser.yml`, `client/lib/desktopRelease.ts` and the version in `desktop/wails.json`.

## Maintainer only

Tags, releases, the Microsoft Store, code signing and its certificates, repository settings, approving runs and merging belong to the maintainer. So do these project skills under `.claude/skills/`: ship-it, floe-release, store-submit, transfer-audit (it runs real transfers against the production server) and deep-clean. Do not run them.

## The pull request

- Title: `type(scope): subject`, lowercase and imperative, never the issue's own title. Types: fix, feat, docs, test, refactor, chore, ci. Common scopes: client, server, cli, engine, transfer, desktop, docs, ci, deps, skills, e2e.
- Body: the template. `Closes #N` first, then a short Summary, the Test plan (the commands you ran and what they printed) and the Changelog line.
- Changelog: a bullet in the `Unreleased` entry of `docs/changelog.mdx` that ends `Contributed by [@your-handle](https://github.com/your-handle).`, or write "needs a bullet", or "not user-visible".
- No AI credit: no `Co-authored-by` trailer for a tool and no "Generated with" footer, in commits or in the pull request.
- Keep the pull request text short, and answer review comments in the contributor's own words.
