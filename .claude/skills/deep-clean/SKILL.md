---
name: deep-clean
description: 'Use when a task, feature, plan or test run is finished and the leftovers should go: deep clean, clean up, tidy up, remove the temp files, delete the test artifacts, revert what the run changed, free disk space, client/.next, session scratchpads, a stray floe.exe, Playwright reports, leftover test homes and audit run folders in the temp directory. It surveys read-only first and sweeps only a fenced list: server/.env, %APPDATA%\floe, the request-link folder Downloads\Floe and floe_transfer_*.zip archives are refused by rule. It lists other clones of the repository, worktrees and merged branches and never removes them. Not for stopping a running local stack; that is floe-run. Not for undoing the machine changes a transfer audit made; that is transfer-audit cleanup.'
---

# deep-clean

One command answers what a finished task left behind, and a second one
removes the part of it that is provably disposable. The dangerous half of
this job is not finding junk, it is not deleting the things that look like
junk and are not, so the never-delete list lives in code as a fence rather
than in prose here. Symbols, not lines: the fence is `DENY_NAME`,
`denyList`, `makeFence` and `scanContents` in `scripts/deep-clean.mjs`, and
the buckets come from `repoRules`, `tempCandidates` and
`scratchpadCandidates`.

Paths below are relative to the repo root.

Which tree gets cleaned is decided by where the script file lives, not by
the folder you run it from. With no `--root`, the script surveys and sweeps
ITS OWN checkout: run the copy in checkout A from a shell in checkout B and
it is A that gets cleaned. To clean another checkout, name it:

```text
node <a checkout that has the skill>/.claude/skills/deep-clean/scripts/deep-clean.mjs survey --root <the checkout to clean>
```

`--root` must be a git checkout with a CLAUDE.md at its top, or the script
stops with exit 3; that is what keeps the deny list anchored. Scratchpads
follow a different rule: a session scratchpad is named for the folder its
session STARTED in, so with `--root <task clone>` the survey finds none of
them, however many sessions worked on that clone. They show up only when
the root is the folder those sessions were opened in.

Two more flags, for scripts and tests: `--json` prints the survey as one
JSON document (`items`, `result`, `extras`), and `--temp-root <dir>` scans
that directory in place of the OS temp directory (the suite's seam; it has
no use in a real cleanup).

Never read a size off, or walk, a tree that is being deleted (a `du`, a
recursive listing, this survey): the walk crashes when the tree goes from
under it, leaves a crash dump in the folder it was started from, and holds
directories open so the deletion fails on them. And prove you left the
project folder as you found it: `git status --porcelain` there, saved before
the task and compared after it.

This skill is a conductor. It kills no process, closes no browser tab and
edits no firewall rule, because `floe-run` and `transfer-audit` already own
those and already verify a pid image and creation time before acting.

Never sweep on someone else's behalf. Show the survey table to the user and
let them read it before anything is removed. Never promote an item out of
the ask bucket without being told which one. Never widen `--age-minutes` to
get past a held item unless you know no other session is running: that guard
is the only thing standing between this skill and another session's
in-flight working data.

## 0. Preconditions (the owners run first, or their state gets orphaned)

- The task whose leftovers you are clearing is actually finished.
- `node .claude/skills/floe-run/scripts/floe-run.mjs stop` if a local stack
  is up. `stop` deletes its own pidfile (`floe-run.json` in the temp
  directory). This skill never does: while that file exists the survey
  lists it under `fenced` as a live stack pidfile, whatever its age, and
  the answer is `floe-run stop`, not a sweep.
- `node .claude/skills/transfer-audit/scripts/audit.mjs cleanup --out <dir>`
  if a transfer audit ran. `<dir>` is that audit's `--out`: the survey names it
  in its `audit-evidence:` and `audit-run:` rows, and a run started without
  `--out` wrote under `lta-runs` in the temp directory. That is the only thing that restores the real
  `%APPDATA%\floe\desktop.json` from its hash-checked backup. Sweeping the
  run directory first destroys the manifest it replays.
- `git status` is understood. An untracked directory in the tree is a
  decision, not debris.

## 1. Survey (read-only, and the only step safe to run unattended)

```text
node .claude/skills/deep-clean/scripts/deep-clean.mjs survey
node .claude/skills/deep-clean/scripts/deep-clean.mjs survey --verbose
node .claude/skills/deep-clean/scripts/deep-clean.mjs survey --firewall
```

Four buckets come back, largest first:

- `safe`, swept by step 2. Build caches, Playwright output, stray `go` and
  `wails` binaries, temp probe scratch, session scratchpads that are
  empty or untouched for over `--scratch-days` (default 7), and the temp
  folders a killed test run leaves behind: `floe-cmd-test-home-<digits>`
  and `floe-desktop-test-home-<digits>` (the Go suites' temporary home),
  `lta-cell-<six characters>` and `lta-request-<six characters>` (the
  transfer-audit suites). Only a directory of exactly that shape counts; a
  name that merely starts the same way is not a candidate.
- `ask first`, listed but never swept implicitly. Anything with a real
  reinstall cost or a judgment call in it: `node_modules`, the root
  `floe.exe` that shadows the scoop shim, `client/AGENTS.md` and
  `client/CLAUDE.md` (next dev writes them but they can carry hand-written
  content), `desktop/build/bin`, untracked and unignored directories, audit
  evidence, recent scratchpads, and every run folder directly under
  `<temp>\floe-audit\` (`audit-run:<name>`). A run folder holds the
  manifest `transfer-audit cleanup` replays, so cleanup runs first. The
  `bin` folder beside them is never a candidate: it is fenced by rule.
- `held`, safe by rule but touched within `--age-minutes` (default 30).
  This is the concurrent-session guard. Several sessions run against this
  checkout at once, and a held item usually belongs to one of them.
- `fenced`, considered and refused, printed so the refusal is visible rather
  than silent. A directory is refused for what it carries as well as for
  what it is, so a scratchpad holding a stray `.env` is fenced even though
  the scratchpad itself is disposable.

What the fence knows about received files, exactly, because "a received
transfer can never be deleted" is more than it can promise: a
`floe_transfer_*.zip` is refused by name wherever it is, and the
request-link default folder, `Downloads\Floe` under the home directory, is
refused by path with everything in it. Nothing else marks a file as
received. `cli/received*` is an `ask` item, and `--include` deletes it. A
request-link drop saved to a folder the owner chose has ordinary names in an
ordinary place: it is safe only as long as that place is outside the
checkout and the temp directory, which are the only two roots this skill
ever deletes under.

A `+` after a size means byte counting stopped and the figure is a lower
bound. Sizes on a pnpm tree are misleading anyway: most of `node_modules` is
links into a shared store, so deleting it frees far less than it reports.

Below the table, `not swept, reported only` names state this skill will not
touch: the Go build cache (`go clean -cache` owns it), git stashes,
local-only branches, and three lists that say where the disk went after a
long task:

- `git worktrees`: every linked worktree, by path.
- `merged branches`: local branches whose every commit is on `origin/main`,
  other than `main` and the branch checked out here. A squash-merged branch
  never shows, because its commits are not on main; this repository
  squash-merges, so an empty list does not mean nothing is finished.
- `sibling clones`: directories beside the root, and directly under the
  home directory, whose `origin` URL is this checkout's. Paths only. They
  are not sized, on purpose.

None of these is a candidate. They have no id, they are not in the `items`
list, and no flag sweeps them: `--include` on one is a usage error. A clone
can hold unpushed commits, a stash, or another session's work in progress.
Removing one is the user's decision, by hand, after looking inside it.

Exit codes: 0 nothing to do; 1 candidates found (survey), or something was
removed or would be (sweep); 2 usage; 3 precondition; 4 fence tripped; 5 a
removal failed.

## 2. Sweep (dry run first, always)

```text
node .claude/skills/deep-clean/scripts/deep-clean.mjs sweep
node .claude/skills/deep-clean/scripts/deep-clean.mjs sweep --apply
```

Without `--apply` it prints the exact list it would remove and removes
nothing. With `--apply` it removes the safe bucket only, re-running every
check immediately before each deletion, and prints each path as it goes so
an interrupted sweep still leaves a record. A path that vanished before the
sweep reached it is reported as such rather than counted as reclaimed. A
removal that fails does not abort the rest; the run exits 5 and names it.
A sweep that removed something exits 1, not 0 (so does a dry run with
something to remove); a second sweep exits 0.

Before the first `--apply`, read the dry run's paths against the `--root`
rule at the top: every one must be under the tree you mean to clean, or
under the temp directory.

## 3. The ask bucket is the user's call, one id at a time

```text
node .claude/skills/deep-clean/scripts/deep-clean.mjs sweep --include root-exe --apply
```

`--include` takes a candidate id, never a path, so it cannot be used to
reach a fenced location. It refuses an id that is tracked, fenced, or was
touched inside the age guard. Say what each promotion costs before naming
it: deleting `client/node_modules` means `corepack pnpm install` before
`next dev` runs again, and deleting the root `floe.exe` changes which binary
`floe` resolves to when the working directory is the repo root.

`--keep <path>` is the opposite lever and only ever narrows the sweep. A
`--keep` that does not exist is a usage error rather than a silent no-op,
because a protection that quietly failed is worse than none.

## 4. Revert is a different job from delete

What a run changed, rather than created, is not swept:

- `client/next-env.d.ts` is tracked and rewritten by `next dev` and by
  `next build`. Restore it with `git checkout -- client/next-env.d.ts`
  after the stack is stopped.
- `desktop/frontend/package.json.md5` is tracked and rewritten by every
  `wails dev` and `wails build`. `wails build` also rewrites the generated
  files under `desktop/frontend/wailsjs/` and `desktop/go.mod` with LF line
  endings: `git diff` shows nothing, `git status` shows them modified in a
  CRLF checkout. Once no wails process is running:
  `git checkout -- desktop/frontend/package.json.md5 desktop/frontend/wailsjs desktop/go.mod`.
  (An md5 that changed because `package.json` really changed is a commit,
  not a revert: read the diff first.)
- The Explorer entry `HKCU\Software\Classes\*\shell\Floe` (the right-click
  "Send with Floe" verb, `contextMenuBase` in `desktop/contextmenu.go`). A
  portable or dev launch of the desktop app, a transfer-audit desktop run
  included, can create it or repoint it at that run's exe. Report only: this
  skill reads no registry and writes none. Read it from the PowerShell tool
  with `reg query "HKCU\Software\Classes\*\shell\Floe" /s` (Git Bash rewrites
  the `/s`), say whether it exists and which exe it names, and leave the
  removal to the user: the installed app owns that key when its own toggle
  is on, and only they know which state they had.
- `%APPDATA%\floe\desktop.json` is restored only by `transfer-audit cleanup`,
  from a sha256-compared backup. Never hand-edit it.
- The stats-counter neutralization in `floe-run` is process-scoped and dies
  with the child. Nothing to revert, and never write it into `server/.env`.
  Setting an Upstash variable to the empty string in PowerShell deletes the
  variable, which lets dotenv refill it from the real file and re-arms the
  live counter.
- A Partner Center draft is server state. `store-submit` section 9 deletes
  one; nothing local does.

## 5. Harness and browser state mostly cleans itself

Claude Code groups the tabs a session opened and closes the group on
`/clear`. Do not close tabs by hand as a teardown step, and never revoke the
Chrome extension site permissions: the user has to re-grant them per site.
For `~/.claude`, use the built-in owner rather than deleting by hand:

```text
claude project purge <path> --dry-run
```

`cleanupPeriodDays` (default 30) already sweeps transcripts, plans, task
lists and file history. Never delete `~/.claude/projects/**/memory` or
`~/.claude/plans`: they belong to no repo, have no remote, and another live
session may be writing to them.

## 6. Firewall (report only, and acting on it needs an elevated shell)

`--firewall` lists rules naming a Floe binary whose file is gone. They came
from the Windows consent dialog, not from any skill: the dialog wrote a
Block rule the moment it opened, and a Cancel left it there. The dialog has
been off on this machine since 2026-09-16, and the rules it had left were
removed that day, so nothing new accumulates: on 2026-10-12 the flag listed
13 rules, every one an Allow for a binary that is gone, and no Block. What
replaced the dialog is silence. A Floe binary at a path with no rule gets no
prompt, and its unsolicited inbound is blocked (firewall event 2011), which
is the usual cause of a `connect-timeout` in an audit cell whose CLI
receiver sits behind a forced relay. That is why `<temp>\floe-audit\bin` is
fenced: a rebuilt binary at a new path starts with no rule. Report what the
flag lists. Removing a rule is the user's decision, in an elevated shell,
and the disabled `Floe relay test` rule is deliberate: never delete it and
never enable it.

## Done means

`survey` exits 0, or exits 1 with only ask items the user has decided to
keep. The reclaimed total was reported. Nothing in the fenced bucket moved,
`git status` shows what it showed before apart from artifacts you named, and
no process was killed by this skill.

Green is a gate, not proof. A clean survey says nothing about state this
script cannot see or deliberately leaves alone: desktop History rows, a
Partner Center draft, bytes already counted by the production stats counter,
Docker images and containers, WSL scratch under `/var/tmp/floe-lta`,
firewall rules it only reports, or work another live session is holding in
memory but has not yet written to disk.

## Pointers

- `scripts/deep-clean.mjs`, and `scripts/deep-clean.test.mjs`
  (`node --test`; the `regressions` blocks are defects two red teams and
  one CI run reproduced, several of which deleted committed files, and the
  `DC2` and `DC3` blocks cover `Downloads\Floe`, the temp leftovers and the
  report-only lists). Every sweep in that suite runs inside a temp root it
  built; never point a test, or an experiment, at a real root with `--apply`.
- `node .claude/skills/deep-clean/scripts/deep-clean.mjs --self-test`
  (the fence assertions, no filesystem writes; it prints how many)
- `.claude/skills/floe-run/SKILL.md` (the stack, the pidfile, the stats sentinel)
- `.claude/skills/transfer-audit/SKILL.md` section 6 (the machine-state restore)
- CLAUDE.md "Desktop (Wails)" for the `//go:embed` trap on `desktop/frontend/dist`
- Memory: project_floe_local_install_hygiene, reference_transfer_audit_harness,
  project_two_machine_setup
