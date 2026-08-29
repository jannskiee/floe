---
name: transfer-audit
description: 'Use when auditing that a real transfer still works on every surface: a live matrix of web (floe.one), CLI and Floe Desktop as sender and receiver, direct and forced relay (TURN), driven on this Windows machine against production (or local HEAD for the direct web and CLI cells), with SHA-256 checks, route evidence, receivers opted out of the stats counter, and each surface compared with its latest release. Also the 2 GB relay cap, chunk boundaries, kill mid-transfer, a 500 MiB throughput baseline, folder and browser ZIP delivery, and a WSL sender. Not for starting the stack alone (floe-run), pnpm test:e2e, a CI job, cutting a tag (floe-release) or a Microsoft Store submission (store-submit).'
---

# Transfer audit runbook

One command that answers "does a transfer work right now, on every surface,
in both directions, direct and relayed, on the latest releases", as a table
with evidence. The e2e suite proves browser and CLI at HEAD over a local
server with `--no-relay`; the Go loopback tests prove the engine in-process;
`back-compat` proves the released CLI against HEAD (Linux, no relay). This
audit covers what none of them can: the built desktop app, a real TURN relay,
production signaling, and the binaries actually installed on this machine.

Everything lives under `.claude/skills/transfer-audit/`: `scripts/audit.mjs`
(the driver), `scripts/desktop-uia.ps1` (the desktop driver, Windows UI
Automation), `references/matrix.md` (every cell, its forcer, oracles and
timeouts), `references/triage.md` (failure signature to cause to next
action). Symbols, not lines: the browser selectors come from
`client/e2e/helpers.ts` and `client/components/P2PTransfer.tsx`, the desktop
strings from `desktop/frontend/src/App.tsx`, the CLI lines from
`cli/cmd/floe/main.go` and `cli/engine/transfer/{sender,receiver}.go`.

Lines that bind every run, in this order: never POST to
`api.floe.one/api/stats/report`, and every receiver is opted out of the
stats counter by construction (browser `localStorage['floe:report-stats']`
seeded to the literal string `false` plus a route abort that counts
attempts; CLI `--no-report` plus `FLOE_NO_STATS=1`; desktop `desktop.json`
with `reportStats:false` and `migrated:true` before launch). Never print a
`/api/turn-credentials` body; the probe reports URL schemes only. Never read
`server/.env`. Crop every capture to the window rect. Never force focus
while the user is at the PC. Never kill a process the run did not start.
Never delete anything under `%APPDATA%\floe`. Never use the production VM as
a peer.

## 0. Preconditions (the driver checks the first four and exits 3; the byte and update rules are policy)

- `gh auth status` prints a logged-in account (release downloads, the
  latest-tag lookup, the commit compare).
- Playwright: `client/node_modules/@playwright/test` resolves and its
  chromium revision is installed under `%LOCALAPPDATA%\ms-playwright`. The
  driver resolves it from `--client-dir` (default `<root>/client`), so the
  head profile runs from a checkout that has `client/node_modules`; a fresh
  worktree does not.
- Ports 3000 and 3001 are free or owned by `floe-run` (head profile only):
  `node .claude/skills/floe-run/scripts/floe-run.mjs check`, where exit 2 on
  an idle machine is the expected answer.
- No `floe-desktop.exe` is running that the run did not start. The single
  instance mutex would forward our launch into the user's window; the driver
  refuses instead. `--desktop none` drops the desktop cells and this check
  with them.
- Declare presence. The default is "at the PC": the desktop is driven only
  through UI Automation (provider-side Invoke and SetValue calls, no focus
  needed), captures are `PrintWindow` on the window rect, a foreground
  conflict pauses up to `--pause-max` minutes and then marks the cell SKIP
  `present`. `--user-away` (with 120 s of idle input measured by
  `GetLastInputInfo`) is the only mode that may raise a window, and this
  round never uses it.
- The relay byte rule: direct cells move 12 MiB (64 MiB with a desktop
  side), relay cells 4 MiB each (28 MiB per default run, seven relay cells,
  plus 1 MiB when P3 runs; the cap cell moves zero). Never more than 200 MB
  over TURN per run without the owner saying so.
- The update rule: the audit tests the latest release binary even when the
  installed one is stale. The shipped CLI is the `floe` on PATH when
  `floe --version` equals the latest `v*` tag, else a checksum-verified zip
  side-loaded into `--bin-dir` (`--pin` forces the side-load). The shipped
  desktop is the Store build when `Get-AppxPackage JanCarloParedes.FloeDesktop`
  maps to the latest `desktop-v*` tag (`X.Y.Z` is packaged as `(X+1).Y.Z.0`),
  else the portable zip, labeled `portable (isPackaged=false)` in every row.
  How to bring the machine up: `scoop update; scoop update floe` (the bucket
  carried 1.10.5 on 2026-08-29; `floe update` refuses under scoop), and the
  Store app's Library update button (`Check for updates` on the build here,
  `Get updates` on older ones; winget's msstore source lagged the listing on
  2026-08-29). The first listen from a new exe path may raise a
  Windows Firewall consent dialog; Cancel is fine for same-machine cells.

## 1. Probe (first run on a machine, and after any desktop or Windows update)

```text
node .claude/skills/transfer-audit/scripts/audit.mjs probe --out <dir>
node .claude/skills/transfer-audit/scripts/audit.mjs probe --desktop store --out <dir>
```

The default profile is `shipped`, which makes P3 a real browser receive on
floe.one; a probe that must stay local takes `--profile head` (P3 is then
skipped). `probe` writes `<dir>/probe.json`; `run` reads it when it is under
24 h old and otherwise probes again itself before the first cell, and a head
run re-probes local TURN once its stack is up, since a probe taken before
`floe-run` started says nothing about it. The desktop half opens the Floe
window (main session only, never a subagent):

- P1, does `ValuePattern.SetValue` on the code field drive React? The helper
  sets `zzz-zzz-zzz`, flips the Send and Receive tabs, reads the value back,
  invokes Receive and reads the status. `Connecting... keep this window
open.`, or the follow-on error status (`Error: Could not reach the
server...`: the probe points the app at `127.0.0.1:9`, so the lookup ran
  with the state value and failed on purpose), means drivable; `Please enter
a code or link.` or an empty read-back means every desktop-receiver cell
  is SKIP `uia-setvalue` (the desktop is audited as a sender, and the
  receiver is proven on HEAD through `--desktop wailsdev`). It ends with
  Invoke `Cancel`; it needs no server and touches nothing on the network.
- P2, does `APPDATA=<out>\appdata` isolate a script-launched exe? Pass:
  `appdata\floe\desktop.json` and `webview\EBWebView` appear there and the
  real `%APPDATA%\floe\desktop.json` keeps its sha and mtime. Fail: portable
  and head builds get the Store treatment (backup, edit, restore).
- P3 (shipped profile only: it is a browser receive on floe.one), does the
  browser relay patch yield a relay pair? A 1 MB
  transfer between two fresh contexts; the nominated candidate pair must
  read `relay`, the pill `Relay`, the hashes equal. Costs 2 TURN fetches.
- P4, TURN schemes on production and, when the head stack is up, locally.
  Relay cells run only where a `turn:` or `turns:` URL is served. The local
  server answers STUN only unless `server/.env` carries Cloudflare TURN keys
  (never read that file; the scheme probe is the only test).
- P5, versions (section 2). P6, whether the Store build accepts argv paths
  by AUMID (identity oracle: Settings hides `Check for updates` when
  packaged). P7, Mark-of-the-Web on the extracted portable exe (the driver
  runs `Unblock-File` on its own scratch file only). P8, `ShowWindow`
  SW_SHOWNOACTIVATE un-minimizes without activation. P9, the remembered
  save dir (`floe:saveDir`) reads back and restores through UIA.

Every probe records a verdict object; a probe that throws records `error`
and the dependent cells SKIP with that reason.

## 2. Versions (a stale binary passes cells and hides the bug the release fixed)

```text
node .claude/skills/transfer-audit/scripts/audit.mjs versions --web-sha <sha> --server-sha <sha>
```

Rows: CLI on PATH (`floe --version` only; `floe version` writes the update
cache), CLI under test, desktop Store (`Get-AppxPackage`), desktop GitHub
(HKCU Uninstall `Floe`), desktop under test (`VerQueryValue` ProductVersion;
`Get-Item .VersionInfo` reads empty for these exes), web floe.one, server
api.floe.one, protocol parity (`ProtocolVersion`/`MinProtocolVersion` in
`cli/engine/transfer/protocol.go` against `PROTOCOL_VERSION`/
`MIN_PROTOCOL_VERSION` in `client/lib/transfer/protocol.ts`, plus one
desktop About reading `Transfer protocol`). Statuses: CURRENT, STALE,
UNKNOWN, NOT_INSTALLED, PARITY, DRIFT, INFO. Gating rows (exit 6 when
STALE): CLI under test, desktop under test, web when a commit under
`client/` is not deployed, protocol, and the server only with
`--server-sha`. The PATH CLI and an unused Store build are INFO.

Two oracles are main-session steps, passed in as flags:

- Web: `mcp__vercel__get_deployment({ idOrUrl: 'www.floe.one', teamId:
<the floe team id from `list_teams`> })` and read `meta.githubCommitSha`
  (never `list_deployments`; its head is a canceled preview). This is only
  the fallback: `GET https://www.floe.one/api/config` has carried `commit`
  since #363, so the driver reads the deployed SHA itself and the flag is
  optional. The `/` ETag proves only "changed since".
- Server: `ssh floe-azure "git -C ~/floe rev-parse HEAD"` from PowerShell
  (the 1Password agent path; Git Bash gets `Permission denied`). Without the
  flag the row is INFO: the process start from `/health` uptime against the
  last commit touching `server/`.

## 3. Run (announce it first: the production limiters count your own traffic)

```text
node .claude/skills/transfer-audit/scripts/audit.mjs run --profile shipped --quick --out <dir>
node .claude/skills/transfer-audit/scripts/audit.mjs run --profile shipped --out <dir>
node .claude/skills/transfer-audit/scripts/audit.mjs run --profile shipped --deep --out <dir>
node .claude/skills/transfer-audit/scripts/audit.mjs run --profile head --quick --desktop none --relaxed --out <dir>
```

Run it with `run_in_background`; it prints `PROGRESS <cellId> <verdict>` as
cells finish and the headline at the end. Expected wall clock on this
machine (measured 2026-08-29, all green): shipped quick about 1 minute,
default (18 rows) about 3, deep (32 rows) about 9 including the 3 GiB cap
cell, the 500 MiB throughput cell and both 200 MiB kill cells; head quick
with `--desktop none` takes about a minute. Announce
the run before starting it: the production limiters count the user's own
floe.one traffic on the same IP.

Profiles: `shipped` is api.floe.one plus Cloudflare TURN, the latest release
binaries and floe.one; `head` is the `floe-run` stack (started with
`--client --relaxed` when nothing is bound, reused when it is ours, refused
when someone else owns the port), a `go build` CLI with `-X
main.version=head-<sha7>`, `next dev`, and the desktop through `--desktop
wailsdev` (the real app with real Go bindings served at
`http://localhost:34115` to a Playwright page) or a `wails build` exe.
Subsets: `--quick` (6 cells), default (18 rows, 15 executable), `--deep` (14
more). `--cells S-REL-*,S-DIR-C2D` narrows; a pattern that names no
executable cell (or only NA rows, or a deep id without `--deep`) is a usage
error before anything is created. `--desktop
auto|store|portable|wailsdev|none`; `auto` picks the Store build when it is
on the latest tag. `--strict` makes FLAKY count as FAIL. `--pion-trace` adds
`PION_LOG_TRACE=ice` to CLI relay legs only (route evidence, never on a leg
that must stay quiet). `--dry-run` exercises each tool class once so
permission prompts cluster at the start. On the head profile the
`node fetch GET` class targets `http://localhost:3001/health`, so before
the stack is up a dry run reports that one class failed and exits 3: that
is the expected answer on an idle machine, not a fault. `--relaxed` (head only) starts
`floe-run` with `--relaxed` and relaxes the ledger to the local limits (1000
for TURN, connections and codes, the stats limiter unchanged at 60
per window, no floor); it is a usage error on the shipped profile.
`--web-sha-file <json>` takes a recorded deployment record instead of
`--web-sha`; `--root <dir>` and `--json` are common; `--pause-max` defaults
to 10 minutes; `node audit.mjs --self-test` (a top-level form, not a `run`
flag) runs the pure checks with no adapters. `--out` and `--bin-dir` must be
scratch directories: inside any checkout is a usage error (exit 2), and a
fenced location such as `%APPDATA%\floe` is exit 4 with nothing created.

When the last cell is verified the run deletes what it moved: the
fixtures it generated and the files every receiver saved, which is
several GB after a deep run. Both hashes of every file are already in
`run.json`, so the payloads prove nothing once compared; the report,
the transcripts, the captures and `attempt.json` are always kept, and
the log says how much went. `--keep-data` keeps the payloads instead
and says how much is being held.

`--monitor` decides where the one visible part of the audit goes. The
desktop window is moved there before any cell drives it, using
`SWP_NOACTIVATE`, so the move never takes focus: `secondary` (the
default, and the primary screen when there is only one), `primary`, a
1-based index, or `off` to leave the window where Windows put it. The
browser runs headless and the CLI has no window, so nothing else in a
run is on screen at all.

Pacing on production: a rolling 60 s ledger with 50 percent headroom (10
TURN fetches, 15 connections, 30 code calls) and an 8 s floor between cell
starts. A 429 symptom penalizes one window and retries once; two in a row
mark the remaining production cells SKIP `infra-down` and exit 3. A TURN 429
silently degrades a peer to STUN, which makes a relay-forced peer fail to
connect, so the ledger is not optional.

Relay forcing: the browser leg gets an init script that subclasses
`window.RTCPeerConnection` with `iceTransportPolicy: 'relay'`; the desktop
gets `hideIP:true`; the shipped CLI (1.10.5) has no forcer and prints no
route; origin/main since #362 (`faedbc7`; a head build from an older
worktree lacks it) accepts `--relay-only` (also `FLOE_RELAY_ONLY=1`) and
prints ` Connected (direct)` or ` Connected (relay)` on every connect. The
driver detects the flag from `floe send --help`, so `S-REL-C2C` flips from
NA to executable on the first release that carries it, with no skill change.
One relay-only side relays the pair, so the forced side's oracle is the
proof and the other side's reading must agree.

Desktop hygiene the driver enforces: the Store build launches by AUMID for
receiver cells and, for sender cells, as the package's `floe-desktop.exe`
under `WindowsApps` with the files as argv (P6: `explorer.exe
shell:AppsFolder` drops the argument), with `desktop.json` backed up, edited
(`server`, `web`, `hideIP`, `reportStats:false`, `noUpdateCheck:true`,
`migrated:true`) while no Floe process exists, and restored byte-identical
after (sha256 compared, exit 4 on mismatch); the portable and head exes
launch with `APPDATA` redirected; files for a send are staged on the first
launch through argv (a second launch activates the window); the remembered
save dir is read before the first edit and set back after every receiver
cell; desktop direct cells move 64 MiB so the pill shows the route for more
than one 100 ms sample (a 12 MiB loopback transfer ends 0.4 s after
connect); the completion and status texts are read as joined text runs,
because React renders `Sent 1 item` and `Saved to <dir>` as adjacent text
nodes that UI Automation exposes one by one; history rows the run adds are
reported as `not counted` in the Safety section until an adapter can read
the History list. Closing is `WM_CLOSE`; `Close anyway` is used only by
`cleanup`. Ctrl+C stops the legs and restores `desktop.json` before exiting
130; the desktop teardown budget is 60 s.

## 4. Read the table (a retry that passes is a bug, not a flake)

`<out>/<runId>/audit.md` opens with one headline (`15/15 PASS, all surfaces
on latest`, or `2 FAIL (ids); 1 SKIP, 1 FLAKY`; FLAKY and ERROR are counted
on their own), then Cells, Versions, Infra, Safety, Failures and flakes,
Legend; `run.json` carries the same data (schemaVersion 1) with room links
and codes redacted to hashes. Per-cell evidence lives under
`<run>/cells/<id>/attempt-N/` (`attempt.json` with phases and the signature,
`route.json`, `outputs.json`, and `sender/` and `receiver/` with transcripts, UIA logs, `desktop.json.bak` and captures); it keeps the raw room link and stays on this machine. A browser leg's evidence also carries `turnFetches` (the status code of every `/api/turn-credentials` answer, never a body) and `candidates` (the candidate types the page gathered and the peer sent), which a connect timeout on a relay cell needs.

Verdicts: PASS needs sha256 equality on every file (on disk for CLI and
desktop, per blob URL for the browser), completion text on both sides plus
exit 0 for every CLI process, route evidence (REL: the forced side reads
`local=relay` in the browser or the pill `Relay` on the desktop; DIR: every
side with an oracle reads `direct`, or `direct (--no-relay both)` for CLI
pairs), and the receiver's stats attestation. FAIL carries the exact
signature, the phase, both transcripts, the window-cropped captures and a
triage key. A PASS or FLAKY row on a DIR cell where no side had a route
oracle answer carries the note `route-unproven (no route oracle answered)`.
FLAKY is a retry-eligible signature that passed on attempt 2; it never
counts as PASS. SKIP names a machine or run precondition (`uia-setvalue`,
`desktop-savedir`, `desktop-none`, `desktop-unavailable`,
`head-desktop-pending`, `present`, `local-stun-only`, `prod-turn-absent`,
`browser-relay-na`, `firewall-block`, `wsl-stopped`, `wsl-sideload`,
`disk-space`, `infra-down`, `budget-exhausted`; `filtered` marks cells
dropped by `--cells` and is never counted). NA is impossible with the
shipped product (`single-instance`, `no-cli-relay-forcer`). ERROR is a
harness fault (for example `init-script-not-applied`), never a product
verdict.

Exit codes: 0 clean; 1 any FAIL (or FLAKY under `--strict`); 2 usage; 3
precondition or infra abort; 4 a safety invariant tripped (a stats attempt
on an opted-out receiver, a `desktop.json` restore mismatch); 5 partial
(SKIP, FLAKY or ERROR present, no FAIL); 6 version drift only; 130
interrupted. Precedence 2, 4, 3, 130, 1, 5, 6, 0. `versions` exits 0 or 6,
`probe` 0 or 3, `cleanup` 0 or 1.

The Safety section is printed every run and must read: browser stats
attempts 0 (all aborted), `floe:bytes-reported` events 0, CLI receivers
opted out k/k, desktop receivers `reportStats:false, migrated:true` k/k with
the config restored byte-identical, local `/api/stats` 0/0 on the head
profile, TURN bodies never, `server/.env` never read, captures N (desktop
PrintWindow captures; browser page screenshots are not counted) all
window-cropped, forced foreground 0, killed pids own only, working tree
unchanged.

## 5. When a cell fails (the receiver build decides the early race; read it first)

Open `references/triage.md` and match the exact string. The one rule that
matters most: a connect-then-nothing (both sides connected, zero bytes; CLI
`connected, but no data arrived from the sender within 30s`; desktop
`Connected, but the sender never started sending`) is the early-message
race, decided by the RECEIVER's build, fixed in v1.10.2 and desktop-v0.2.5.
It is never retried and a green retry would be the bug hiding, so the row
prints the receiver build first. Every FAIL block names its phase and a
`Triage:` key that is the first column of `references/triage.md`; a key not
in that table means: read the phase, both transcripts and the captures under
the cell's evidence directory, then file it. To rerun one cell, repeat the
same `--profile`, `--desktop`, `--client-dir`, `--out` and `--bin-dir` and
add `--cells <id>`. A `relay` reading on a DIR cell is a leaked forcer
(`hideIP` left true, an init script on the wrong context) before it is a
product bug; run `cleanup` and re-run the single cell with `--cells`.

## 6. Cleanup (the restore step keeps the owner's desktop.json intact)

```text
node .claude/skills/transfer-audit/scripts/audit.mjs cleanup --out <dir>
```

A run that ends on its own (any exit but a crash or Ctrl+C) already stops
the stack it started, purges the bytes it moved (section 3) and applies the
next-dev hygiene; `cleanup` is the fallback after an abort, and it is what
removes a side-loaded binary, the redirected APPDATA and the run manifest. It replays the newest run manifest under `--out`
(`--last`, the default, or the one named by `--run <id>`): Cancel when a
transfer is live, then `WM_CLOSE` (`taskkill` only our pid after two failed
closes); `desktop.json` restored from the backup with both hashes printed;
`floe-run stop` only when this run started the stack, then `git checkout --
client/next-env.d.ts` and the generated `client/AGENTS.md` and
`client/CLAUDE.md` removed; fixtures, received files and the redirected
`appdata` deleted; side-loaded binaries deleted unless `--keep` (a stable
`--bin-dir` avoids the next firewall prompt). It never deletes an
operator-supplied `--bin-dir` or any manifest path outside `--out`, refuses
a recorded pid whose creation time changed (a recycled pid), and replays the
`desktop.json` backup only into the path the fence allows. The same two
steps that alter the machine (desktop close and config restore) also run
best-effort on Ctrl+C.

## 7. Head profile (what the next release will do)

`floe-run` neutralizes the public counter (`UPSTASH_REDIS_REST_URL` set to
an unroutable sentinel) and lifts the limiters under `--relaxed`; the driver
asserts `GET /api/stats` reads 0 before and after every receive. Direct
cells only, unless P4 finds local TURN. The stack (`server/`, `next dev` and
the `floe-run` script) runs from the checkout that owns `--client-dir` (from
a worktree pass `--client-dir <main>/client`; the worktree has no
`node_modules`), and pnpm 11 kills `next dev` when `client/node_modules` is
older than the lockfile, so run `corepack pnpm install --frozen-lockfile`
from `client/` first. Every `corepack pnpm` shell-out runs from `client/`
with `COREPACK_ENABLE_AUTO_PIN=0` (from the repo root corepack resolves
11.7.0 and can rewrite the root `package.json`). The wailsdev lane needs
`%USERPROFILE%\go\bin\wails.exe dev` in `desktop/` (Wails is off PATH here)
after `npm run build` in `desktop/frontend`; it proves HEAD, not the shipped
exe, and the report labels it. The lane expects `wails dev` to be started by
the operator from that checkout's `desktop/` with its `desktop.json` pointed
at the audit server and `reportStats:false`; it was not exercised in the
first round. A wailsdev receiver is refused (exit 3) unless `GetSettings()`
shows `reportStats:false`, `migrated:true` and the audit server.

## 8. Deep cells (the shapes that shipped bugs: chunk edges, sizes, kills, the cap, one non-loopback path)

`--deep` runs on the shipped profile; the driver creates the 3 GiB sparse
file and side-loads the Linux release CLI into WSL itself. Chunk boundaries
(0, 512, 16383, 16384, 16385, 262143, 262144, 262145 bytes) on CLI to CLI
and browser to CLI; the size ladder (1 B, 1 KiB, 64 KiB, 1 MiB, 10 MiB,
100 MiB, about 111 MiB in one batch) on CLI to CLI, browser to CLI and CLI
to desktop, which is the only cell that hands the desktop more than one
file and the only place the tiny end (where per-file framing dominates) and
the large end meet in a single transfer; a three-file folder on CLI to CLI and the browser
`Download ZIP` path with the entries hashed by the zip reader borrowed from
`store-submit`; the 2 GB relay cap refused before any byte moves by a 3 GiB
sparse file over a browser-forced relay (`fsutil sparse`, at least 4 GiB
free); a 500 MiB direct throughput baseline (CLI to CLI only, browser
receivers hold the file in memory); a sender killed at 50 MiB leaving no
`.part`, and a killed receiver leaving exactly one `.part` with the retry
landing `name (1).bin`; link-input variants; and the WSL2 `Ubuntu-22.04`
Linux CLI sending to the Windows CLI, browser and desktop as the only
non-loopback path on one machine (`wsl -d Ubuntu-22.04`; the tarball is
downloaded by tag, verified with `sha256sum -c` inside WSL and extracted
under `/var/tmp`, which survives the distro's systemd tmpfiles rule, and
the leg runs that Linux binary, never the Windows exe). A head-profile run
rewrites a loopback server URL to the Windows host's default-route IP,
since `localhost` inside WSL is the distro; the shipped profile uses
production URLs and never resolves a host IP at all. SKIP `wsl-sideload`
when the side-load fails and `firewall-block` when a Block rule covers the
staged path.

## Done means

- `probe.json` written for this machine, every probe with a verdict.
- The Versions table with every gating row CURRENT or PARITY, or the drift
  named with its command.
- A shipped run whose headline reads all PASS, or whose FAIL rows carry a
  signature, a triage key and both transcripts, and whose SKIP and NA rows
  each carry a reason key.
- The Safety section reading zero everywhere it must, and `desktop.json`
  restored byte-identical.
- `cleanup` run; no Floe process left; the working tree unchanged.

Green is a gate, not a proof: a cell passes on this machine, today, against
this infrastructure. All peers sit on one host (the WSL cell is the one
non-loopback path), the portable build is not the Store package byte for
byte, the browser has no release oracle of its own until `/api/config`
carries `commit`, and throughput here says nothing about a real link. What
the table does prove is byte-exact delivery, the route actually taken, the
receiver's opt-out, and the versions that did it.

## Pointers

- `references/matrix.md` (cells, forcers, oracles, timeouts, expected
  strings); `references/triage.md`.
- `.claude/skills/floe-run/SKILL.md` (the local stack and the stats
  sentinel); `.claude/skills/ship-it/SKILL.md` (landing changes);
  `.claude/skills/store-submit/scripts/msix-preflight.mjs` (the zip reader
  and the identity mapping); `.claude/skills/floe-release/SKILL.md` (tags
  and pins).
- `client/e2e/helpers.ts`, `client/e2e/docs-screenshots.mjs` (the stats
  route guard), `client/hooks/useConnectionType.ts`,
  `client/hooks/useTransferAnalytics.ts`, `desktop/frontend/src/App.tsx`,
  `desktop/app.go`, `desktop/config.go`, `cli/cmd/floe/main.go`,
  `cli/engine/transfer/receiver.go`, `cli/engine/peer/connection.go`,
  `server/server.js` (limiters, `/api/turn-credentials` precedence).
- Memory: `reference_transfer_audit_harness`,
  `reference_datachannel_early_message_race`,
  `project_floe_local_install_hygiene`, `project_deployment_topology`,
  `feedback_owner_autonomy`.
