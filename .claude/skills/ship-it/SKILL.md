---
name: 'ship-it'
description: 'Land a change end to end: classify the CI lane, run the local checks CI would run, make a signed commit from PowerShell with git commit -F, open the PR from a body file, wait for the CI green check by SHA, triage a stuck or red PR, squash-merge with an explicit subject and body. Use for: commit this (even a checkpoint), open a PR, ship it, is CI green yet, the PR is stuck or red, merge it.'
---

# ship-it

## 0. Checkpoint or ship?

"Commit this" can mean a WIP checkpoint. If unclear, ask. Checkpoint = steps 1 and 4
only. Ship = every step. Never skip step 4's signing recipe for either.

## 1. Where am I

- `git branch --show-current` must not be main (main rejects pushes with GH013; no
  bypass, not even the owner). On main: `git checkout -b <free-form name>`.
- `git fetch origin` so origin/main is current (local main has been stale before).
- `git status --short`, stage by name. Never `git add -A` while next dev runs: it writes
  client/AGENTS.md, client/CLAUDE.md and rewrites next-env.d.ts.

## 2. Lane

`git diff --name-only origin/main...HEAD` plus `git diff --name-only --cached`. Same
rule as ci.yml's changes job: any path not under docs/ is code (full matrix, about
10 min); anything under .github/workflows/ or .github/scripts/ also runs actionlint and
shellcheck. references/lanes.md maps touched areas to local commands.

## 3. Local checks

Run only the rows for touched areas. If docs or root markdown changed, run docs-verify
first. Skip what only CI can arbitrate (e2e x3, back-compat, wails/NSIS packaging,
docker-smoke, shellcheck) and say so in the test plan. actionlint is installed here, so
workflow edits get `actionlint -color` locally.

## 4. Commit (PowerShell tool only)

Write the message with the Write tool (UTF-8, no BOM, never Out-File) into the
scratchpad, then in the PowerShell tool: `git commit -F <file>`. Verify:
`git log -1 --format=%G?` prints G. N means Git Bash made it (unsigned, exit 0):
`git commit --amend --no-edit` from PowerShell. "agent returned an error", "failed to
fill whole buffer", "Could not connect to socket" all mean a 1Password approval prompt
is pending: ask the user to approve, retry once, never loop.
Subject: `type(scope): lowercase imperative` (CONTRIBUTING step 9). No Co-Authored-By
trailer (CLAUDE.md, Git Conventions).

## 5. Push and PR

`git push -u origin <branch>`. Write the body file (## Summary, ## Test plan, no AI
footer) and `gh pr create --title "<subject>" --body-file <file>`. Never pass
quote-bearing text inline from PowerShell; PowerShell 5.1 mangles it. A title that
itself contains a double quote goes through the Bash tool instead (gh needs no signing,
so the PowerShell rule does not apply to it).

## 6. Wait

`node .claude/skills/ship-it/scripts/wait-ci.mjs <pr-number>`. Docs lanes finish within
a minute; for code lanes run it with run_in_background (the tool call cap is 600 s, the
script's default timeout is 9 min, rerun to keep waiting). Exit 0 green. 1 red: the
failed job names and a `gh run view <id> --log-failed` command are printed (a gate that
completed as skipped or neutral counts as red). 2 dropped event: run the printed
`gh workflow run ci.yml --ref <branch>` once, then wait again (gh pr checks will not list
dispatched jobs; this script reads check-runs by SHA). 3 timeout. Anything else:
references/blocked-pr.md.

## 7. Merge

`gh pr merge <n> --squash --subject "<subject> (#<n>)" --body-file <same body file>`.
Pass both anyway so the result never depends on the repo setting (it was
COMMIT_MESSAGES until 2026-08-28, which concatenated every branch commit into the squash
body). The subject is verbatim, so you add the (#n). A subject containing a double
quote goes through the Bash tool, as in step 5.

## 8. Confirm

`git fetch origin; git log -1 --format='%h %s' origin/main` shows the subject with (#n)
exactly once (pull main in whichever checkout has it; a linked worktree cannot check it
out). `gh api repos/{owner}/{repo}/branches/<branch>` returns 404 (auto-delete is on).
`%G?` shows E on main: expected (web-flow GPG key), not a failure.

Done means merged, origin/main carries the squash commit, branch gone. CI green is a
gate, not proof: the test plan carries what you actually checked. A green run proves the
suite passed on that SHA and nothing about behavior the suite does not cover.

## Pointers

- CLAUDE.md "CI" and "Git Conventions"
- CONTRIBUTING.md "Pull Request Process"
- .github/PULL_REQUEST_TEMPLATE.md
- Memory: project_one_password_commit_signing, project_powershell_arg_quoting,
  reference_ci_dropped_event_recovery, project_main_ruleset_requires_pr,
  project_pnpm_via_corepack, project_footer_content_model
