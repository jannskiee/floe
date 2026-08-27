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

- Entry per the contract in `docs/changelog.mdx`. Date = the tag's UTC date.
  Write the date you will tag on (UTC) and tag the same UTC day; if the day
  slips, correct the `description` in the follow-up PR (labels are immutable
  once shipped, descriptions are not). If tagging is not imminent, label it
  `Unreleased` and relabel later (DESKTOP.md step g; precedent d7e432f, #296,
  which relabeled one `Unreleased` entry into desktop-v0.2.4 and v1.10.1).
- `node .claude/skills/floe-release/scripts/check-version-pins.mjs --cli v1.10.5 --desktop desktop-v0.2.8 --phase prep`
  (omit the series you are not releasing). Fix every STALE and MISSING line,
  rerun until green. It measures the pin surface; it does not know which files
  ought to carry a version, so read each hit.
- Do NOT touch `client/lib/desktopRelease.ts`. CI's "Check desktop release
  assets" step fails a bump whose release does not exist, and /download would
  point at 404s. The 0.2.3 bump landed 15 minutes after its assets; that
  margin is the whole reason for the order.
- `desktop/updatecheck_test.go` version strings are fixtures. Never bump.
- Squash-merge, then: `gh pr view N --json mergeCommit --jq .mergeCommit.oid`

## 3. Tag (PowerShell tool; annotated, unsigned, deliberate)

Confirm the push with the user first: a `v*` tag is permanent.

```text
git fetch origin main
git tag -a v1.10.5 <sha> -m "v1.10.5"
git tag -a desktop-v0.2.8 <sha> -m "desktop-v0.2.8"
git push origin v1.10.5 desktop-v0.2.8
```

UTC date of the tag (this is the changelog date and `DESKTOP_RELEASE_DATE`):

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
`--phase follow-up` (asserts the new pin and the date against the tag). CI's
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
