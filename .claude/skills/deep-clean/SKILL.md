---
name: deep-clean
description: 'Use when a task, feature, plan or test run is finished and the leftovers should go: deep clean, clean up, tidy up, remove the temp files, delete the test artifacts, revert what the run changed, free disk space, client/.next, session scratchpads, a stray floe.exe, Playwright reports. It surveys read-only first and sweeps only a fenced list, so server/.env, %APPDATA%\floe and received transfers can never be deleted. Not for stopping a running local stack; that is floe-run. Not for undoing the machine changes a transfer audit made; that is transfer-audit cleanup.'
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
  is up. Running it first is what lets the pidfile be cleaned as ordinary
  debris rather than reported as a live stack.
- `node .claude/skills/transfer-audit/scripts/audit.mjs cleanup --out <dir>`
  if a transfer audit ran. That is the only thing that restores the real
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
  `wails` binaries, temp probe scratch, and session scratchpads that are
  empty or untouched for over `--scratch-days` (default 7).
- `ask first`, listed but never swept implicitly. Anything with a real
  reinstall cost or a judgment call in it: `node_modules`, the root
  `floe.exe` that shadows the scoop shim, `client/AGENTS.md` and
  `client/CLAUDE.md` (next dev writes them but they can carry hand-written
  content), `desktop/build/bin`, untracked and unignored directories, audit
  evidence, recent scratchpads.
- `held`, safe by rule but touched within `--age-minutes` (default 30).
  This is the concurrent-session guard. Several sessions run against this
  checkout at once, and a held item usually belongs to one of them.
- `fenced`, considered and refused, printed so the refusal is visible rather
  than silent. A directory is refused for what it carries as well as for
  what it is, so a scratchpad holding a stray `.env` is fenced even though
  the scratchpad itself is disposable.

A `+` after a size means byte counting stopped and the figure is a lower
bound. Sizes on a pnpm tree are misleading anyway: most of `node_modules` is
links into a shared store, so deleting it frees far less than it reports.

Below the table, `not swept, reported only` names state this skill will not
touch: the Go build cache (`go clean -cache` owns it), git stashes,
local-only branches, and worktrees.

Exit codes: 0 nothing to do, 1 candidates found, 2 usage, 3 precondition,
4 fence tripped, 5 a removal failed.

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
A second sweep exits 0.

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

- `client/next-env.d.ts` is tracked and rewritten by `next dev`. Restore it
  with `git checkout -- client/next-env.d.ts` after the stack is stopped.
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

`--firewall` lists rules naming a Floe binary whose file is gone. These
accumulate from the Windows consent dialog, not from any skill. Two of them
are Block rules for a `floe-ui` path that no longer exists and are the
recorded cause of `connect-timeout` SKIPs in later audits. Report them.
Removing them is the user's decision, in an elevated shell, and the disabled
`Floe relay test` rule is deliberate: never delete it and never enable it.

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
  (`node --test`, 38 cases; the two `regressions` blocks are defects two
  red teams reproduced on 2026-09-02, several of which deleted committed
  files)
- `node .claude/skills/deep-clean/scripts/deep-clean.mjs --self-test`
  (22 fence assertions, no filesystem writes)
- `.claude/skills/floe-run/SKILL.md` (the stack, the pidfile, the stats sentinel)
- `.claude/skills/transfer-audit/SKILL.md` section 6 (the machine-state restore)
- CLAUDE.md "Desktop (Wails)" for the `//go:embed` trap on `desktop/frontend/dist`
- Memory: project_floe_local_install_hygiene, reference_transfer_audit_harness,
  project_two_machine_setup
