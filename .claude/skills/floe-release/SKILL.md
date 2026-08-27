---
name: floe-release
description: 'Use when cutting a Floe release (a v* or desktop-v* tag): the changelog entry, the release version pins and DESKTOP_VERSION in client/lib/desktopRelease.ts, verifying release assets, or the Microsoft Store submission. Gives the verified order, the paired-release decision and the UTC date rule; the wrong order points floe.one/download at a 404. Not for dependency, action or toolchain bumps.'
---

# Floe release runbook

Two tag series, one order. `references/tag-and-workflows.md` says what each
tag fires. Symbols, not lines: `DESKTOP_VERSION` and `DESKTOP_RELEASE_DATE`
live in `client/lib/desktopRelease.ts`; the changelog contract is the MDX
comment at the top of `docs/changelog.mdx`; the pin checker is
`scripts/check-version-pins.mjs`.

The skill's paths exist on `main` only once PR #343 has merged; from an older
checkout, run the script by its absolute path from a checkout that has it.
The CI asset step lands with the same PR.

Green workflows and four 200s prove that the assets exist at the URLs
/download will derive; they prove nothing about the update notice, the Store
listing, or whether the changelog says the right thing, which is what steps 7
and 8 are for.

## 0. Shape of the release (pairing decision)

- Any `cli/engine` change a desktop user can notice ships on both series,
  because the desktop is built from `cli/engine`. Receiver-side is the case
  where both must be cut from the same commit and announced together: a change
  to what the RECEIVING peer does with bytes or messages
  (`cli/engine/transfer/receiver.go`, or anything the desktop reaches through
  `ReceiveFilesWithOptions`) protects nobody until the receiving peer carries
  it, and the receiver's build decides the outcome (memory
  `reference_datachannel_early_message_race`; read its correction note before
  quoting any of its numbers).
- Sender-only CLI command, server, or web change? `v*` alone (images ride
  `v*`).
- `desktop/` or `desktop/frontend` only? `desktop-v*` alone.
- Nothing user-visible on a surface? No changelog entry for it; the tag still
  needs a new number.

Never reuse a `v*` number: the `release-tags` ruleset blocks deletion and
update of `refs/tags/v*`, so a pushed CLI tag is permanent, failed run or not.
No ruleset covers `desktop-v*`: a desktop tag whose run failed can be deleted
and re-cut with the same number ("If a workflow fails" under step 4), but a
number the Store has accepted can never be reused or lowered.

## 1. Code merges

All fix PRs merged, CI green. No code in the prep PR.

## 2. One prep PR: changelog + pins

- Entry per the contract in `docs/changelog.mdx`. Date = the tag's UTC date
  (step 3 has the command for today's UTC date). Write the date you will tag
  on (UTC) and tag the same UTC day; if the day slips, correct the
  `description` in the follow-up PR (labels are immutable once shipped,
  descriptions are not). If tagging is not imminent, label it `Unreleased` and
  relabel later (DESKTOP.md step g; precedent d7e432f, #296).
- For a PAIRED release the relabel is a SPLIT: the single `Unreleased` entry
  becomes two entries with the same UTC date, each with its own bold headline.
  `desktop-vX.Y.Z` comes first, tags starting with `Desktop`, carrying the
  bullets a desktop user notices, in desktop wording. Then `vX.Y.Z`, tags
  `CLI` first and then `Web` / `Self-hosting` as applicable, carrying the CLI
  bullets, the `Web app:` bullet, and a `Self-hosting:` images-rebuilt bullet
  whenever `server/` or `client/` changed. d7e432f (#296) is the precedent. A
  receiver-side change on a PR that is also sender-side or web-side still
  pairs: receiver-side wins.
- `node .claude/skills/floe-release/scripts/check-version-pins.mjs --cli v1.10.5 --desktop desktop-v0.2.8 --phase prep`
  (omit the series you are not releasing). It measures the tree the script
  lives in; `--root <dir>` measures another checkout, such as a scratch
  worktree. By default it sweeps the three newest tags of each series and
  labels every STALE line with the tag it belongs to; `--old-cli` and
  `--old-desktop` (comma-separated) override the sweep. Fix every STALE and
  MISSING line that is a pin and rerun. It does not know which files ought to
  carry a version, so read each hit: a line that is release history (the
  history section of DESKTOP.md, a workflow comment naming a past release)
  stays, so green is not always reachable, and the report says which hits
  you judged to be history.
- Make the prep edits with the Edit tool or PowerShell. A Git Bash `sed -i`
  rewrites a CRLF working copy to LF: harmless to the commit under autocrlf,
  noisy in the working tree (git warns on every touch, and tools that do not
  normalize show every line as changed).
- Do NOT touch `client/lib/desktopRelease.ts`. CI's "Check desktop release
  assets" step fails a bump whose release does not exist, and /download would
  point at 404s. The 0.2.3 bump landed 15 minutes after its assets; that
  margin is the whole reason for the order.
- `desktop/updatecheck_test.go` version strings are fixtures. Never bump.
- Squash-merge, then: `gh pr view N --json mergeCommit --jq .mergeCommit.oid`

## 3. Tag (PowerShell tool; annotated, unsigned, deliberate)

Confirm the push with the user first: a `v*` tag is permanent. `--no-sign`
keeps the tag unsigned whatever `tag.gpgSign` says.

```text
git fetch origin main
git tag -a --no-sign v1.10.5 <sha> -m "v1.10.5"
git tag -a --no-sign desktop-v0.2.8 <sha> -m "desktop-v0.2.8"
git push origin v1.10.5 desktop-v0.2.8
```

Today's UTC date, which the changelog `description` from step 2 must equal on
the day you push:

```text
date -u +%F                                              (bash)
(Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')      (PowerShell)
```

A Manila evening is still "today" in UTC; the UTC date only catches up with
Manila at 08:00, so a tag pushed between midnight and 08:00 Manila carries
yesterday's date.

UTC date of the tag once it exists (this is the changelog date and
`DESKTOP_RELEASE_DATE`):

```text
git for-each-ref --format='%(taggerdate:iso8601-strict)' refs/tags/desktop-v0.2.8
```

## 4. Watch (the last six runs of each workflow all finished within 5 minutes)

```text
gh run list --workflow release.yml --limit 1     (and desktop-release.yml, images.yml)
gh run view <id> --json status,conclusion --jq '.status + " " + .conclusion'
```

gh's embedded jq only: the jq binary is not on this box and a jq-based loop
fails silently (memory `project_pnpm_via_corepack`).

If a workflow fails: desktop-release.yml publishes only at its last step, so a
failed run leaves no release (and any MSIX artifact it uploaded is superseded
by the re-cut run's). Delete the `desktop-v*` tag
(`git push origin :refs/tags/desktop-v0.2.8`, then `git tag -d` locally) and
re-cut the same number on the fixed merge commit; no ruleset covers it. A `v*`
tag is permanent: `gh run rerun <id> --failed` reruns on the same tag, and a
fix that needs new code goes out as the next number. Never re-cut a `v*`.

## 5. Verify assets (all four must answer 200 after redirects)

From the PowerShell tool. Name the binary: Git Bash's `curl` is a Schannel
build here that exits 43 on every https URL, and PowerShell's `curl` is an
alias of Invoke-WebRequest.

```text
curl.exe -sIL -o NUL -w '%{http_code} %{url_effective}\n' <url>
https://github.com/jannskiee/floe/releases/download/desktop-v$V/floe-desktop-setup-$V.exe
https://github.com/jannskiee/floe/releases/download/desktop-v$V/floe-desktop-$V-windows-amd64.zip
https://github.com/jannskiee/floe/releases/download/desktop-v$V/SHA256SUMS.txt
https://github.com/jannskiee/floe/releases/tag/desktop-v$V
```

(In Git Bash: `/c/Windows/System32/curl.exe` with `-o /dev/null`.)

CLI: `gh release view v1.10.5 --json assets --jq '.assets[].name'` lists six
archives plus `checksums.txt`.

## 6. Follow-up PR: desktopRelease.ts

Bump `DESKTOP_VERSION` and `DESKTOP_RELEASE_DATE` together; the date is the
tag's UTC date as "Mon D, YYYY" (`desktopRelease.test.ts` rejects a future
date against the runner's UTC clock; #324's second commit fixed exactly that).
Relabel an `Unreleased` entry now if you used one. Run the checker with
`--phase follow-up`: it reads the tag's date from `git for-each-ref`, so the
tag must exist locally (step 3, or `git fetch --tags`). Without it the checker
stops with exit 2 and "tag desktop-v0.2.8 is not known here: either run git
fetch --tags, or you are running follow-up before step 3 (the tag must exist
first)". With it, it asserts the new pin and the date against the tag. CI's
release-asset step is the merge gate.

## 7. Store submission (one in flight at a time)

One in flight is checkable: Partner Center's overview must show the previous
submission as "In Microsoft Store", not "In certification"; the Start update
button exists only then. MSIX = the desktop-release.yml run's ARTIFACT
`floe-desktop-msix-<X.Y.Z>-run<run_number>`, never a release-page asset:
`gh run list --workflow desktop-release.yml --limit 1` for the run id, then
`gh run download <id> -n <artifact-name>`. The Partner Center click path and
its DOM idioms live in memory (`project_floe_store_identity`: standing
authorization and URLs; `reference_release_automation_traps` and
`project_release_1_10_3_and_0_2_6`: the flow that worked). Paste a plain-text
condensation of the entry into "What's new".

## 8. DESKTOP.md step h

Launch the previous build, confirm the update notice names the new version.
If the previous build is not installed, run
`floe-desktop-<prev>-windows-amd64.zip` from the previous release page; the
notice runs only unpackaged (`desktop/updatecheck.go` returns early for a
packaged build), so the Store install can never show it.

## Done means

All eight steps with evidence in the report. Green workflows and four 200s are
necessary; step 8 and the certification email are the completion signals.
