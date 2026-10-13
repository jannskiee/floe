---
name: transfer-audit
description: 'Use when auditing that a real transfer still works on every surface: a live matrix of web (floe.one), CLI and Floe Desktop (the Store build included) as sender and receiver, direct and forced relay (TURN), driven on this Windows machine against production (or local HEAD for the direct web and CLI cells), with SHA-256 checks, route evidence, receivers opted out of the stats counter, and each surface compared with its latest release. Also request links (the /r page, floe send --to, Accept prompt, Auto-accept, request-1, SHA-256 matched), the 2 GB relay cap, chunk boundaries, kill mid-transfer, a 500 MiB throughput baseline, folder and browser ZIP delivery, and a WSL sender. Not for starting the stack alone (floe-run), pnpm test:e2e, a CI job, cutting a tag (floe-release) or a Microsoft Store submission (store-submit).'
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
`client/e2e/helpers.ts`, `client/components/P2PTransfer.tsx` and
`client/components/ReceiverPanel.tsx`, the page states the web leg names
from `client/lib/receiveSummary.ts`, `client/lib/rejoinRetry.ts` and
`client/lib/roomSeat.ts`, the request visitor's copy from
`client/lib/request/visitorCopy.ts`, the desktop strings from
`desktop/frontend/src/App.tsx`, `desktop/frontend/src/requestCopy.ts`,
`desktop/frontend/src/errors.ts` and `desktop/transfer.go`, the CLI lines
from `cli/cmd/floe/{main,send,receive,sendto}.go` and
`cli/engine/transfer/{sender,receiver,format}.go`.

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
  driver resolves it from `--client-dir`, whose default is `<root>/client`.
  A fresh clone or worktree has no `client/node_modules`, so from one pass
  `--client-dir <a checkout whose client has node_modules>/client`.
- Ports 3000 and 3001 are free or owned by `floe-run` (head profile only):
  `node .claude/skills/floe-run/scripts/floe-run.mjs check`, where exit 2 on
  an idle machine is the expected answer.
- No `floe-desktop.exe` is running that the run did not start. The single
  instance mutex would forward our launch into the user's window; the driver
  refuses instead. `--desktop none` drops the desktop cells and this check
  with them.
- Declare presence. Reading the window never takes the foreground (UI
  Automation snapshots and text reads, `PrintWindow` captures on the window
  rect), but any UI Automation pattern call on a built exe (Invoke,
  SetValue, Toggle) activates its window (G2-F1). That is every click and
  every field the driver sets, on the Store build, a portable and a head
  `wails build` alike. So on an exe lane (`--desktop store`, `portable`, or
  `auto`, which is the default and resolves to one of them) `run` and
  `probe` launch and drive nothing on the desktop unless told to: the
  probe's desktop half is recorded as skipped, every cell with a desktop
  side is SKIP `present` in the plan before any launch, request hosts
  included, and the second line of output says so
  (`desktop: not launched or driven`). Two flags change that, and nothing
  else ever implies either.
  `--user-away` says nobody is at the PC: each pattern call then re-reads
  `GetLastInputInfo` first and stops the leg as SKIP `present` below 120 s
  of idle input. `--allow-foreground` accepts the focus change: desktop
  cells run with no idle check, as they did by default before the flag
  existed, and what was away-only then still is (request hosts, SKIP
  `request-host-away-only`; staging files into a running Store app; the
  direct start of the Store exe with files). Both together behave as
  `--user-away`. The `wailsdev` lane drives a headless page, activates
  nothing and needs neither flag, and `--desktop none` has no desktop to
  drive. What only reads is not gated: `versions`, the `Get-AppxPackage`
  lookup that resolves `auto`, the firewall read. `--pause-max` is parsed
  and handed to the legs, and nothing waits on it.
- The relay byte rule: direct cells move 12 MiB (64 MiB with a desktop
  side), relay cells 4 MiB each (32 MiB per default run, eight relay cells,
  with a CLI that lists `--relay-only`, as every release since v1.10.6
  does; 28 MiB over seven with an older one; plus 1 MiB when P3 runs; the
  cap cell moves zero). Never more than 200 MB over TURN per run without
  the owner saying so.
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
node .claude/skills/transfer-audit/scripts/audit.mjs probe --desktop store --user-away --out <dir>
```

The default profile is `shipped`, which makes P3 a real browser receive on
floe.one; a probe that must stay local takes `--profile head` (P3 is then
skipped). `probe` writes `<dir>/probe.json`; `run` reads it when it is under
24 h old and was taken for the same `--desktop` value and the same profile,
and otherwise probes again itself before the first cell. The file records
both as `requested`, and it is the value asked for that is compared: a probe
taken under `auto` answers only an `auto` run, and only while `auto` still
resolves to the lane it resolved to then (`resolved.desktop` in the file;
the Store app may have been updated or removed since),
because the desktop half is one lane's answer and a wailsdev run that read a
Store probe was gated by the Store app. So switching lanes probes again, and
a desktop probe on an exe lane is an away cycle of its own. A head run also
re-probes local TURN once its stack is up, since a probe taken before
`floe-run` started says nothing about it.

The first form, with someone at the PC, runs every probe but the desktop
ones: on an exe lane (the default `auto` is one) the desktop half is not
started without `--user-away` or `--allow-foreground` (section 0). The
second line of output says so, the probe line reads
`probe P1/P2/P6/P8/P9 desktop: skipped (present)`, and `probe.json` carries
`desktop.skipped: "present"` with the lane `auto` resolved to, and P1, P2,
P6, P8 and P9 unknown rather than failed. A run that may drive the desktop
does not reuse such a file; it probes again. The second form is the desktop
half, which opens the Floe window (main session only, never a subagent):

- P1, does `ValuePattern.SetValue` on the code field drive React? The helper
  sets `zzz-zzz-zzz`, flips the Send and Receive tabs, reads the value back,
  invokes Receive and reads the status. `Connecting...`, or the follow-on
  error status (`Error: Can't reach the server`: the probe points the app at
  `127.0.0.1:9`, so the lookup ran with the state value and failed on
  purpose), means drivable; `Enter a code or link` or an empty read-back
  means every desktop-receiver cell is SKIP `uia-setvalue` (the desktop is
  audited as a sender, and the receiver is proven on HEAD through
  `--desktop wailsdev`). Those are the lines of desktop-v0.3.0 on; a release
  before it says `Connecting... keep this window open.`,
  `Error: Could not reach the server...` and `Please enter a code or link.`,
  and the driver reads either set (`STRINGS` and `STRINGS_RELEASED` in
  `scripts/lib/desktop.mjs`). The
  measured notes in the header of `scripts/desktop-uia.ps1` are from the
  Store build 1.2.8.0 (2026-08-29), which showed the older lines. It ends
  with Invoke `Cancel`; it needs no server and touches nothing on the
  network.
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
  server answers STUN only unless it was given a relay: Cloudflare TURN keys
  in `server/.env` (never read that file), or a local coturn through
  `floe-run start --local-turn`, which needs `FLOE_LOCAL_TURN_DOMAIN` and
  `FLOE_LOCAL_TURN_SECRET` in the operator's own shell and which the audit
  never passes itself. The scheme probe is the only test.
- P5, versions (section 2). P6, whether the Store build accepts argv paths
  by AUMID (identity oracle: Settings hides `Check for updates` when
  packaged). P7, Mark-of-the-Web on the extracted portable exe (the driver
  runs `Unblock-File` on its own scratch file only). P8, `ShowWindow`
  SW_SHOWNOACTIVATE un-minimizes without activation. P9, the remembered
  save dir (`floe:saveDir`) reads back and restores through UIA.
- P10, `GET <server>/health` `features` on the server the profile drives
  (local for head, production for shipped; one GET, re-read on every run).
  Only short tokens are kept. Without `request-1` every request link cell
  SKIPs `server-no-request-1`; the Versions table carries it as the INFO row
  `Server features`.

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
`MIN_PROTOCOL_VERSION` in `client/lib/transfer/protocol.ts`; the two source
files only: `collectVersions` accepts a desktop About reading
(`desktopProtocol`) and nothing passes one, so the built app's own
`Transfer protocol` row is not compared). Statuses: CURRENT, STALE,
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
node .claude/skills/transfer-audit/scripts/audit.mjs run --profile shipped --quick --user-away --out <dir>
node .claude/skills/transfer-audit/scripts/audit.mjs run --profile shipped --out <dir>
node .claude/skills/transfer-audit/scripts/audit.mjs run --profile shipped --deep --out <dir>
node .claude/skills/transfer-audit/scripts/audit.mjs run --profile head --quick --desktop none --relaxed --out <dir>
```

With someone at the PC the first form is the whole run: on the default
`--desktop auto` (or `store`, or `portable`) it runs the web and CLI cells,
plans every cell with a desktop side as SKIP `present` without launching the
app, and exits 5. The second form adds the desktop cells when nobody is
there. `--allow-foreground` in its place runs them with the owner present,
who then loses the foreground to the Floe window on every click (section 0).

Run it with `run_in_background`; it prints `PROGRESS <cellId> <verdict>` as
cells finish and the headline at the end. Expected wall clock on this
machine (measured 2026-08-29, all green, desktop cells included): shipped quick about 1 minute,
default (18 rows) about 3, deep (35 rows) about 9 including the 3 GiB cap
cell, the 500 MiB throughput cell and both 200 MiB kill cells; head quick
with `--desktop none` takes about a minute. The deep figure was written
down beside a count of 32 rows, so read it as a floor. Announce
the run before starting it: the production limiters count the user's own
floe.one traffic on the same IP.

Profiles: `shipped` is api.floe.one plus Cloudflare TURN, the latest release
binaries and floe.one; `head` is the `floe-run` stack (started with
`--client --request-links`, and `--relaxed` when the run has it, when
nothing is bound; reused as it is when it is ours; refused when someone else
owns the port), a `go build` CLI with `-X
main.version=head-<sha7>`, `next dev`, and the desktop through `--desktop
wailsdev` (the real app with real Go bindings served at
`http://localhost:34115` to a Playwright page) or a `wails build` exe.
Subsets: `--quick` (6 cells), default (18 rows: 16 executable on either
profile, because the CLI's `--relay-only` lifts S-REL-C2C's NA; 15 with a
CLI older than v1.10.6, which has no such flag; 8 of them have a desktop
side and are SKIP `present` on an exe lane without `--user-away` or
`--allow-foreground`), `--deep`
(17 more, 35 rows). `--cells S-REL-*,S-DIR-C2D` narrows; a pattern that names no
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
`--caddy` (head only, a usage error on the shipped profile) enables
TA-14, the one cell that starts a Docker container: without it that cell
is SKIP `caddy-not-enabled`, and with it the dry run adds a `docker`
tool class (`docker version`) so a missing Docker shows before any cell.
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

Every exe the audit starts (the Store build by AUMID, the Store exe with
files, a portable or a head build) starts detached through
`scripts/lib/detached.mjs`: `Win32_Process.Create` makes the WMI provider
host its parent, so it holds no foreground rights even while the
operator's terminal is the foreground window, and its first window shows
`SW_SHOWNOACTIVATE` (FU-26: a launch from the foreground terminal took the
foreground twice on 2026-09-30). The cost is the app's stdout and stderr;
`desktop.launch.txt` records the pid instead. One start is the exception
(F1, field run of 2026-10-11): `Win32_Process.Create` answers 2, access
denied, for the Store package's exe when it carries files, which is how a
Store sender cell stages them. Then, and only under `--user-away`, the
driver spawns that exe itself (`launchDirect` in
`scripts/lib/detached.mjs`: detached, no console, no pipes);
`desktop.launch.txt` reads `direct launch (F1)` and the leg's evidence
carries `launch.started: "direct"`. Without `--user-away` nothing is
started and the cell is SKIP `present`, because a direct child of this
process can take the foreground. A leg never starts a second
instance: while any `floe-desktop.exe` or `floe-desktop-dev.exe` (the app
`wails dev` runs) is up, the cell is SKIP `desktop-running` before
anything starts, because the single-instance lock forwards a second
launch to the running app, which raises its own window. An instance this
run started and is still closing gets 5 s to go first.

Pacing on production: a rolling 60 s ledger with 50 percent headroom (10
TURN fetches, 15 connections, 30 code calls) and an 8 s floor between cell
starts. A 429 symptom penalizes one window and retries once; two in a row
mark the remaining production cells SKIP `infra-down` and exit 3. A TURN 429
degrades a peer to STUN (a browser says nothing, the CLI prints a warning),
which makes a relay-forced peer fail to connect or refuse to start, so the
ledger is not optional.

Relay forcing: the browser leg gets an init script that subclasses
`window.RTCPeerConnection` with `iceTransportPolicy: 'relay'`; the desktop
gets `hideIP:true`; the CLI gets `--relay-only` (also `FLOE_RELAY_ONLY=1`),
which every release since v1.10.6 accepts (#362, `faedbc7`; 1.10.5 and a
head build from an older worktree have no forcer and print no route), and
a CLI that has it prints `  Connected (direct)` or `  Connected (relay)` on
every connect. The driver detects the flag from `floe send --help`, so
`S-REL-C2C` is executable with a CLI that lists it and NA
`no-cli-relay-forcer` with one that does not, with no skill change.
One relay-only side relays the pair, so the forced side's oracle is the
proof and the other side's reading must agree.

Desktop hygiene the driver enforces: the Store build launches by AUMID for
receiver cells and, for sender cells, as the package's `floe-desktop.exe`
under `WindowsApps` with the files as argv (P6: `explorer.exe
shell:AppsFolder` drops the argument), with `desktop.json` backed up, edited
(`server`, `web`, `hideIP`, `reportStats:false`, `noUpdateCheck:true`,
`noToasts:true`, `migrated:true`; the toasts key is Settings > Notifications
off, so no cell raises a Windows toast, and the leg's evidence carries it as
`launch.noToasts`) while no Floe process exists, and restored byte-identical
after (sha256 compared, exit 4 on mismatch) with its original mtime put back
through `utimesSync` and read again (an mtime that will not come back is
reported as `mtime changed`, never a failure; the run manifest carries it,
so `cleanup` puts it back too); the portable and head exes
launch with `APPDATA` redirected; the per-user Explorer entry
`HKCU\Software\Classes\*\shell\Floe`, which an unpackaged exe points at
itself on startup and creates when there is none (the frontend turns the
entry on at first run, and a redirected `APPDATA` is always a first run), is
read once, at the first such launch in the process. An entry that was there
is put back by every stop and re-read. When there was none, a key that is
there at stop is removed, but only if its command is exactly the one the app
writes for an exe this run launched and the key holds nothing else; a key
for any other exe, or one with values of the owner's own, is left as it is
and noted. A restore or a removal that the re-read contradicts is a
SafetyError (exit 4 in a run; `probe` only notes it), and both are tried
once more, best effort, by the exit hook; files for
a send are staged on the first launch through argv (a second launch activates the window); the remembered
save dir is read before the first edit and set back after every receiver
cell, and on the Store build the Make link form's Save to folder is put back
the same way when a request cell releases its host (`request.saveTo` in
`attempt.json`; a field that will not take its old value turns a passing
cell into ERROR `host-release`); desktop direct cells move 64 MiB so the pill shows the route for more
than one 100 ms sample (a 12 MiB loopback transfer ends 0.4 s after
connect); the completion and status texts are read as joined text runs,
because React renders `Sent 1 item` and `Saved to <dir>` as adjacent text
nodes that UI Automation exposes one by one; history rows the run adds are
reported as `not counted` in the Safety section until an adapter can read
the History list. Closing is the app's own Cancel when a transfer is still
live, then `WM_CLOSE`, a second `WM_CLOSE`, and `taskkill` of the pid the
run started only after both. The `Close Floe?` dialog's buttons (`Keep open`
and `Close` since desktop-v0.3.0, `Keep going` and `Close anyway` before it)
are never clicked, by a run or by `cleanup`. Ctrl+C stops the legs and
restores `desktop.json` before exiting 130; the desktop teardown budget is
60 s. On the `wailsdev` lane the audit writes no `desktop.json` (the
operator's own decides), so toasts are off there only if the operator
turned them off.

## 4. Read the table (a retry that passes is a bug, not a flake)

`<out>/<runId>/audit.md` opens with one headline (`16/16 PASS, all surfaces
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
`browser-relay-na`, `wsl-stopped`, `wsl-sideload`, `harness-build`,
`head-only`, `disk-space`, `infra-down`, `budget-exhausted`,
`server-no-request-1`, `request-host-away-only`, `request-no-auto-switch`,
`request-accept-undrivable`, `request-daily-limit`, `caddy-not-enabled`,
`docker-absent`, `desktop-running`; `filtered` marks cells dropped by
`--cells` and is never counted). `head-only` is a head cell named in a
shipped run. `present` is the plan's answer for every cell with a desktop
side on an exe lane run with neither `--user-away` nor `--allow-foreground`
(section 0), and a leg's own answer when the owner comes back mid-cell
under `--user-away`. Each has its line in `SKIP_REASONS` in
`scripts/lib/matrix.mjs`, and a SKIP row names a triage key only for
`uia-setvalue`: for every other one the reason is the whole account. NA is
impossible with the product under test
(`single-instance`; `no-cli-relay-forcer` only with a CLI older than
v1.10.6). ERROR is a harness fault (for example `init-script-not-applied`,
or `request-savedir` when Make link was not handed the run's own folder),
never a product verdict.

One more SKIP is about the web under test and this machine together:
`web-checkpoint`. A page load was answered with Vercel's Security Checkpoint
(HTTP 403 with `x-vercel-mitigated: challenge`) instead of the app. Vercel
does that to one address after a burst of scripted requests, for some
minutes. The leg stops there, no later web leg or visitor of the run opens a
page, the run exits 5, the Infra row for floe.one names it, and a probe that
met it records P3 as unknown, never as a forcer that did not take (that
answer would SKIP every browser relay cell for the day `probe.json` is
reused). It is not floe.one being down, and the audit cannot tell from where
it runs whether other visitors are affected. Wait, then run again. A `deny`
or a bare 403 is not this SKIP: the leg goes on and fails.

What each side says about its own per-file SHA-256 check is carried as
evidence and never judged: the CLI's `Verified   SHA-256 matched` row and
the web app's `SHA-256 matched` line land in `completion.sender.verified`
and `completion.receiver.verified` (a browser leg also records the page's
last word as `verifiedLine`, because a sender page gets its line after
`All Files Sent!`). The browser leg reads the line inside the transfer card
only (the page's `main` element, as a line of its own): the homepage around
the card prints the same words in its terminal demo and quotes them in its
FAQ, so a read of the whole page answered yes on every web leg. A side that
shows no such line reads `null` there, and a browser leg's `verifiedLine`
reads `false` (`null` only for a page that could not be read), which is
what a
release before v1.11.0 does, and the cell passes or fails on the audit's own
hash compare exactly as before.

Exit codes: 0 clean; 1 any FAIL (or FLAKY under `--strict`); 2 usage; 3
precondition or infra abort; 4 a safety invariant tripped (a stats attempt
on an opted-out receiver, a `desktop.json` restore mismatch); 5 partial
(SKIP, FLAKY or ERROR present, no FAIL); 6 version drift only; 130
interrupted. Precedence 2, 4, 3, 130, 1, 5, 6, 0. `versions` exits 0 or 6,
`probe` 0 or 3, `cleanup` 0 or 1.

The Safety section is printed every run and must read: browser stats
attempts 0 (all aborted), `floe:bytes-reported` events 0, CLI receivers
opted out k/k, desktop receivers `reportStats:false, migrated:true` k/k with
`desktop.json: contents and mtime restored` after a Store-mode leg
(`contents restored byte-identical, mtime changed` when the mtime would not
come back, `restored byte-identical: NO` on a mismatch, `not edited (no
Store-mode leg)` when only portable, head or wailsdev ran), local `/api/stats` 0/0 on the head
profile, TURN bodies never, `server/.env` never read, captures N (desktop
PrintWindow captures; browser page screenshots are not counted) all
window-cropped, forced foreground 0, killed pids own only, working tree
unchanged, and firewall Block rules on the exes under test `none (N exe(s)
read)`.

One Safety row is a count with no required value: `Sentry envelopes
(browser, answered locally)`. An audit page is not a visit, so every browser
context answers the page's Sentry envelopes itself (`guardSentry` in
`scripts/lib/web.mjs`, matched by the path `/api/<project id>/envelope/`,
never by host: the real ingest host carries a region) and seeds Umami's own
off switch (`localStorage['umami.disabled']`), on senders, receivers and
request-link visitors alike. A run therefore adds no browser trace, no issue
and no page view to what the owner reads about real visitors, and an error
on an audit page still shows in the leg's `consoleErrors` and `pageErrors`.
What a browser route cannot reach is the server side: each page load is a
request to Vercel, and the share of them the server samples is traced there.

The firewall read covers the staged `--bin-dir` (a Block rule there is the
precondition it always was, exit 3) and every exe the run drives wherever it
lives: the Store build's `floe-desktop.exe` under its `InstallLocation` when
the Store build is under test, the portable or head `wails build` exe, the
CLI under test and the e2ehost harness. Each enabled inbound Block rule on
one of those is named by path in the Infra row `firewall (exes under test)`
and in Safety; it is evidence for a failed receive, not a gate. The read is
one `Get-NetFirewallApplicationFilter` pass: the audit never adds, removes
or changes a rule and never clicks a consent dialog (the rules are the
owner's).

## 5. When a cell fails (the receiver build decides the early race; read it first)

Open `references/triage.md` and match the exact string. The one rule that
matters most: a connect-then-nothing (both sides connected, zero bytes; CLI
`connected, but no data arrived from the sender within 30s`; desktop
`Error: The sender never started sending`, which a release before
desktop-v0.3.0 words `Connected, but the sender never started sending`) is
the early-message race, decided by the RECEIVER's build, fixed in v1.10.2
and desktop-v0.2.5. It is never retried and a green retry would be the bug
hiding, so the row prints the receiver build first. The desktop's error
lines are matched in both wordings (`SIGNATURES` in
`scripts/lib/triage.mjs`; the current ones are `RULES` in
`desktop/frontend/src/errors.ts`), so a 0.3.0 failure names its triage row
and an unreachable server still counts as an infra symptom.

Three browser states are named the moment the page shows them, where they
used to run a connect or done budget out: `receive-short` (the receiver
holds fewer files than the sender announced), `rejoin-failed` (the sender's
own room refused its re-join) and `sender-absent` (the receiver page says
nobody is on the sending side, and has said so for 20 s without a break,
because that state can clear by itself: a sender page whose socket dropped
retries its join up to 15 s apart). Two more only count when the
budget is about to run out, in its last 2 s: a receiver still on `Waiting
for the next file` (through 2a6e273) or `Waiting for the rest` (later main)
is `receive-short`, and a sender still on `Reconnecting to your link` is
`rejoin-failed`. floe.one runs the newest main and a self-host or an older
head keeps the older words, so the leg reads both. None of the three is
retried. Every FAIL block names its phase and a
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
(`--last`, the default, or the one named by `--run <id>`): every pid the
run recorded that still runs under the image it recorded is ended with
`taskkill /PID <pid> /T /F` (no Cancel click and no `WM_CLOSE`: those belong
to a leg's own stop, and `cleanup` has no driver on the window);
`desktop.json` restored from the backup with both hashes printed;
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

A hard kill (the node process ended before its `exit` hook ran) can still
leave `HKCU\Software\Classes\*\shell\Floe` pointing at a deleted scratch
exe, and `cleanup` does not replay it. When there was no entry before that
run, the key is one the run created, and no later run takes it for its own
(it names an exe that later run never launched), so the owner removes it
once: `reg delete "HKCU\Software\Classes\*\shell\Floe" /f`. The `wailsdev` lane is not covered
either, and there the key has two writers. The operator's own `wails dev`
app runs the same startup rewrite before the driver could take a snapshot.
And the audit's own page can write it: the frontend turns the Explorer
entry on at first run when its `floe:ctx-menu` marker is absent
(`desktop/frontend/src/App.tsx`, the mount effect that calls
`EnableContextMenu`), every Playwright context starts with empty storage,
and the dev server binds that call to the dev app (read from the code, not
observed in a run). Either way the entry ends up pointing at the dev exe
and nothing puts it back. The Wails
toast activator keys
(`HKCU\Software\Classes\AppUserModelId\floe-desktop.exe` and its CLSID
`LocalServer32`) are rewritten by every unpackaged launch too and are
deliberately not restored, because the next launch of a real unpackaged
Floe corrects them, packaged builds never read them, and go-toast shares
one CLSID across apps. H7 (S-14) specifies that the same `AppUserModelId`
key also carries `DisplayName` = `Floe`, written at launch before the
notification service starts so Windows lists the app as Floe; the audits
do not restore that value either, and an exe copy with its own name gets
its own key beside this one.

`cleanup` also does not undo what a request cell did inside the app. A link
a crashed run left open on the operator's `wails dev` app stays open: the
next request cell finds it and stops as ERROR `host-busy` before any click
(its folder is under another run's evidence root, so it is not swept), and
the owner closes it in the app with Close link. And `cleanup` does not put
back what the Make link form remembers in the app's own localStorage
(`floe:requestSaveDir`, the Save to folder a cell typed, and
`floe:requestLinkOpenUntil`). That only outlives a run on the Store build,
whose profile is the owner's: a portable or head exe keeps it under the
redirected `APPDATA`, and the `wailsdev` page is a fresh browser context
that takes its storage with it. On the Store build a request cell that ends
on its own puts the Save to folder back itself (section 3), so what is left
for the owner is the crash case: the field then still names a run folder,
and the run's `log.txt` has the line that says what it read before the
cell. No run saves into the owner's `Downloads`
folder: Make link is never clicked without the attempt's own folder in the
Save to field (ERROR `request-savedir` otherwise).

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
at the audit server and `reportStats:false`, and started without foreground
rights: `node .claude/skills/transfer-audit/scripts/launch-detached.mjs
--cwd desktop --log <file> -- <wails.exe> dev` runs it through
`Win32_Process.Create` in a hidden console that appends its output to
`<file>` (stop it with `taskkill /PID <pid> /T /F`), so the app window it
opens cannot take the foreground from the owner, and it refuses while any
Floe desktop already runs. A wailsdev receiver is refused
(exit 3) unless `GetSettings()` shows `reportStats:false`, `migrated:true`
and the audit server.

The lane first ran on 2026-09-22 (DV-MATRIX-DSK). Four things the lane needs
that no other lane does, every one of them learned from that run:

- **The sender's files.** `planLaunch` starts no process for `wailsdev`
  (`filesStaged: false`), so nothing carries the files on argv and the page
  opens on an empty drop zone. The leg hands them over first, through the
  `files:open` event `App.tsx` listens on, which is the same entry point
  Explorer's verb and a second instance use. The native picker behind the
  Files button (`SelectFiles()`) cannot be driven from a browser page, and
  `StartSend()` would skip the button the cell exists to exercise. The
  event goes through `window.wails.EventsNotify`, which reaches the leg's
  own page only: `runtime.EventsEmit` is rebroadcast by the dev server to
  every other page, and on 2026-09-24 it moved a request host's page to
  Send and stranded its Close link.
- **The receive view's primary button.** It carries the same accessible
  name as the RECEIVE tab, and the calm redesign left it a sibling of the
  field groups rather than of the code input, so it is reached by document
  order after the code input (the tab row is in the card header above the
  body), never by sibling position.
- **The room code and the share link.** They render together, from one
  `send:code` event, but the leg reads them one after the other, so it
  waits for both rather than returning on whichever read wins. `readText`
  answers with the innermost matching elements, because an element's
  textContent carries its descendants' and the page root would otherwise
  answer every loose pattern first, and a share link is parsed as a URL
  with a `#room=` fragment before the receiver is driven with it.
- **The relay forcer.** Every other mode takes `hideIP` from the
  desktop.json it launches with, but the operator starts this one and the
  audit never writes its config, so an `H-REL-*` cell with a desktop side
  sets Hide my IP through the Settings switch and puts it back on stop.
  The switch, not the bound `SetSettings` call: App.tsx passes its own
  React `hideIP` to `StartSend` and `ReceiveByCode`, and that state is read
  from `GetSettings` once at mount, so writing the file under a running
  page would persist a value the transfer never uses. `GetSettings` is read
  back as the proof, and a switch that will not move is a precondition
  failure rather than a relay cell quietly recorded as direct.

`wails dev` serves the page over its own websocket bridge, so the runtime's
`window.WailsInvoke("runtime:ready")` reaches the dev server's dispatcher,
which does not know that message and logs `ERR | Unknown message from front
end: runtime:ready`, once per page connect. Only the WebView2 frontend
handles it, and all it does there is set the CSS drag and drop property
names. It is noise for an external browser page: bound method calls (`C`)
and events (`EE`, `EX`) take different dispatcher branches, so nothing the
driver relies on is dropped.

Both head desktop lanes are built by `lib/desktop.mjs` `buildHead` from
`lib/release.mjs` `headDesktopCommands`. On `wailsdev` it runs no build step:
it requires `http://localhost:34115` to answer (exit 3 `wailsdev-down`
otherwise) and returns a build with no exe path, so P2 and P7 read `n/a` and
a release exe staged under `--bin-dir` is never adopted for them. On
`portable` it runs `npm run build` in `desktop/frontend`, then `wails build`
with no shell so the `-ldflags` value stays one argv element, and requires
the exe's mtime to advance, because `wails build` can exit 0 on a silent
failure. Both build dirs go through the write fence before the first step
runs, so nothing a plan names can land under the real `%APPDATA%\floe`. An
adapter without `buildHead` logs `HEAD desktop build pending` and every
desktop cell SKIPs `desktop-unavailable`.

## 7a. Request-link cells (need request-1 on the server)

TA-10 to TA-17 of spec 09 2.7.2, and TA-10a (Auto-accept, D-173), listed in
`references/matrix.md` (Request-link cells) and `REQUEST_IDS` in
`scripts/lib/matrix.mjs`. A run reaches them only through `--cells`, and
each SKIPs `server-no-request-1` until probe P10 finds `request-1`. On the
head profile a stack the run starts itself is started with
`--request-links`, which is what makes the local server list it. A stack
that is already up is reused as it is: one started by hand without that flag
keeps answering without `request-1`, and every request cell keeps SKIPping
until it is stopped and started again. A head relay cell (`H-REL-W2D-req`)
needs a stack the operator started with `--local-turn` as well.
`scripts/lib/request.mjs` runs them; `runCell` hands every request cell
to it, so none ever runs as a plain cell.

Every attempt of every request cell makes a link, the TA-17 cells included,
and the server makes 20 per network address in any 24 hours
(`REQUEST_CREATES_PER_DAY` in `server/server.js`; `--relaxed` does not lift
it). The create after that is answered `limited`, which is this machine's
budget and not a finding: the cell is SKIP `request-daily-limit`, and every
later request cell of the run SKIPs with the same reason before its host is
launched. A cell whose first attempt already FAILed keeps that FAIL when the
refusal meets its retry, and the note says the retry could not run. The
count is kept in the server's memory, so the local stack
starts a new one when it is restarted; on production only the 24 hours
move. Plan a request run inside that budget, earlier runs of the day
included.

- The host is the desktop: on the wailsdev lane through the DOM verbs on
  `PlaywrightDriver` (the table in matrix.md), and on an exe (the Store
  build, a portable or a head `wails build`) through the same verbs on
  `UiaDriver` (FU-26), which read the lane from one UIA `snapshot` of the
  window (`requestStateFromItems`: the buttons each phase shows and its
  fixed copy; the prompt's size as the view renders it, compared with
  `desktopFmtBytes` of the fixture; the drop folder by the name the Done
  view shows under the run's own save folder) and drive it with Invoke,
  SetValue and the `toggle` command. UIA pattern calls activate the
  exe's window (G2-F1), so an exe host is away-only: without `--user-away`
  its cells SKIP `present` (`request-host-away-only` when the run passed
  only `--allow-foreground`), and with it every pattern call first re-reads
  `GetLastInputInfo` and stops as SKIP `present` below 120 s of idle input.
  Accept and Decline are never invoked on an exe. The prompt ignores input
  for 1 s after every focus change, an Invoke is a focus change, and on the
  Store build no Invoke landed (field run of 2026-10-11: the button read
  disabled within 100 ms of each one, and the third threw
  `ElementNotEnabledException`). A prompted cell on an exe host therefore
  proves the link and the prompt, whose file count, size and folder go on
  record, and stops as SKIP `request-accept-undrivable` with nothing
  invoked and its link closed. Accept and Decline themselves are proven on
  the wailsdev lane, and a delivery on an exe by the Auto-accept cells
  below. Keep waiting is still invoked, 1.2 s after it shows: its guard has
  no focus term. An exe has
  no bound GetSettings or SetSettings: a proxy's server address rides the
  desktop.json it launches with (`serverOverride`). Since H7 (D-160) there
  is no Beta switch and no `requestLinks` key to seed (a legacy one in a
  desktop.json is ignored by the app and left as it is): the host waits up
  to 10 s for the REQUEST LINK choice on Receive, clicking RECEIVE once
  when the window is on another tab, and a build that never shows it is a
  `request-flow` FAIL at `host.start`.
  On an exe lane the TA-17 cells with a desktop side are NA
  `single-instance` (the host holds the one app instance).
- TA-16 (`H-DIR-C2D-req`, head only) makes the CLI the visitor:
  `floe send <file> --to <link> --server <s>` through the CLI adapter's own
  leg (`lib/cli.mjs`, `opts.requestLink`), started once it prints `Waiting
  for them to accept. They have 9 min to answer.` and done on its exit. The
  link goes to its argv only; the CLI never prints it back, `link()` answers
  null, and the leg's evidence, argv included, is scrubbed like every other.
  Oracles (`CLI_VISITOR_ORACLES`): the prompt, exit 0, the drop's bytes in
  the exclusive subfolder, the CLI's `All N files arrived (...)` line and
  its SHA line only when the host verified all N, the desktop's Done copy,
  the route pair (the CLI's `Connected (direct)` and the D pill), the
  desktop.json proof, FLOE_NO_STATS=1 on the CLI (a sender has no stats path
  at all) and a local `/api/stats` delta of 0. A CLI that fails is judged
  after the host's own end, so a host stop code stays the finding. No
  used-up check: that needs a second visitor, and the web cells prove it.
  The released CLI has listed `--to` since v1.11.0 (preflight records that
  as `cliHasTo`), and it is the visitor of `S-DIR-C2D-reqauto` below.
  `REQUEST_IDS` has no `S-DIR-C2D-req` on purpose: on a built exe a
  prompted cell stops at the prompt, which `S-DIR-W2D-req` already proves,
  and it would spend one of the day's 20 links to do so.
- Before the run: the operator's `wails dev` app must already read
  `reportStats:false`, `migrated:true` and the local server
  (`GetSettings`), as for any wailsdev receiver; otherwise the cell is
  ERROR `wailsdev-config` and the host is never driven.
- Each attempt makes its own link: Hide my IP on for TA-12, the REQUEST LINK
  tab awaited (10 s; no Settings switch since H7, and a server without
  request-1 answers at Make link with E1, a `request-flow` FAIL naming
  `disabled`), Make link with the Save to field set to the
  attempt's own `out` folder (never the owner's `Downloads\Floe`;
  a field that does not take is SKIP `desktop-savedir`), then Read link.
- The visitor is a fresh Chromium context on `/r`: the files go into the
  hidden "Choose files" input, Send is clicked by its label, and the
  page's own status card is read. Relay cells move 4 MiB; TA-11 forces the
  visitor's relay with the audit init script, TA-12 the host's Hide my IP.
- On the wailsdev lane Accept and Decline wait at least 1.2 s from the
  moment the prompt was first seen (the frontend's guard is 1 s); on an exe
  they are not invoked at all. Every prompt must carry the visitor's own
  file count and bytes (on an exe, the size as the view renders it) and no
  relay-over-cap line.
- Oracles: the route pair (the visitor's nominated candidate pair, the
  host pill or the lane's route); the host's stats proof and 0 report
  attempts on every visitor (a `floe:bytes-reported` event on a visitor
  is a safety stop); the host's saved and verified counts, its done heading
  and the check mark's SHA-256 matched text (since D-161 the sr-only span
  beside the green check, read as a Text node on UIA and a span on the dev
  page; on an exe host it is the only account, so a done view without it is
  a `request-flow` FAIL that names the host's view), and the visitor's
  arrived title and SHA line, each SHA mark shown only when every file
  verified; the received files byte for
  byte inside the one exclusive subfolder the host reports, nothing loose
  beside it (`request-manifest`, `hash-mismatch`, `stale-part`); a fresh
  visitor reading the link used up afterwards. A failed step is FAIL
  `request-flow` with the fixed copy it met, never retried.
- TA-13 (`H-DIR-W2D-reqblip`) starts the driver's own proxy
  (`scripts/lib/blip.mjs`, 127.0.0.1 only, loopback upstream only), points
  the host's server address at it through the app's own SetSettings (web
  address set to the web under test), makes the link, cuts for 5 s, and
  requires Reconnecting, the visitor's not-connected copy, the reclaim to
  Waiting within 60 s and a delivery after Try again. `cellPlan` refuses
  the cell against a server that is not loopback, the runner refuses it
  again as a safety stop before any proxy or page, and the proxy refuses a
  non-loopback upstream: it can never point at api.floe.one. A host that
  is not behind the proxy (no proxy URL, a server address that did not
  read back, or no live socket through it before the cut) is ERROR
  `blip-url` and nothing is cut: a cut of a proxy the host bypasses would
  read the host's correct Waiting as a product defect.
- TA-14 (`H-DIR-W2D-reqcaddy`, head profile, `--caddy` only) starts a
  local Docker Caddy (`scripts/lib/caddy.mjs`: `caddy:2`, published on
  127.0.0.1 only, `reverse_proxy host.docker.internal:<port>` to the
  loopback server) and points the host's server address at it, as TA-13
  does with its blip; the visitor's page talks to the server directly.
  A `caddy reload` while the link waits must read Reconnecting within
  10 s, or the cell is ERROR `caddy-url` (the host was not behind the
  proxy, so the reload proved nothing), then Waiting again within 60 s;
  a 64 MiB drop is then accepted and a second reload lands while it is
  receiving, so the visitor is sent `peer-disconnected` and must ignore
  it (a drop that ends before that reload is ERROR
  `caddy-reload-missed`, never a pass). Verify is the usual set. A
  server that is not loopback is refused by `cellPlan`, by the runner
  before any container, and by the upstream check; Docker not answering
  is SKIP `docker-absent`; the container is removed at teardown and on
  exit. Proven on fixtures only until it runs live.
- TA-15 declines the first visitor, reads its declined copy, checks
  nothing was saved, clicks Keep waiting (`request-reopen`) and lets a
  second visitor context deliver.
- TA-10a (`reqauto`: `H-DIR-W2D-reqauto`, and the shipped twins
  `S-DIR-W2D-reqauto` with a web visitor and `S-DIR-C2D-reqauto` with the
  released CLI as the visitor) makes its link with the Make link form's
  Auto-accept check on (D-173, D-174). It requires the header chip to read
  AUTO-ACCEPT while the link waits (its sampler keeps that word as idle,
  never as a route) and the drop to start with no prompt at any point and
  nothing clicked on the host; every other TA-10 oracle applies (the CLI
  twin takes TA-16's, without a used-up check). These are the one delivery a
  built exe can prove, since nothing has to press Accept. On the wailsdev
  lane the check is turned on through its label and the host's link and
  result must be marked automatic in `GetRequestLink`. An exe has no such
  record to read, so there the check is set through TogglePattern and read
  back, the link block must end in `Accepts automatically` (FAIL
  `request-flow` otherwise), and the result's mark goes on record as
  unknown (`result.autoAccepted: null`, `auto.proof: "link-block"`): a
  build that forgot the mark passes on an exe and fails on the dev page.
  The app still asks on an automatic link when a drop is unusual
  (`desktop/requestauto.go`): a prompt warning, free space it could not
  read, a volume without the downloaded-file mark (FAT, exFAT, many network
  shares), or a drop that would leave under 20 GiB or a tenth of the drive
  free. So `--out` belongs on an NTFS drive with room. A link that reads
  `Asks first, low space on <drive>` is FAIL `request-flow` by name before
  anything is sent, and any other prompt is FAIL `request-flow`
  (`the host went deciding`), with nothing answered. A build without the
  check SKIPs `request-no-auto-switch`. Every other cell leaves the check
  off, Make link fails `request-flow` when the host holds the other choice,
  and a prompted drop marked automatic is a FAIL.
- TA-17 (`-reqopen`) is the six quick cells with a link open on the
  desktop: the host makes a link into its own `host-drops` folder after
  setup, the quick cell runs as always, and verify requires the same link
  still waiting and that folder empty. It needs the desktop even for its
  W2W cell.
- Teardown, pass or fail, and on an interrupt too (the host leg's stop):
  a running drop is canceled, the cell's link closed or its result put
  away and the blip's addresses restored. Every request
  verb first brings the host page back to Receive > REQUEST LINK when it
  is not showing it, so a page that moved to Send still gets its link
  closed. Only a link generation the cell made is touched at teardown. A
  live link found when a cell starts is closed first only when it saves
  into this run's own
  evidence root (a leftover of an earlier cell, noted as swept); any other
  is the owner's, is left exactly as it is, and the cell is ERROR
  `host-busy` before any click. A release that does not leave the host as
  found (the link still open, the result still showing, the address not
  restored, or a release that outlived the teardown budget) turns a cell
  that otherwise passed into ERROR `host-release`; a
  cell that already failed keeps its own finding with the same words as a
  note.
- The link carries the room after `#`: it goes to the visitor's
  `page.goto` only. Every message, note, log line and evidence file passes
  through `redactRequestLinks` (`#<room>`, the link id stays), and the
  report's redaction applies the same net to audit.md and run.json. The
  host's captures can show the link on screen, so they go under
  `cells/<id>/attempt-<n>/private/host/`: never share that folder.
  audit.md and run.json count them (`privateCaptures`) and never quote
  their paths; an Evidence line names the attempt folder instead.
- TA-12's over 2 GB prompt line (P6) is not reachable from a web visitor:
  the page probes its route 2 s after the channel opens and blocks a
  relayed drop over the cap before it sends any metadata, so no prompt
  reaches the host. TA-12 proves the host-forced relay path only.

Owner-away order for a built app. One command per idle window (see Traps),
in this order, each prefixed with
`node .claude/skills/transfer-audit/scripts/audit.mjs` and given the same
`--out <dir>`. Every line carries `--user-away`: without it nothing here
launches the app at all. Steps 3 to 5 spend one of the day's 20 links each.

1. `probe --profile shipped --desktop store --user-away --monitor secondary`
2. `run --profile shipped --desktop store --user-away --monitor secondary --cells S-DIR-D2C`
   (a Store sender: `desktop.launch.txt` names the direct launch when
   `Win32_Process.Create` refused the exe with files)
3. `run --profile shipped --desktop store --user-away --monitor secondary --cells S-DIR-W2D-reqauto`
   (the delivery: the check toggled on, the chip AUTO-ACCEPT, no prompt, the
   hashes equal, and `request.saveTo.restored` true)
4. `run --profile shipped --desktop store --user-away --monitor secondary --cells S-DIR-W2D-req`
   (expected: SKIP `request-accept-undrivable` with the prompt on record;
   its `request.saveTo.before` must be the owner's own folder, not step 3's)
5. `run --profile shipped --desktop store --user-away --monitor secondary --cells S-DIR-C2D-reqauto`
   (the released CLI as the visitor)
6. `probe --profile shipped --desktop portable --user-away --monitor secondary`,
   then `run --profile shipped --desktop portable --user-away --monitor secondary --cells S-DIR-D2C`
   (the Explorer key: with none before the run, the sender's notes in
   `attempt.json` read `explorer verb: ... absent before the run` and then
   `explorer verb: removed ...`)

Not covered by any cell, so a green request run says nothing about them:

- Link expiry. Every cell makes a 24 hour link and none waits for one to
  end; the five other Link ends choices are only ever a label the Make link
  verb can pick.
- Close link as a finding. Teardown closes the cell's own link, but no
  visitor is opened on a closed link to read `This link has ended`.
- Stop. Cancel drop on the host, and a visitor that cancels, are teardown
  steps only, never an oracle.
- The receiver's limits (`requestLimits` in `desktop/transfer.go`, and the
  10,000 files a drop may carry).
- Accept and Decline on a built exe. No UIA Invoke presses them there (SKIP
  `request-accept-undrivable`), so both are proven on the wailsdev lane
  only, and `H-DIR-W2D-reqdecline` has no shipped twin.
- A prompted CLI visitor on a shipped build. There is no `S-DIR-C2D-req`:
  it would spend one of the day's 20 links to stop at the prompt
  `S-DIR-W2D-req` already proves. The released CLI delivers through
  `S-DIR-C2D-reqauto`.
- The automatic mark on a built exe: the result's `autoAccepted` and
  History's `Accepted automatically` line. Only the dev page reads the
  first, and nothing reads the second.

## 7b. Forced-mismatch cells (hashbad and hashmal: head only, reached through --cells)

These prove a receiver refuses a file whose SHA-256 cannot be right. They
are not deep cells and no default walk includes them: `--cells` names them
on the head profile (`HASH_IDS` in `scripts/lib/matrix.mjs`, the table in
`references/matrix.md`), and a shipped run that names one SKIPs it as
`head-only`, because it would drive production with a sender that lies.
The sender sends a digest that cannot match (`hashbad`, one hex digit
changed) or one the wire format forbids (`hashmal`, upper case), and the
receiver must refuse with `hash-mismatch` and keep nothing. The CLI-shaped
sender they need is `go build ./internal/e2ehost` in `cli/`, which no
release builds: a run builds it into `--bin-dir` itself when a planned cell
needs it, or SKIPs those cells as `harness-build`, and the harness reports
its own path as `direct` or `relay` so the route is still judged from both
sides.

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
when the side-load fails. A firewall Block rule on the staged path is not a
SKIP: it stops the whole run before any cell as a precondition (exit 3).

## Traps on this machine (each one cost a run)

- **Keys typed at the PC land in a window the audit launched.** A pattern
  call activates the exe's window, so what the owner types next goes to
  Floe, into the very field the driver just set. The helper reads a
  SetValue back once, 150 ms later (`settleMs` in
  `scripts/desktop-uia.ps1`), the leg compares that one reading, and
  nothing reads the field again before Receive or Make link is clicked. A
  value that read back right can therefore still be wrong when it is used.
  Away-only is the guard; there is no second read yet.
- **Something on this PC makes an input event about every 219 s, even with
  nobody there.** `--user-away` wants 120 s of idle input before each
  pattern call, so every cycle leaves about 95 s in which the desktop may be
  driven. That is one or two desktop cells per run: name them with `--cells`
  rather than asking for the whole matrix, and expect SKIP `present` on a
  cell that straddles the event.
- **Twenty request links a day.** Each attempt of each request cell spends
  one, and so did every earlier run of the day from this address (section
  7a).
- **A burst of scripted page loads gets this machine challenged.** On
  2026-10-12, after the transfer cells and 46 scripted loads of `/r` inside
  an hour, Vercel answered floe.one requests from this address with its
  Security Checkpoint (HTTP 403, `x-vercel-mitigated: challenge`) for a few
  minutes, to curl and to a browser alike. A run that meets it ends its web
  legs as SKIP `web-checkpoint` (section 4). Space runs out, and do not
  retry in a loop: every further load keeps the challenge alive.
- **`probe.json` is one lane's answer.** It is reused only for the same
  `--desktop` value and profile, so a lane switch probes again (section 1).
  Keep one `--out` per lane when alternating, or plan for the extra away
  cycle.
- **Two Store-lane facts** (field run of 2026-10-11, Store 1.3.0.0), both
  handled now and neither a product finding. `Win32_Process.Create` refuses
  the Store exe when it carries files (return value 2), which is how a
  Store sender cell stages them: under `--user-away` the driver starts that
  exe itself and says so in `desktop.launch.txt` (section 3). Whether that
  start stages the files, and whether it takes the foreground, no run has
  shown yet. And no UIA Invoke presses Accept on a built exe, so a plain
  `-req` cell there proves its prompt and stops as SKIP
  `request-accept-undrivable`; a delivery on an exe is the `reqauto` cells'
  (section 7a).
- **Nothing on the desktop runs by default.** On an exe lane a run or a
  probe with neither `--user-away` nor `--allow-foreground` launches nothing
  and reports every desktop cell as SKIP `present` (section 0). A report
  with no desktop rows run is that default, not a broken lane.

## Done means

- `probe.json` written for this machine, every probe with a verdict.
- The Versions table with every gating row CURRENT or PARITY, or the drift
  named with its command.
- A shipped run whose headline reads all PASS, or whose FAIL rows carry a
  signature, a triage key and both transcripts, and whose SKIP and NA rows
  each carry a reason key.
- The Safety section reading zero everywhere it must, and `desktop.json`
  restored byte-identical with its mtime (or the changed mtime named).
- `cleanup` run; no Floe process left; the working tree unchanged.

Green is a gate, not a proof: a cell passes on this machine, today, against
this infrastructure. All peers sit on one host (the WSL cell is the one
non-loopback path), the portable build is not the Store package byte for
byte, the browser has no release tag of its own (its one oracle is the
`commit` that `/api/config` carries), and throughput here says nothing
about a real link. What
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
  `client/hooks/useTransferAnalytics.ts`, `client/lib/receiveSummary.ts`,
  `client/lib/rejoinRetry.ts`, `client/lib/roomSeat.ts` and
  `client/lib/verifiedLine.ts` (the page states and the SHA-256 line the web
  leg reads), `client/lib/request/visitorCopy.ts` (the `/r` page's copy),
  `desktop/frontend/src/App.tsx`, `desktop/frontend/src/requestCopy.ts`
  (every Request link string), `desktop/frontend/src/errors.ts` (the error
  lines), `desktop/app.go`, `desktop/transfer.go`, `desktop/config.go`,
  `cli/cmd/floe/main.go`, `cli/cmd/floe/send.go`, `cli/cmd/floe/receive.go`,
  `cli/cmd/floe/sendto.go` (`floe send --to`),
  `cli/engine/transfer/sender.go`,
  `cli/engine/transfer/receiver.go`, `cli/engine/peer/connection.go`,
  `server/server.js` (the connection and code limiters), `server/stats.js`
  (the stats limiter), `server/turn.js` (the TURN limiter and
  `/api/turn-credentials` precedence).
- Memory: `reference_transfer_audit_harness`,
  `reference_datachannel_early_message_race`,
  `project_floe_local_install_hygiene`, `project_deployment_topology`,
  `feedback_owner_autonomy`.
