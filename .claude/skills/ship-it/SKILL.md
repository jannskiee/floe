---
name: 'ship-it'
description: 'Land a change end to end: classify the CI lane, run the local checks CI would run, sign the commit from PowerShell (git commit -F), open the PR from a body file, wait for the CI green check by SHA, triage a stuck or red PR, squash-merge with explicit subject and body. Use for: commit this (even a checkpoint), open a PR, ship it, is CI green yet, the PR is stuck or red, merge it. Not for cutting a v* or desktop-v* release; that is floe-release.'
---

# ship-it

Paths below are relative to the repo root. From a worktree or checkout that
predates the skill, use the absolute path to one that has them, and read this file
from that checkout too.

## 0. Checkpoint or ship?

"Commit this" can mean a WIP checkpoint. If unclear, ask. Checkpoint = steps 1 and 4
only. Ship = every step. Never skip step 4's signing recipe for either.

## 1. Where am I

- `git branch --show-current` must print a non-main branch name (a detached HEAD prints
  nothing and passes a naive "not main" check). main rejects pushes with GH013; no
  bypass, not even the owner. On main: `git checkout -b <free-form name>`.
- When the change lives in another clone than the folder the session started in, every
  git command is `git -C <absolute clone path>`. `gh` has no `-C`: run it from inside
  the clone (Bash tool: `cd <clone> && gh ...`) or name its target (`--repo
  <owner>/<name>`, and `--head <branch>` on `gh pr create`), and run the local checks
  from the clone with the clone's own scripts, since the session folder's copies may
  be older. In the PowerShell tool a failed
  `Set-Location` does NOT stop the chain: the commands after it run in the session's
  own folder, and on 2026-09-25 that detached the owner's checkout. Never chain a git
  write after a bare `Set-Location`.
- `git fetch origin` so origin/main is current (local main has been stale before).
- `git status --short`, then stage by name, now: unstaged edits classify as nothing in
  step 2. Never `git add -A` while next dev runs: it rewrites the tracked
  client/next-env.d.ts (the client/AGENTS.md and client/CLAUDE.md it writes are
  gitignored). `next build` rewrites client/next-env.d.ts too, so after a local build
  run `git checkout -- client/next-env.d.ts` before staging anything under client/.

## 2. Lane

`git diff --name-only --cached` plus `git diff --name-only origin/main...HEAD` (staged
first, per step 1; an unstaged edit is invisible to both). Same rule as ci.yml's
`Detect changed paths` job: any path that is under neither docs/ nor .claude/skills/
is code (full matrix; ten code PRs took 9 to 15 minutes). A PR whose every file is
under docs/ or .claude/skills/ skips the heavy jobs: docs only, skills only, or the
two together, which is not a full-suite PR. `Repo guardrails` and
`Skill test suites` run on every PR whatever it touched, and both are in the gate;
anything under .github/workflows/ or .github/scripts/ also runs `Lint workflows`
(actionlint and shellcheck).
references/lanes.md maps touched areas to local commands.
A dependency PR (Dependabot) needs checks that CI cannot make: read
references/dependency-prs.md before merging one.

## 3. Local checks

On every lane, first: `node .claude/skills/docs-verify/scripts/docs-check.mjs all`.
The gate runs it on every PR (the docs pre-flight step of `Repo guardrails`), and it
reads code as well as docs: a changed server default, or a floe.one/docs link in Go,
TypeScript, a workflow, .github Markdown or README.md, SELF_HOSTING.md, CONTRIBUTING.md,
DESKTOP.md or SECURITY.md, fails it on a PR that touched no page. (For a
docs change this is layer 1 of docs-verify; the claim walk is the author's job before
this point.) Then run only the rows for touched areas. Skip what
only CI can arbitrate and say so in the test plan: `E2E (browser + CLI interop, <os>)`
x3, `Back-compat (HEAD vs latest release)`, the packaging steps of `Desktop (Wails,
windows-latest)`, `Docker (self-hosting stack)`, and the shellcheck half of `Lint
workflows`. actionlint is installed here, so workflow edits get `actionlint -color`
locally.

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

`git push -u origin <branch>` (either tool; no signing involved). Write the body file
(## Summary, ## Test plan, no AI footer) with the Write tool, in a step of its own,
and read it back before anything uses it. Then
`gh pr create --title "<subject>" --body-file <file>`. Never put a file write and the
command that consumes it in one batch of tool calls: on 2026-10-12 the write of a body
file failed, the `gh pr merge` batched beside it still ran, and the squash commit of
#526 carries a placeholder body on main. Never pass quote-bearing text
inline from PowerShell: PowerShell 5.1 mangles interior double quotes, and its
double-quoted strings also expand `$name` and backticks. A title containing `"`, `$` or
a backtick goes through the Bash tool instead (gh needs no signing, so the PowerShell
rule does not apply to it). The same goes for every `gh ... --jq '<expression>'` whose
expression has a space in it: from the PowerShell tool gh answers "accepts at most 1
arg(s)", so run those from the Bash tool.

## 6. Wait

`node .claude/skills/ship-it/scripts/wait-ci.mjs <pr-number>` (either tool). Never
pipe it (`| tail`, `| Select-Object`): the pipe's exit code replaces the script's, and
a red run has read as green that way. Run it bare and read its last line. Docs
and skills lanes finish in about three minutes (`Skill test suites` on
windows-latest is the job they wait for). For a code lane run it with
run_in_background and `--timeout-min 20`: the default of 9 minutes is deliberate (it
fits under the 600 s cap of a foreground tool call) and is shorter than most code
runs, so a foreground wait on a code PR ends in exit 3. Exit 0
green. 1 red: the failed job names and a `gh run view <id> --log-failed` command are
printed (a gate that completed as skipped or neutral counts as red); that command
answers "still in progress" until the WHOLE run has ended, not just the failed job.
2 dropped event:
run the printed `gh workflow run ci.yml --ref <branch>` once, then wait again (gh pr
checks will not list dispatched jobs; this script reads check-runs by SHA). 3 timeout:
nothing failed, the script stopped waiting; run it again. 4: fix the target (see
references/blocked-pr.md), do not retry. Anything else: references/blocked-pr.md.

## 7. Merge

A step of its own, after the body file was written and read back (step 5).

`Skill test suites` has been in the gate's `needs` since 2026-10-13 and runs on every
PR, so exit 0 from the wait covers it and no job is read by name any more.

The ruleset does not require a branch to be up to date, so `CI green` on a PR says
nothing about what merged after its branch was cut. In a series of PRs, branch each one
after the one before it has merged, or merge `origin/main` into it and let the checks
run again before merging.

`gh pr merge <n> --squash --match-head-commit <full sha> --subject "<subject> (#<n>)" --body-file <same body file>`.
The SHA is the head the checks ran on, read with
`gh pr view <n> --json headRefOid --jq .headRefOid` and pasted, never typed: gh wants
all 40 characters and refuses anything else. It makes the merge fail when the branch
head is no longer the commit you checked (a bot rebased it, someone pushed), instead
of merging whatever is there now. Pass the subject and body anyway so the result never
depends on the repo setting (it was
COMMIT_MESSAGES until 2026-08-28, which concatenated every branch commit into the squash
body). The subject is verbatim, so you add the (#n). A subject containing `"`, `$` or a
backtick goes through the Bash tool, as in step 5.

## 8. Confirm

`git fetch origin; git log -1 --format='%h %s' origin/main` shows the subject with (#n)
exactly once (pull main in whichever checkout has it; a linked worktree cannot check it
out). `gh api repos/{owner}/{repo}/branches/<branch>` returns 404 (auto-delete is on).
`%G?` shows E on main: expected (web-flow GPG key), not a failure.

Done means merged, origin/main carries the squash commit, branch gone. CI green is a
gate, not proof: the test plan carries what you actually checked. A green run proves the
suite passed on that SHA and nothing about behavior the suite does not cover.

After a merge that touches .claude/skills/ or CLAUDE.md, one more thing: the project
folder that sessions start in loads its own copy of both, so it needs
`git pull --ff-only` before a new session sees the change. Until then every session
opened there runs the old skill. That folder is the owner's: say so in the report and
let them pull, or pull it yourself only when they have told you to.

## Pointers

- CLAUDE.md "CI" and "Git Conventions"
- CONTRIBUTING.md "Pull Request Process"
- .github/PULL_REQUEST_TEMPLATE.md
- Memory: project_one_password_commit_signing, project_powershell_arg_quoting,
  reference_ci_dropped_event_recovery, project_main_ruleset_requires_pr,
  project_pnpm_via_corepack, project_footer_content_model
