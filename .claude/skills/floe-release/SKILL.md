---
name: floe-release
description: 'Use when cutting a Floe release (a v* or desktop-v* tag): the changelog entry, the release version pins and DESKTOP_VERSION in client/lib/desktopRelease.ts, deploying main to the signaling server before the tag, getting a server fix to self-hosters (ghcr latest moves only on a v* tag), or verifying release assets. Gives the verified order, the paired-release decision and the UTC date rule; the wrong order points floe.one/download at a 404. Not for dependency, action or toolchain bumps, and not for the Microsoft Store (Partner Center) submission itself; that is store-submit.'
---

# Floe release runbook

Two tag series, one order. `references/tag-and-workflows.md` says what each
tag fires and lists the release-day traps. Symbols, not lines:
`DESKTOP_VERSION` and `DESKTOP_RELEASE_DATE` live in
`client/lib/desktopRelease.ts`; the changelog contract is the MDX comment at
the top of `docs/changelog.mdx`; the pin checker is
`scripts/check-version-pins.mjs`.

Paths below are relative to the repo root. From a worktree or checkout that
predates the skill, run the script by its absolute path from one that has it,
and read this file from that checkout too: a session started in a stale
folder loads a stale copy of every skill.

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
- Sender-only CLI command, server, or web change? `v*` alone.
- `server/` or `client/` changed, even with the `floe` binary untouched? Still
  a `v*` tag. The container images ride `v*`, and `latest` moves only on a
  semver tag (the `Metadata` steps of `.github/workflows/images.yml`, default
  `latest=auto`); a merge to `main` publishes `main` and `sha-<short>` and
  nothing else. `docker-compose.yml` runs `${FLOE_IMAGE_TAG:-latest}`, so
  without a tag every self-hoster who changed nothing keeps the old server.
  v1.10.10 was cut for exactly this and for nothing else. floe.one is the
  opposite case: the web app there is on neither version line and runs a
  change as soon as it merges.
- `desktop/` or `desktop/frontend` only? `desktop-v*` alone.
- Nothing user-visible on a surface? No changelog entry for it; the tag still
  needs a new number.
- A release that adds or changes a feature also changes the Store listing,
  not only What's new: the description, the feature list, the screenshots and
  the certification notes (store-submit steps 5a and 5b; done for
  desktop-v0.3.0 and desktop-v0.3.1). Decide it here, because the listing text and screenshots
  have to exist before step 7, and the server has to offer the feature while
  the Store reviews it (step 1a).

Never reuse a `v*` number: the `release-tags` ruleset blocks deletion and
update of `refs/tags/v*` for everyone, so a pushed CLI tag is permanent,
failed run or not. Since 2026-10-26 a second ruleset, `release-tag-writers`
(25870867), restricts creating `v*` and `desktop-v*` tags, and moving or
deleting `desktop-v*` ones, to its bypass, the repository admin role. So only
the owner's own credentials can push a release tag: no installed app, and no
workflow on its `GITHUB_TOKEN`, can. Nobody can move or delete a `v*` tag, the
owner included. A `desktop-v*` tag
whose run failed can still be deleted and re-cut with the same number ("If a
workflow fails" under step 4), but only while the tag has no published
release. Releases are immutable since the same day: once one is published its
assets and tag are locked, and deleting it burns its tag name for good. A
number the Store has accepted can never be reused or lowered either.

## 1. Code merges

All fix PRs merged, CI green. No code in the prep PR.

Before a `v*` release, check the token release.yml publishes with. Names
only, never a value:

```text
gh api repos/jannskiee/floe/environments/release/secrets --jq '.secrets[].name'    (must list TAP_GITHUB_TOKEN)
gh secret list -R jannskiee/floe                                                   (must not)
```

It is a classic personal access token with an expiry, kept only as a secret
of the `release` environment since 2026-10-26. The owner reads its expiry on
github.com/settings/tokens, and GitHub emails before it runs out. If it
expires within 14 days, the owner regenerates it and replaces the
environment secret before the tag. A missing or expired token fails the
Homebrew, Scoop and winget steps after the GitHub release is already
published, and no rerun can finish that (step 4).

### 1a. The live server runs `main` before anything is tagged

Skip this when `server/` is unchanged since the commit the signaling VM runs.
Otherwise do it before the prep PR. A `v*` tag publishes `latest` to every
self-hoster, so it must never carry a server commit that has not run live,
and no workflow deploys api.floe.one: production stays on whatever commit the
VM last pulled until someone pulls there (it was 43 commits behind once).

The owner runs every VM line; the session hands over the command and reads
the result back. Never put a key, a token or an address in a command, a file
or a message: the lines below use the owner's `floe-azure` SSH alias and
nothing else. They are as recorded on 2026-09-11 and 2026-10-09 (clone at
`~/floe`, process `floe-server` under pm2), so read line 1 before trusting
line 3. They work as written in the owner's own PowerShell window. Typed as
a `!` line in this session they run in Git Bash, whose `ssh` cannot reach
the key agent (`Permission denied (publickey)`): there the command starts
`/c/Windows/System32/OpenSSH/ssh.exe floe-azure` instead.

```text
1. ssh floe-azure "cd ~/floe && git rev-parse HEAD"                              (what the VM runs)
2. git diff --name-only <vm-head> origin/main -- server/                          (here; empty means skip 1a)
   git diff --name-only <vm-head> origin/main -- server/package-lock.json         (here; a hit means npm ci in line 3)
3. ssh floe-azure "cd ~/floe && git pull --ff-only && pm2 restart floe-server"   (with a lockfile hit: && cd server && npm ci before the restart)
4. curl.exe -s https://api.floe.one/health                                        (PowerShell tool)
```

Say what becomes public before line 3, in chat, then hand it over: the
restart ends every room and code held in memory. Line 4 must answer
`"status":"healthy"` with an `uptime` of a few seconds (the process really
restarted) and the `features` you expect: `["request-1"]` while request
links are on, `[]` while they are off (`healthHandler` in `server/server.js`).
An unexpected `[]` after a deploy is the release-day trap in the reference
(a glued `.env` line), not a reason to tag anyway.

The request-link kill switch needs no deploy and no restart: the server
re-reads the JSON file named by `POLICY_FILE` on every tick of its 60 s
cleanup interval (`server/policy.js`), and only `{"requestLinks": true}`
turns them on. Putting `{"requestLinks": false}` in that file on the VM (an
owner-run line like the others; write a temp file and rename it over the
real one) turns request links off for every installed build within 60 s,
and `/health` then lists no `request-1`. Name it in the release plan before
the tag, so nobody has to look it up while something is wrong.

## 2. One prep PR: changelog + pins

- The changelog entry carries its FINAL label in this PR, before the tag.
  Both release bodies link `changelog#<the tag, dots as hyphens>` at the
  moment they are published (`release.footer` in `.goreleaser.yml`, the
  `Publish release` step of `.github/workflows/desktop-release.yml`), and that
  anchor exists only when an entry is labeled with the tag. A label that
  arrives after the tag leaves the link at the top of the page. DESKTOP.md
  step g still words this as "relabel at tag time"; the prep PR is that time.
  (#507 is the precedent: both entries labeled, both tags on its merge
  commit.)
- The entry is usually there already, as the standing `Unreleased` entry
  (CONTRIBUTING.md has every user-visible PR add its bullet to it). Rename it,
  do not write a second one:
    - `label` is the tag verbatim.
    - `description` is the UTC date you will tag on (step 3 has the command
      for today's UTC date). Tag the same UTC day; if the day slips, correct
      the `description` in the follow-up PR (labels are immutable once
      shipped, descriptions are not).
    - The bold headline is rewritten to fit the bullets the entry ended up
      with. The standing entry keeps whatever the first PR wrote: on
      2026-10-12 it was a sentence about the install script over eight
      `Web app:` bullets.
    - `tags` lead with the primary surface, the one the headline is about,
      and the rest follow in the contract's order (`Web`, `Desktop`, `CLI`,
      `Self-hosting`). Then re-read the bullet prefixes against rule 6: a
      bullet about any other surface starts with its name (`Web app:`,
      `CLI:`, `Self-hosting:`), so a new primary surface changes which
      bullets need one.
    - Whenever `server/` or `client/` changed, the `v*` entry carries a
      `Self-hosting:` bullet saying the images were rebuilt, paired release
      or not.
    - A bullet that does not ship in this tag stays behind, in a new
      `Unreleased` entry above the renamed one.
- For a PAIRED release the rename is a SPLIT: the single `Unreleased` entry
  becomes two entries with the same UTC date, each with its own bold headline.
  `desktop-vX.Y.Z` comes first, tags starting with `Desktop`, carrying the
  bullets a desktop user notices, in desktop wording. Then `vX.Y.Z`, its tags
  led by its own primary surface (`v1.11.0` is `Web`, `CLI`, `Self-hosting`,
  because its headline is about floe.one), carrying the CLI bullets, the
  `Web app:` bullets, and a `Self-hosting:` images-rebuilt bullet whenever
  `server/` or `client/` changed. A receiver-side change on a PR that is also
  sender-side or web-side still pairs: receiver-side wins.
- `node .claude/skills/floe-release/scripts/check-version-pins.mjs --cli vX.Y.Z --desktop desktop-vX.Y.Z --phase prep`
  (omit the series you are not releasing). It measures the tree the script
  lives in; `--root <dir>` measures another checkout, such as a scratch
  worktree. By default it sweeps the three newest tags of each series;
  `--old-cli` and `--old-desktop` (comma-separated) override the sweep.
  Every line it prints starts with its kind. `STALE`, `MISSING`,
  `WRONG-PHASE` and `DATE` are findings and make it exit 1; `FLOOR` and
  `WARN` never do:
    - `STALE`: an old version that survives, labeled with its tag. Fix every
      one that is a pin and rerun. It does not know which files ought to carry
      a version, so read each hit: a line that is release history stays, so
      green is not always reachable, and the report says which hits you
      judged to be history.
    - `MISSING`: a file that must already name the new version and does not.
    - `WRONG-PHASE` and `DATE`: `client/lib/desktopRelease.ts` bumped in the
      prep PR, or carrying a date that is not the tag's UTC date (step 6).
    - `FLOOR`: a sentence that measures from a version ("1.11.0 or later.",
      "since 1.11.0", "older than 1.11.0", "## Upgrading to 1.11.0"). Listed
      apart, never a finding, never bumped. The checker is strict about it,
      because a pin read as a floor would ship stale: the comparison has to
      end its clause, so "1.11.0 or later, ..." is a `FLOOR` and "version
      1.11.0 or earlier shows nothing" prints as `STALE`, and so does any
      version inside a code span or a fenced block. A floor it would not
      vouch for is still a floor: you decide, line by line.
    - `WARN`: for example an `Unreleased` entry that has not been renamed.
- Re-read every line that says "or earlier", under either label. The docs
  describe a web change that is live on floe.one but in no image yet in one
  place: the table "What an older web app shows" in
  docs/self-hosting/operations.mdx (`#older-web-app-versions`). Its third
  column is headed "What version X.Y.Z or earlier shows", and a cell may
  narrow that ("Version X.Y.Z only: ...", "Versions A to B: ..."). The
  header and those cells print as `STALE`. Each is right exactly when X.Y.Z
  is the last `v*` release WITHOUT the change, so when this tag is the first
  to carry it, the text stands as written: bumping it to the new number
  makes it false. A row added after this tag is about a later version than
  the header names, so its cell says its own version. The pages the table
  links to carry one pointer to it and no such clause of their own: a hit
  for "self-hosted web app on version" outside the table and the changelog
  is a clause that belongs in the table.
- The known pin set, so a hit there is never mistaken for history: CLAUDE.md
  (the version example), `.github/ISSUE_TEMPLATE/bug_report.yml` (the
  placeholder), DESKTOP.md (`Current release:` and the "Paired with" line
  under it; on a `v*`-only release that line stays, because it records the CLI
  the current desktop release shipped with, so its STALE line is left alone), `desktop/wails.json` (`productVersion`), `.env.docker.example`
  and `docker-compose.yml` (the `FLOE_IMAGE_TAG` examples), SECURITY.md (the
  container images row), docs/self-hosting/images.mdx and
  docs/self-hosting/configuration.mdx (image tag examples), docs/cli/installation.mdx
  (the install-script output blocks), docs/cli/version.mdx, docs/cli/flags.mdx
  (`--check` and `--version`), docs/cli/send.mdx and docs/cli/receive.mdx (the
  `Peer version:` examples), docs/reference/transfer-protocol.mdx (every
  `ver` example and the sentences around them), docs/desktop/installation.mdx
  and docs/desktop/settings.mdx (the installer file name and the App version
  example). The first four are what `MISSING` asserts; the sweep finds the
  rest.
- Known history, which stays: the release history section of DESKTOP.md;
  docs/images/desktop/capture-manifest.json (the build the screenshots were
  taken on; it moves only with new screenshots); comments that name a past
  release in `.goreleaser.yml`, `.github/workflows/desktop-release.yml`,
  `client/lib/request/constants.ts`, `cli/engine/transfer/sender.go`,
  `desktop/savedir.go`, `client/app/how-it-works/page.tsx` and
  docs/desktop/request-links.mdx; the body of "Upgrading to 1.11.0" in
  SELF_HOSTING.md and of "Moving to 1.11.0" in
  docs/self-hosting/operations.mdx; and
  `.claude/skills/docs-verify/references/claim-map.md`, which names changelog
  entries by their tag. docs/cli/update.mdx carries no pin since #594: its
  Output blocks read `1.x.x`, and its `1.11.0 and earlier` sentences, with the
  older output they quote, are floors that print as `STALE`; leave them.
- Write the docs snapshot of the released apps' strings,
  `.claude/skills/docs-verify/references/released-strings.json`, at the commit
  the release is cut from: the head of `main` the prep branch starts from,
  whose strings the tagged commit keeps because the prep PR adds no code.
  `node .claude/skills/docs-verify/scripts/released-strings.mjs --cli <sha> --desktop <sha>`
  (a series you are not releasing keeps its current tag), then
  `node .claude/skills/docs-verify/scripts/docs-check.mjs all`. The tags do not
  exist yet, and the script stops on a ref git does not know. The `messages`
  and `captures` checks hold every CLI and Floe Desktop row and every desktop
  picture string to that file, so fix what they report in this PR: a row whose
  words left the app is reworded or removed (#598 removed twelve), and a new
  line of `requestCopy.ts` or `sendto.go` gets its row. Step 6 writes the file
  again at the tags.
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

Confirm the push with the user first: a `v*` tag is permanent, and a
`desktop-v*` tag becomes permanent the moment its release publishes. `--no-sign`
keeps the tag unsigned whatever `tag.gpgSign` says.

The owner's push of a release tag prints `remote: Bypassed rule violations
for refs/tags/<tag>:` followed by `- Cannot create ref due to creations being
restricted.` That pair reads like a refusal but is GitHub reporting the
`release-tag-writers` bypass: the push succeeded, so never retry it. Confirm
with `git ls-remote origin refs/tags/<tag>`. A push refused outright means the
credentials are not the owner's admin ones, or the tag name is taken (a `v*`
that exists, or the name of a deleted immutable release); stop and ask.

```text
git fetch origin main
git tag -a --no-sign vX.Y.Z <sha> -m "vX.Y.Z"
git tag -a --no-sign desktop-vX.Y.Z <sha> -m "desktop-vX.Y.Z"
git push origin vX.Y.Z
git push origin desktop-vX.Y.Z
```

One tag per push, on purpose. Pushing both refs in one `git push` (measured on
2026-08-28, v1.10.5 + desktop-v0.2.8) fired release.yml, desktop-release.yml and
images.yml TWICE each; the twin runs raced, and the ones that lost to a transient
module-proxy error looked like failed releases while their twins had already
published. Push one tag, wait for its runs to start, then push the other.

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
git for-each-ref --format='%(taggerdate:iso8601-strict)' refs/tags/desktop-vX.Y.Z
```

## 4. Watch (minutes, not seconds: read the run, never assume)

**Approve release.yml first.** Its goreleaser job runs in the `release`
environment (since 2026-10-26), which opens only for a `v*` tag and only
after the owner approves. Right after the `v*` push, its run shows
`waiting`. The owner opens the run on GitHub, chooses Review deployments and
approves `release`. Claude never approves on its own. Only when the owner
says to approve that run does it use
`gh api -X POST repos/jannskiee/floe/actions/runs/<id>/pending_deployments -F 'environment_ids[]=25355274339' -f state=approved -f comment='<tag>'`
(Bash tool). Approve before pushing the `desktop-v*` tag.
- A waiting run holds the tag's concurrency group, and `gh run rerun` asks
  for the approval again.
- A run that fails with "not allowed to deploy to release" (the environment's
  `v*` tag policy did not match) published nothing: fix the policy in
  Settings, Environments, then rerun it.
- images.yml runs on the same tag without the gate, so `latest` moves without
  waiting for the approval.
- Rolling back to a repository secret needs the owner to paste the token
  again, because a secret's value cannot be read back, and then the removal
  of `environment: release` from release.yml.

Across recent tag runs (read 2026-10-12): release.yml took under three
minutes on each of the last six, images.yml a little over one minute on the
last three, and desktop-release.yml three to nine minutes (5 m 42 s for
desktop-v0.3.0; 8 m 50 s for desktop-v0.2.11, which needed a second attempt).

```text
gh run list --workflow release.yml --limit 1     (and desktop-release.yml, images.yml)
gh run view <id> --json status,conclusion --jq '.status + " " + .conclusion'     (Bash tool)
```

Run every `gh ... --jq` whose expression has a space in it from the Bash
tool: from the PowerShell tool the quoting breaks and gh answers "accepts at
most 1 arg(s)", which an empty-result polling loop reads as done. gh's
embedded jq only: the jq binary is not on this box and a jq-based loop fails
silently (memory `project_pnpm_via_corepack`).

If a workflow fails, first check `gh run list --workflow <file> --limit 3` for a
TWIN run on the same tag: a duplicate trigger that succeeded means the release
is already published, so cancel the failed twin (`gh run cancel <id>`) and do not
rerun it (a rerun would race the published release, and fails against it
anyway). Only when there is no successful twin does the following apply.

If a workflow fails, read why before touching the tag (`gh run view <id>
--log-failed`, which answers only once the whole run has ended).

- A transient failure (a module proxy or checksum-database read, a
  chocolatey or registry blip, a runner that died): `gh run rerun <id>
--failed` on the SAME tag, for either series (for a `v*`, only before
  GoReleaser published; see the next bullet). Nothing is wrong with the tag
  or the code. desktop-release.yml publishes only at its last step, so a
  failed run left no release and no partial state, and its `concurrency`
  block no longer cancels a run in progress (a second run on the tag queues
  behind the first; images.yml does the same). The MSIX artifact name
  carries the run NUMBER, not the attempt, so store-submit finds the rerun's
  artifact under the same name. desktop-v0.2.11 failed this way on
  2026-09-09 and the rerun shipped it.
- A rerun completes a `v*` release only when GoReleaser failed before it
  published (build, archive, or the upload to its draft). Once the GitHub
  release is published, GoReleaser's rerun stops at the first asset upload
  (the asset exists), before the Homebrew, Scoop and winget steps, and since
  releases became immutable no asset can be deleted to get around it. So a failure in those three steps, which run after
  the publish, is fixed by hand in jannskiee/homebrew-tap,
  jannskiee/scoop-bucket or the winget-pkgs PR, or by the next number. A
  rerun after a failure in the draft stage creates a fresh draft and leaves
  the old one behind: delete that orphan draft by hand once the rerun has
  shipped (drafts are not immutable).
- A failure that needs new code: for `desktop-v*`, delete the tag
  (`git push origin :refs/tags/desktop-vX.Y.Z`, then `git tag -d` locally) and
  re-cut the same number on the fixed merge commit. The owner's bypass on
  `release-tag-writers` is what permits the delete, and it works only while
  the tag has no published release; a failed desktop-release.yml run leaves
  none. Any MSIX artifact the failed run uploaded is superseded by the re-cut
  run's. Never delete a published release to re-cut it: the tag name is gone
  for good. For `v*` the fix goes out as the next number: the tag is
  permanent. Never re-cut a `v*`.
- A run refused before any job started (it ends `startup_failure`, and its
  page says "is not allowed in jannskiee/floe because...") hit the Actions
  policy (CLAUDE.md, CI): an action missing from the allow list, or not
  pinned to a full SHA. Nothing ran and nothing was published, and
  `--log-failed` has nothing to show; `gh run view <id>` or the run's page
  has the message. If the allow list was wrong, PUT the whole
  `selected-actions` body (read
  `gh api repos/jannskiee/floe/actions/permissions/selected-actions` first),
  then try `gh run rerun <id>` once; a rerun of a run that never started has
  not been tried here. If the workflow file was wrong, or GitHub refuses the
  rerun, it is new code: a rerun reads the workflow at the tag's commit, so
  follow the bullet above.

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

CLI: `gh release view vX.Y.Z --json assets --jq '.assets[].name'` lists six
archives plus `checksums.txt`.

Immutability and the tag rules, for every release published since 2026-10-26
(Bash tool):

```text
gh release view <tag> -R jannskiee/floe --json isImmutable --jq .isImmutable     (must print true)
gh release verify <tag> -R jannskiee/floe                                        (prints the release attestation)
gh api "repos/jannskiee/floe/rulesets/rule-suites?ref=refs/tags/<tag>&time_period=week" --jq '.[] | "\(.id) \(.result)"'
```

The rule suite of the owner's tag push must read `bypass`. A `pass` means
`release-tag-writers` did not apply: v1.11.6, pushed before it existed, reads
`pass`. Without `time_period` the list covers only the last 24 hours.
`gh api repos/jannskiee/floe/rulesets/rule-suites/<id>` lists the
`release-tag-writers` rules, beside the `release-tags` ones on a `v*` tag only
(`release-tags` covers `refs/tags/v*`, which no `desktop-v*` name matches).

One-time item. After the first immutable `v*` release, add a "verify with gh"
line (`gh release verify-asset <tag> <file> -R jannskiee/floe`) to the
checksum section of docs/cli/installation.mdx. After the first immutable
`desktop-v*` release, add one to docs/desktop/installation.mdx. Word each as
a floor ("vX.Y.Z or later"), since older releases have no attestation. When
both are in, delete this paragraph. v1.11.5 is immutable and attested
without being the floor: editing an older release's notes locks it and
attests its assets as they stand (its body was corrected on 2026-10-26),
and v1.11.6, published later and never edited, is neither. So the floor is
the first tag of each series published since immutable releases were turned
on (2026-10-26, so a tag cut later that day counts).

The link each release body carries: `gh release view <tag> --json body --jq
.body` shows a "What changed" line (the footer of a `v*` body, a line near
the end of a desktop one). Open that URL and confirm it lands on the entry
for this tag, not at the top of the changelog. At the top means the entry is
missing or still labeled `Unreleased` (step 2); with no entry on purpose
(rule 7) the top is the expected landing. v1.11.0 predates the footer, so
its body has no such line.

The list above that line, on a `v*` body: the release.yml run's
`Find the previous v* tag` step prints `Release notes cover vA..vB`, and vA
must be the nearest `v*` tag on an earlier commit, never a `desktop-v*` tag.
When the `v*` tag before this one sits on this tag's own commit (a next
number cut on an unchanged commit, step 4), vA is the one before that, and
the list repeats that release's commits. The list
holds every subject of `git log --format=%s vA..vB` except the types
`.goreleaser.yml` filters out (`references/tag-and-workflows.md`).

Images, on a `v*` tag: a green images.yml is not the proof, the digests are.
`latest` must be the image this tag built, for both images:

```text
docker buildx imagetools inspect ghcr.io/jannskiee/floe-server:latest
docker buildx imagetools inspect ghcr.io/jannskiee/floe-server:X.Y.Z
docker buildx imagetools inspect ghcr.io/jannskiee/floe-client:latest
docker buildx imagetools inspect ghcr.io/jannskiee/floe-client:X.Y.Z
```

Compare the `Digest:` line of each pair by eye. Do not pass `--format
'{{...}}'` from the PowerShell tool: PowerShell 5.1 drops the braces, the
default output comes back, and a scripted compare prints False for two equal
images. Image tags carry no leading `v`.

## 6. Follow-up PR: desktopRelease.ts

Bump `DESKTOP_VERSION` and `DESKTOP_RELEASE_DATE` together; the date is the
tag's UTC date as "Mon D, YYYY" (`desktopRelease.test.ts` rejects a future
date against the runner's UTC clock; #324's second commit fixed exactly that).
The changelog is not touched here except to correct a `description` whose day
slipped: the label went in with the prep PR. Run the checker with
`--phase follow-up`: it reads the tag's date from `git for-each-ref`, so the
tag must exist locally (step 3, or `git fetch --tags`). Without it the checker
stops with exit 2 and "tag desktop-vX.Y.Z is not known here: either run git
fetch --tags, or you are running follow-up before step 3 (the tag must exist
first)". With it, it asserts the new pin and the date against the tag, and
reports an `Unreleased` entry with no entry for the tag as `MISSING`: the
rename was missed in step 2, and the release body is already pointing at the
anchor. CI's release-asset step is the merge gate.

On every release, `v*`-only included: once the tags exist, write the docs
snapshot again with their names,
`node .claude/skills/docs-verify/scripts/released-strings.mjs --cli vX.Y.Z --desktop desktop-vX.Y.Z`
(the series you did not release keeps its tag), run `docs-check.mjs all`, and
commit `released-strings.json` in this PR or in the docs PR that follows the
tags (v1.11.1: #594). Until then its `refs` name the commit step 2 wrote it at.

## 7. Store submission (one in flight at a time)

Run `.claude/skills/store-submit/SKILL.md`. It checks that Partner Center
shows the previous submission as "In Microsoft Store" (Start update exists
only then), fetches and verifies the tag's MSIX from the desktop-release.yml
run's ARTIFACT `floe-desktop-msix-<X.Y.Z>-run<run_number>` (never a
release-page asset; a canceled twin run holds no artifact, 2026-08-27),
renders this release's changelog entry into the plain-text "What's new"
field, and drives Partner Center through Submit for certification. A release
that changed what the app does also takes its steps 5a and 5b (step 0 here).
Come back here for step 8 once it reports "Update in certification".

## 8. DESKTOP.md step h

Launch the previous build, confirm the update notice names the new version.
If the previous build is not installed, run
`floe-desktop-<prev>-windows-amd64.zip` from the previous release page; the
notice runs only unpackaged (`desktop/updatecheck.go` returns early for a
packaged build), so the Store install can never show it.

## Done means

All eight steps with evidence in the report, step 1a included when
`server/` changed. A `v*`-only release has no desktop half: steps 7 and 8, the
`desktopRelease.ts` bump of step 6 (its snapshot paragraph still applies) and
the four desktop URLs of step 5 do not apply, and its completion signals
are the `release.yml` run (approved, then green), the green `images.yml` run,
the release assets and the image digests. With a desktop half, green workflows and four 200s are
necessary; step 8 and the certification email are the completion signals.
