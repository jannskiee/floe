# Cell catalog

The cells `audit.mjs run` executes, with the forcer, the oracles and the
timeouts each one carries. Recorded from the code on 2026-08-29; a `file:line`
is the source at that date, re-check it when a string moves. The driver's own
copy of this table is `scripts/lib/matrix.mjs` (`cellPlan`), and the two must
agree: a row here without a plan entry, or the reverse, is a bug.

## Id scheme

```text
<profile>-<path>-<snd>2<rcv>[-<variant>]
profile  S = shipped (api.floe.one + Cloudflare TURN, latest release binaries, floe.one)
         H = head    (floe-run stack on :3001/:3000, HEAD binaries, direct only unless local TURN)
path     DIR = direct expected, no side may observe relay
         REL = relay expected, at least one side must observe relay
surface  W = web browser (Playwright chromium)   C = CLI (Windows)
         D = desktop (Store build or portable)    L = CLI inside WSL2 Ubuntu-22.04 (deep only)
variant  link | bnd8 | fold | zip | cap3g | thr500 | killsnd | killrcv
```

Examples: `S-DIR-W2C`, `S-REL-C2D`, `H-DIR-C2C-bnd8`, `S-DIR-L2W`.

## What each surface can do

| Surface    | Relay forcer                                                                                                                           | Route oracle                                                                                                                                                                                                                                                                                                                                                                                                       | Completion                                                                    | Stats opt-out proof                                                                                                                                                                  | Source                                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| W sender   | init script wrapping `window.RTCPeerConnection` with `iceTransportPolicy:'relay'` (re-verified by probe P3 on every run that needs it) | `getStats()` nominated `candidate-pair` sampled while live; window event `floe-connection-status` (`direct`, `relay`, `connected`, `offline`); pill textContent `Direct`, `Relay`, `Ready`, `Offline`                                                                                                                                                                                                              | `All Files Sent!`                                                             | senders never report                                                                                                                                                                 | `client/components/P2PTransfer.tsx:517-524,755`; `client/components/ConnectionStatusBadge.tsx:59-66`; `client/hooks/useConnectionType.ts:20-31` |
| W receiver | same init script                                                                                                                       | same                                                                                                                                                                                                                                                                                                                                                                                                               | `N file received` or `N files received`; one `a[download]` blob href per file | `localStorage['floe:report-stats']` seeded to the literal string `false` before load; `ctx.route('**/api/stats/report', abort)` counting attempts; `floe:bytes-reported` never fires | `client/components/P2PTransfer.tsx:1106-1113`; `client/hooks/useTransferAnalytics.ts:17,40,60-62`; `client/e2e/docs-screenshots.mjs:52-57`      |
| C sender   | none (`--no-relay` is the opposite); `--relay-only` is detected at runtime when `floe send --help` lists it                            | prints nothing; positive-only oracle: the refusal `transfer blocked: relay connections are capped at 2 GB (selected ` on a payload over 2 GiB; optional `PION_LOG_TRACE=ice` stderr line `Set selected candidate pair:` containing the word `relay` (relay legs only, `--pion-trace`); a CLI that carries `--relay-only` (HEAD since #362) prints `  Connected (direct)` or `  Connected (relay)` on every connect | summary box row `Sent`, exit 0                                                | senders never report                                                                                                                                                                 | `cli/cmd/floe/main.go:111-113,273,393` (route line from `connectedLine`, `main.go:150-158`); `cli/engine/transfer/relay.go:29,70`               |
| C receiver | none                                                                                                                                   | as above                                                                                                                                                                                                                                                                                                                                                                                                           | summary rows `Received`, `Time`, `Saved to`, exit 0                           | argv `--no-report` and env `FLOE_NO_STATS=1` recorded (either suffices at `main.go:407-410`)                                                                                         | `cli/engine/transfer/receiver.go:548-552`; `cli/cmd/floe/main.go:323,408`                                                                       |
| D sender   | `hideIP:true` in `desktop.json` before launch (read once at launch)                                                                    | pill text `Active` then `Direct` or `Relay` (the text, not the dot: while the route is unknown the dot is amber whenever hideIP is on); Wails event `send:route` on the wailsdev lane                                                                                                                                                                                                                              | `Sent 1 item` or `Sent N items`                                               | senders never report                                                                                                                                                                 | `desktop/frontend/src/App.tsx:1917,2440-2449,2607`; `desktop/app.go:586-591,909-911`                                                            |
| D receiver | `hideIP:true`                                                                                                                          | pill text; `recv:route` on the wailsdev lane                                                                                                                                                                                                                                                                                                                                                                       | `Saved to <dir>`                                                              | `desktop.json` holds `reportStats:false` and `migrated:true`, hashed before launch, restored byte-identical after                                                                    | `desktop/frontend/src/App.tsx:1232-1248,2662`; `desktop/app.go:1067-1069,1074-1077`                                                             |
| L sender   | none                                                                                                                                   | none (as C)                                                                                                                                                                                                                                                                                                                                                                                                        | as C                                                                          | n/a                                                                                                                                                                                  | the WSL2 harness in memory `project_release_1_10_3_and_0_2_6`                                                                                   |

Which side's evidence counts. Both classifiers OR over the pair
(`cli/engine/peer/connection.go:480`, `client/lib/relay.ts:28`), so one
relay-only side relays the pair.

| Pair        | REL forcer     | REL evidence required                                                                   | DIR evidence required                                                                                           |
| ----------- | -------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| W2W         | sender context | both W; the forced side must show `local=relay`                                         | both W read `direct`                                                                                            |
| W2C         | W              | W                                                                                       | W reads `direct`                                                                                                |
| W2D         | W              | W, plus the D pill                                                                      | W and D read `direct`                                                                                           |
| C2W         | W (receiver)   | W                                                                                       | W reads `direct`                                                                                                |
| C2C         | none           | NA until `--relay-only` is detected                                                     | direct by construction: L2C both legs `--no-relay`; L2W and L2D as W2\* and D2\* (the W or D side reads direct) |
| C2D         | D (hideIP)     | D pill                                                                                  | D reads `direct`                                                                                                |
| D2W         | W (receiver)   | W `local=relay`, plus the D pill                                                        | both read `direct`                                                                                              |
| D2C         | D (hideIP)     | D pill                                                                                  | D reads `direct`                                                                                                |
| D2D         | n/a            | NA: single instance (`one.floe.desktop` mutex; a second launch forwards argv and exits) | NA                                                                                                              |
| L2\* (deep) | none           | not offered                                                                             | L2C both legs `--no-relay`; L2W and L2D as W2\* and D2\*                                                        |

`--no-relay` is passed only where both legs are CLIs (C2C, L2C): everywhere a
peer has a route oracle, the shipped default ICE path is what gets tested.

## Default matrix, shipped profile (18 rows: 15 executable, 3 NA)

Fixtures: `fixture-<size>.bin` of random bytes, sha256 recorded at creation.
DIR cells move 12 MiB (the e2e size), except the four with a desktop side
(W2D, C2D, D2W, D2C), which move 64 MiB: at loopback speed a 12 MiB transfer
is busy for about 0.4 s (measured 2026-08-28, avg 29 MB/s), too short for
the pill, which shows `Direct` or `Relay` only while busy, and for the
completion oracle. REL cells move 4 MiB (relay egress is metered; measured
relay throughput 1.5 to 2.6 MB/s). Receiver input is `code`
when both sides are C or D and `link` whenever W is on either side (the
browser has no code UI, `client/components/P2PTransfer.tsx:67-85`). The
`link`, `bnd8`, `fold` and `zip` variants use link input even on all-CLI
pairs.

| Cell      | Snd | Rcv | Path | Forcer            | Input | Size   | Required oracles                                                                                                             |
| --------- | --- | --- | ---- | ----------------- | ----- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| S-DIR-W2W | W   | W   | DIR  | none              | link  | 12 MiB | blob sha256; `All Files Sent!`; `1 file received`; both W `direct`; stats attempts 0, no `floe:bytes-reported`, seed `false` |
| S-DIR-W2C | W   | C   | DIR  | none              | link  | 12 MiB | on-disk sha256; `All Files Sent!`; C exit 0 with `Received` and `Saved to`; W `direct`; C argv+env proof                     |
| S-DIR-W2D | W   | D   | DIR  | none              | link  | 64 MiB | on-disk sha256; `All Files Sent!`; D `Saved to`; W `direct` and D pill `Direct`; desktop.json proof                          |
| S-DIR-C2W | C   | W   | DIR  | none              | link  | 12 MiB | blob sha256; C `Sent` exit 0; W `1 file received`; W `direct`; W stats proof                                                 |
| S-DIR-C2C | C   | C   | DIR  | both `--no-relay` | code  | 12 MiB | on-disk sha256; both exit 0; `Sent` and `Received`; route `direct (--no-relay both)`; C receiver proof                       |
| S-DIR-C2D | C   | D   | DIR  | none              | code  | 64 MiB | on-disk sha256; C `Sent` exit 0; D `Saved to`; D pill `Direct`; desktop.json proof                                           |
| S-DIR-D2W | D   | W   | DIR  | none              | link  | 64 MiB | blob sha256; D `Sent 1 item`; W `1 file received`; D pill and W `direct`; W stats proof                                      |
| S-DIR-D2C | D   | C   | DIR  | none              | code  | 64 MiB | on-disk sha256; D `Sent 1 item`; C exit 0; D pill `Direct`; C proof                                                          |
| S-DIR-D2D | D   | D   | DIR  | n/a               | n/a   | n/a    | NA `single-instance`                                                                                                         |
| S-REL-W2W | W   | W   | REL  | sender context    | link  | 4 MiB  | blob sha256; completion both; sender W `local=relay`; receiver W `relay`; stats proof                                        |
| S-REL-W2C | W   | C   | REL  | W sender          | link  | 4 MiB  | on-disk sha256; W `local=relay`; C exit 0; C proof                                                                           |
| S-REL-W2D | W   | D   | REL  | W sender          | link  | 4 MiB  | on-disk sha256; W `local=relay`; D pill `Relay`; D `Saved to`; desktop.json proof                                            |
| S-REL-C2W | C   | W   | REL  | W receiver        | link  | 4 MiB  | blob sha256; C `Sent` exit 0; W `local=relay`; W stats proof                                                                 |
| S-REL-C2C | C   | C   | REL  | none              | code  | n/a    | NA `no-cli-relay-forcer`; executable once `floe send --help` lists `--relay-only`                                            |
| S-REL-C2D | C   | D   | REL  | D hideIP          | code  | 4 MiB  | on-disk sha256; D pill `Relay`; D `Saved to`; C exit 0; desktop.json proof with `hideIP:true`                                |
| S-REL-D2W | D   | W   | REL  | W receiver        | link  | 4 MiB  | blob sha256; D `Sent 1 item`; W `local=relay`; D pill `Relay`; W stats proof                                                 |
| S-REL-D2C | D   | C   | REL  | D hideIP          | code  | 4 MiB  | on-disk sha256; D pill `Relay`; C exit 0; C proof                                                                            |
| S-REL-D2D | D   | D   | REL  | n/a               | n/a   | n/a    | NA `single-instance`                                                                                                         |

The route oracles in this column are the sides expected to answer. The
report's Route column names the observed path and the sides that observed
it (`direct [W]`, `relay [W local,D]`, `direct [--no-relay both]`). A DIR
cell where no side observed the path (the desktop pill never showed
`Direct`, the browser sampled nothing) still passes when every other oracle
is met, with the Note `route-unproven (no route oracle answered)`, because
the shipped product offers no stronger direct-path proof; a REL cell with no
relay evidence never passes (`route-unproven` or `forcer-ineffective`).

Desktop precondition for every D cell on the shipped profile: the `probe`
result. When `ValuePattern.SetValue` on `placeholder="amber-otter-cloud"`
followed by Invoke `Receive` yields `Please enter a code or link.`
(`desktop/frontend/src/App.tsx:1712`), every D-receiver cell is SKIP
`uia-setvalue`; when the save-dir field cannot be set either, they are SKIP
`desktop-savedir` (the app must never write into the real Downloads folder).
D-sender cells need only argv staging plus one Invoke on `Send 1 item`, so
they survive a negative SetValue probe.

## `--quick` (6 cells, shipped)

```text
S-DIR-W2W   floe.one to floe.one, the most common real pairing
S-DIR-C2W   CLI sends, browser receives
S-DIR-W2C   browser sends, CLI receives
S-REL-W2C   browser relay-forced sender, CLI receiver (proves Cloudflare TURN)
S-DIR-D2C   desktop sends (argv staging + one Invoke), CLI receives
S-DIR-C2D   CLI sends, desktop receives (the cell shape that shipped the early race twice)
```

The two desktop cells move 64 MiB (the desktop-side DIR size above); the
other four move 12 MiB.

A negative P1 probe gives 5 PASS + 1 SKIP `uia-setvalue` and exit 5, which is
the honest answer.

## `--deep` additions (14 cells, shipped)

| Cell              | Snd | Rcv | Path | What it proves                                                   | Fixture                                                         | Expected                                                                                                                                    |
| ----------------- | --- | --- | ---- | ---------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| S-DIR-C2C-bnd8    | C   | C   | DIR  | framing at chunk boundaries                                      | 8 files: 0, 512, 16383, 16384, 16385, 262143, 262144, 262145 B  | 8 sha256 matches; `Received  8 files`                                                                                                       |
| S-DIR-W2C-bnd8    | W   | C   | DIR  | browser sender chunking at the same boundaries                   | same 8                                                          | same; `Create secure link (8 files)`                                                                                                        |
| S-DIR-C2C-sizes   | C   | C   | DIR  | both `--no-relay`                                                | code                                                            | 111 MiB                                                                                                                                     | the size ladder 1 B, 1 KiB, 64 KiB, 1 MiB, 10 MiB, 100 MiB in one batch; on-disk sha256 per file; both exit 0          |
| S-DIR-W2C-sizes   | W   | C   | DIR  | none                                                             | link                                                            | 111 MiB                                                                                                                                     | the same ladder from the browser sender, which reads every file through the File API                                   |
| S-DIR-C2D-sizes   | C   | D   | DIR  | none                                                             | code                                                            | 111 MiB                                                                                                                                     | the same ladder into the desktop, the only cell that hands it more than one file; `Saved to <dir>` then sha256 on disk |
| S-DIR-C2C-fold    | C   | C   | DIR  | folder structure preserved                                       | `send-root/a.txt` 1 KiB, `b.bin` 262157 B, `nested/c.bin` 1 MiB | files at `<out>/send-root/<rel>`, 3 hashes; empty dirs are never recreated                                                                  |
| S-DIR-C2W-zip     | C   | W   | DIR  | browser ZIP path                                                 | same folder                                                     | `Download ZIP` captured with `page.waitForEvent('download')`, 3 entries hashed with the zip reader                                          |
| S-REL-C2W-cap3g   | C   | W   | REL  | the relay cap refuses before any byte moves                      | 3 GiB sparse                                                    | C stderr starts `Error: transfer blocked: relay connections are capped at 2 GB (selected `, exit 1; W shows no `a[download]`; never retried |
| S-DIR-C2C-thr500  | C   | C   | DIR  | throughput baseline                                              | 500 MiB                                                         | integrity; MB/s from the `Time` row; WARN note below 10 MB/s                                                                                |
| S-DIR-C2C-killsnd | C   | C   | DIR  | a killed sender leaves no `.part`                                | 200 MiB                                                         | sender killed at 50 MiB; receiver exit 1; no `.part`, no final file                                                                         |
| S-DIR-C2C-killrcv | C   | C   | DIR  | a killed receiver leaves one `.part`; the retry never overwrites | 200 MiB                                                         | one `.part`; the second attempt into the same dir lands `name (1).bin`                                                                      |
| S-DIR-C2C-link    | C   | C   | DIR  | link input on the CLI receiver                                   | 12 MiB                                                          | as C2C                                                                                                                                      |
| S-DIR-C2D-link    | C   | D   | DIR  | link input on the desktop receiver                               | 12 MiB                                                          | as C2D                                                                                                                                      |
| S-DIR-D2C-link    | D   | C   | DIR  | the link read from the desktop share panel                       | 12 MiB                                                          | as D2C                                                                                                                                      |
| S-DIR-L2C         | L   | C   | DIR  | a non-loopback direct path                                       | 12 MiB                                                          | as C2C; SKIP `wsl-sideload` when the Linux CLI cannot be side-loaded                                                                        |
| S-DIR-L2W         | L   | W   | DIR  | non-loopback, browser receiver                                   | 12 MiB                                                          | W `direct`                                                                                                                                  |
| S-DIR-L2D         | L   | D   | DIR  | non-loopback, desktop receiver                                   | 12 MiB                                                          | D pill `Direct`                                                                                                                             |

## Head profile deltas

Same ids with `H-`. Infra is `floe-run start --client --relaxed` (server
`http://localhost:3001`, web `http://localhost:3000`, limiters relaxed, the
pacing ledger disabled). Binaries: CLI from `go build` with
`-X main.version=head-<sha7>`; desktop through `--desktop wailsdev` (the real
app served at `http://localhost:34115`, driven by Playwright, route from the
Wails events) or a `wails build` exe driven by UIA with `APPDATA` redirected.
REL cells are SKIP `local-stun-only` unless the local
`/api/turn-credentials` carries a `turn:` or `turns:` URL (the scheme probe
never prints the body; today the local server answers STUN only). Stats:
receivers opt out and the local `/api/stats` must read 0 before and after
every receive; any other value is a run-level FAIL `stats-delta`. The web row
records `local HEAD <sha>`.

## Per-phase timeouts

| Phase                         | DIR                         | REL                        | Why                                                                                                                          |
| ----------------------------- | --------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| link or code visible          | C 30 s, W 20 s, D 30 s      | same                       | the e2e waits 10 s for the `code` element and 60 s for the CLI link; the desktop needs launch time                           |
| peer connected                | 45 s (D 60 s)               | 60 s (D 75 s)              | CLI `signalWaitTimeout` 30 s + `connectTimeout` 30 s (`cli/engine/peer/connection.go:22-23`); a TURN allocation adds seconds |
| first bytes after connect     | 30 s                        | 30 s                       | the receiver's own idle timeout is 30 s (`receiver.go:31`); the product error arrives first and becomes the signature        |
| complete                      | `max(60 s, size / 10 MB/s)` | `max(90 s, size / 1 MB/s)` | measured 38 MB/s on the 500 MiB loopback cell, 1.5 to 2.6 MB/s relayed                                                       |
| process exit after completion | 15 s                        | 15 s                       | receiver 5 s grace (`receiver.go:565-568`) plus the summary                                                                  |
| route (after connect)         | 15 s                        | 15 s                       | a side with no oracle runs the budget out; both sides wait in parallel                                                       |
| verify, teardown              | 30 s, 20 s                  | same                       | hashing the outputs, then stopping both legs; outside the cell hard cap                                                      |
| cell hard cap                 | sum of the rows above       | sum of the rows above      |                                                                                                                              |

## Expected strings (quote exactly)

| Surface and role | Phase         | String or selector                                                                                                                                                                                                                        | Source                                                      |
| ---------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| C sender         | link          | stdout box rows `Code` and `Link`; regex `/https?:\/\/\S*#room=[^\s]+/`                                                                                                                                                                   | `cli/cmd/floe/main.go:249-257`; `client/e2e/helpers.ts:177` |
| C sender         | wait, connect | `  Waiting for peer...`, `  Connecting...`, `  Connected` (a CLI with `--relay-only` prints `  Connected (direct)` or `  Connected (relay)`)                                                                                              | `main.go:259,279,285`                                       |
| C sender         | done          | box rows `Sent` (`<n> files (<size>)`) and `Time`; exit 0                                                                                                                                                                                 | `cli/engine/transfer/sender.go:315-323`                     |
| C receiver       | connect       | `  Connecting to sender...`, `  Connected`, optional `  Peer version: <ver>`                                                                                                                                                              | `main.go:390,404`; `receiver.go:359`                        |
| C receiver       | done          | rows `Received`, `Time`, `Saved to <abs dir>`; optional `  Saved as <name>`; exit 0                                                                                                                                                       | `receiver.go:536,548-552`                                   |
| C any            | error         | stderr `Error: <msg>`, exit 1; Ctrl+C prints `  Canceled.` and exits 130                                                                                                                                                                  | cobra default; `main.go:506-518`                            |
| W sender         | link          | `code` element containing `#room=`; button `/create secure link/i`                                                                                                                                                                        | `client/e2e/helpers.ts:96-104`                              |
| W sender         | status        | `Waiting for peer`, `Peer joined. Starting transfer`, `All Files Sent!`                                                                                                                                                                   | `P2PTransfer.tsx:555,566,755`                               |
| W receiver       | joined        | `Secure room joined`, `Waiting for the sender to start`                                                                                                                                                                                   | `P2PTransfer.tsx:1009,1017`                                 |
| W receiver       | live          | `Receiving file N of M`; `a[download]` per file                                                                                                                                                                                           | `P2PTransfer.tsx:410`; `ReceivedFilesList.tsx:61-64`        |
| W receiver       | done          | `N file received` or `N files received`; `Download All` and `Download ZIP` when more than one file                                                                                                                                        | `P2PTransfer.tsx:1035-1060,1106-1113`                       |
| W pill           | route         | `Direct`, `Relay`, `Ready`, `Offline` (textContent; rendered uppercase by CSS)                                                                                                                                                            | `ConnectionStatusBadge.tsx:59-66`                           |
| W error          | banners       | `Link Invalid` heading; `Too many refreshes. Reconnecting`; `Connection failed. Enable "Network Relay" to connect across restrictive networks.`; `Transfer blocked. Relay limit exceeded.`; `Peer disconnected. Waiting for reconnection` | `P2PTransfer.tsx:205,217,623,636,810`                       |
| D sender         | staged        | button name `Send 1 item` or `Send N items`                                                                                                                                                                                               | `App.tsx:2569-2571`                                         |
| D sender         | live          | status `Waiting for the receiver...`, `Peer connected. Sending...`; pill `Active` then `Direct` or `Relay`                                                                                                                                | `App.tsx:1080`; `desktop/app.go:881`                        |
| D sender         | done          | `Sent 1 item` or `Sent N items`                                                                                                                                                                                                           | `App.tsx:2607`                                              |
| D receiver       | input         | `input[placeholder="amber-otter-cloud"]`; `input[placeholder="Downloads (default)"]` scoped to the receive view (the placeholder repeats in Settings); button `Receive`                                                                   | `App.tsx:2618-2651,2633,2100`                               |
| D receiver       | live          | `Connecting... keep this window open.`; `Incoming: <name> · <size>`                                                                                                                                                                       | `App.tsx:1726`; `incoming.ts:26-37`                         |
| D receiver       | done          | `Saved to <dir>`                                                                                                                                                                                                                          | `App.tsx:2662`                                              |
| D any            | error         | status starting `Error: ` (`friendlyError`), for example `Error: Connected, but the sender never started sending. Ask them to try again.`                                                                                                 | `desktop/frontend/src/errors.ts:15-54`                      |
| D                | close guard   | dialog heading id `floe-close-title`, buttons `Keep going` and `Close anyway`                                                                                                                                                             | `App.tsx:2898-2923`                                         |
| D                | about         | Settings row `Transfer protocol` with value `Version <n>` (`...` while pending)                                                                                                                                                           | `App.tsx:2311-2321`                                         |
| D any            | UIA names     | Name properties carry the rendered case: tabs `SEND`, `RECEIVE`; pill `READY`, `ACTIVE`, `DIRECT`, `RELAY`; the `Receive` button is the last IgnoreCase match (the `RECEIVE` tab is the first)                                            | probe record 2026-08-29                                     |
