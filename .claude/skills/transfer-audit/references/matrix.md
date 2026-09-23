# Cell catalog

The cells `audit.mjs run` executes, with the forcer, the oracles and the
timeouts each one carries. Recorded from the code on 2026-08-29 and
re-anchored on 2026-09-12; a source is a file plus a symbol, never a line,
so re-check the symbol when a string moves. The driver's own
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
         hashbad | hashmal (head profile only, see Forced mismatches)
         req | reqhideip | reqblip | reqdecline | reqopen (see Request-link cells)
```

Examples: `S-DIR-W2C`, `S-REL-C2D`, `H-DIR-C2C-bnd8`, `S-DIR-L2W`, `H-DIR-C2C-hashbad`.

## Forced mismatches (hashbad, hashmal)

Every receiver checks a file's SHA-256 against the bytes it wrote and deletes a
file that does not match. These two variants prove it, by making a sender lie:

| Variant   | What the sender sends                        | How                                                                 | Expected |
| --------- | -------------------------------------------- | ------------------------------------------------------------------- | -------- |
| `hashbad` | the real digest with one hex digit changed   | web sender: `installHashbad` in `scripts/lib/web.mjs`; CLI-shaped sender: `floe-e2ehost send -corrupt-hash` | refusal with `hash-mismatch`, no file and no `.part` left |
| `hashmal` | the real digest upper-cased, which the wire format forbids | `floe-e2ehost send -malformed-hash`                    | the same refusal: a digest that cannot be read cannot vouch for the file |

The corrupt digest never exists in shipped code. It lives in the audit skill and
in `cli/internal/e2ehost`, which no release builds (`go list -deps ./cmd/floe`
never names it), and `cellPlan` exposes it to a runner as `cell.hashLie`, which
is `null` for every other cell.

The ids are `HASH_IDS` in `scripts/lib/matrix.mjs`. They are head profile only,
and they are deliberately outside `DEFAULT_IDS` and `DEEP_IDS`: a run reaches
them through `--cells`, and the runner needs a sender that can lie before they
can pass. `H-DIR-C2D-hashbad` also needs `--desktop wailsdev`.

How a run carries them out:

- The CLI-shaped sender (C in `H-DIR-C2C-*` and `H-DIR-C2W-hashbad`) is never the
  shipped CLI. `prepareHarnessBuild` in `scripts/audit.mjs` builds
  `cli/internal/e2ehost` from the checkout into the run's `--bin-dir` as
  `floe-e2ehost-<sha7>.exe` once per run, only when a planned cell needs it, and
  the sender phase picks the `harness` adapter (`scripts/lib/harness.mjs`). A
  failed build or preflight turns exactly those cells into SKIP `harness-build`;
  there is no fallback. A new exe path wants one discarded warm-up run (firewall).
- The harness prints a link and never a code, so these cells use link input.
- They are head cells only: a shipped run that names one SKIPs it as `head-only`,
  because it would drive production with a sender that lies.
- Route: the harness prints `{"event":"route","path":"direct"|"relay"}` from the
  engine's own `ConnectionType()` (the word only, never an address), so a cell is
  judged by two observers, source `harness-connection-type` beside the receiver's.
  The harness takes no `--no-relay`, so a C2C hash cell is never "direct by
  construction"; its CLI receiver still gets the flag.
- The relay cap's byte guard does not run on these cells: bytes moving before the
  refusal is the point.
- Verdict: the receiver refused (a CLI receiver's `RefusedError` sentence and exit
  1; a browser receiver's own fixed discard copy, awaited on the page rather than
  synthesized from the sender) and kept nothing at all, not even an empty `.part`;
  and when the sender is the harness, the refusal code it read back is
  `hash-mismatch`. A CLI receiver that only saw its sender leave ("connection
  closed before any file arrived") refused nothing and never counts. A browser
  sender may end on "All Files Sent!" or on the receiver's wire reason; the page
  usually reaches the first before the refusal lands. The FAIL keys are
  `hash-not-refused` and `hash-refusal-code`.

## Request-link cells (need request-1)

The Stage 1 cells of spec 09 2.7.2. The ids are `REQUEST_IDS` in
`scripts/lib/matrix.mjs`, and each row below has a `cellPlan` entry (and the
reverse; `matrix.test.mjs` parses this table). Like the hash cells they are
outside `DEFAULT_IDS` and `DEEP_IDS`: a run reaches them through `--cells`.
Every one SKIPs `server-no-request-1` until probe P10 (`GET <server>/health`)
finds `request-1` in the server's `features`; an absent, malformed or
unreachable answer counts as absent. The host is always the desktop (D), so
`--desktop none` drops them all, TA-17's W2W included, and every lane but
`--desktop wailsdev` SKIPs them `request-host-uia-pending` (the UIA verbs
are Phase F prep; a shipped run cannot take wailsdev, so every shipped
request cell SKIPs today). `scripts/lib/request.mjs` runs them: each attempt
makes its own link into its own folder, and a failed step is FAIL
`request-flow` or `request-manifest`, never retried.

The visitor (W) opens `<web>/r/<linkId>#<roomId>` in a fresh Chromium
context, picks the files through the hidden "Choose files" input, clicks
`Send N files` and reads the page's status card (`lib/visitor.mjs`). The
link comes from the host's `GetRequestLink` on the wailsdev lane
(`PlaywrightDriver.readRequestLink`, checked against the link block's
input) and goes to the visitor's `page.goto` only: `redactRequestLinks`
replaces the room with `<room>` in every message, note, log line and
evidence file, the report applies the same net to audit.md and run.json,
and the host's captures sit under the attempt's `private/host/` folder. The visitor seeds
`localStorage['floe:report-stats']` to `false` and aborts and counts every
`**/api/stats/report` request: attempts must be 0 in every cell. Accept and
Decline are clicked no earlier than 1.2 s after the prompt was first seen
(`REQUEST_ACCEPT_WAIT_MS`; the frontend guard is 1 s). Relay cells move
4 MiB. `reqblip` refuses any server that is not loopback, as a usage error
before anything is created, and cuts only through the driver's own proxy
(`scripts/lib/blip.mjs`, 127.0.0.1 only).

Not planned yet: TA-14 `H-DIR-W2D-reqcaddy` (a Caddy reload on a local
Docker Caddy; Phase F prep, on the untested list until it runs) and TA-16
`S-DIR-C2D-req` (the CLI visitor, deferred with B6). The id scheme takes one
variant token, so TA-12 is `reqhideip` (spec 09 writes `req-hideip`).

| Cell                   | TA        | Snd | Rcv | Path | Forcer         | Input        | Size        | Required oracles |
| ---------------------- | --------- | --- | --- | ---- | -------------- | ------------ | ----------- | ---------------- |
| S-DIR-W2D-req          | TA-10     | W   | D   | DIR  | none           | request-link | 64 MiB      | the prompt shows the visitor's own count and bytes and no relay-over-cap line; on-disk sha256 inside the exclusive drop subfolder, nothing loose beside it; visitor arrived line, its SHA line only when verified equals N; desktop `Received N files` and the SHA sentence; D pill `Direct` and W `direct`; desktop.json proof; visitor stats attempts 0; the link reads used up afterwards |
| S-REL-W2D-req          | TA-11     | W   | D   | REL  | W sender       | request-link | 4 MiB       | as TA-10 with W `local=relay` and D pill `Relay` |
| S-REL-W2D-reqhideip    | TA-12     | W   | D   | REL  | D hideIP       | request-link | 4 MiB       | as TA-11 with the relay forced by the host (D pill `Relay`, the visitor unforced); optional. The over 2 GB prompt line is not reachable from a web visitor, which blocks a relayed drop over the cap before its metadata (a spec gap) |
| H-DIR-W2D-reqblip      | TA-13     | W   | D   | DIR  | none           | request-link | 64 MiB      | the host's `/ws` cut 5 s through the blip proxy while the link waits: a visitor in the gap gets the not-connected copy; the desktop shows Reconnecting then Waiting; after the reclaim the visitor's Try again delivers and hashes match; head only, loopback only |
| H-DIR-W2D-reqdecline   | TA-15     | W   | D   | DIR  | none           | request-link | 1 MiB       | Decline: the visitor reads the declined copy; Keep waiting sends `request-reopen`; a second visitor context delivers and hashes match |
| S-DIR-W2W-reqopen      | TA-17     | W   | W   | DIR  | none           | link         | 12 MiB      | the S-DIR-W2W oracles with a link open on the desktop; the link still waits afterwards |
| S-DIR-C2W-reqopen      | TA-17     | C   | W   | DIR  | none           | link         | 12 MiB      | as S-DIR-C2W, link open |
| S-DIR-W2C-reqopen      | TA-17     | W   | C   | DIR  | none           | link         | 12 MiB      | as S-DIR-W2C, link open |
| S-REL-W2C-reqopen      | TA-17     | W   | C   | REL  | W sender       | link         | 4 MiB       | as S-REL-W2C, link open |
| S-DIR-D2C-reqopen      | TA-17     | D   | C   | DIR  | none           | code         | 64 MiB      | as S-DIR-D2C, link open (the Send lane beside an open link) |
| S-DIR-C2D-reqopen      | TA-17     | C   | D   | DIR  | none           | code         | 64 MiB      | as S-DIR-C2D, link open (code Receive and the early-race fix beside an open link) |
| H-DIR-W2D-req          | TA-10 (H) | W   | D   | DIR  | none           | request-link | 64 MiB      | as TA-10 on the local stack |
| H-REL-W2D-req          | TA-11 (H) | W   | D   | REL  | W sender       | request-link | 4 MiB       | as TA-11; SKIP `local-stun-only` without the local coturn (floe-run `--local-turn`) |
| H-DIR-W2W-reqopen      | TA-17 (H) | W   | W   | DIR  | none           | link         | 12 MiB      | as S-DIR-W2W-reqopen on the local stack |
| H-DIR-C2W-reqopen      | TA-17 (H) | C   | W   | DIR  | none           | link         | 12 MiB      | as S-DIR-C2W-reqopen |
| H-DIR-W2C-reqopen      | TA-17 (H) | W   | C   | DIR  | none           | link         | 12 MiB      | as S-DIR-W2C-reqopen |
| H-REL-W2C-reqopen      | TA-17 (H) | W   | C   | REL  | W sender       | link         | 4 MiB       | as S-REL-W2C-reqopen |
| H-DIR-D2C-reqopen      | TA-17 (H) | D   | C   | DIR  | none           | code         | 64 MiB      | as S-DIR-D2C-reqopen |
| H-DIR-C2D-reqopen      | TA-17 (H) | C   | D   | DIR  | none           | code         | 64 MiB      | as S-DIR-C2D-reqopen |

The host verbs on the wailsdev lane (`scripts/lib/desktop.mjs`
`PlaywrightDriver`), each by its frozen accessible name from
`work/16-design/cp-3/approved-copy-desktop.md`:

| Verb              | Clicks                                                  | Reads back                               |
| ----------------- | ------------------------------------------------------- | ---------------------------------------- |
| makeRequestLink   | `Receive`, `Request link, beta`, `Make another link` (from the ended view), the Save to field (the run's own folder, required), `In 7 days` (7d only), `Make link` | the field's value, `Copy link` shows (waiting) or the lane's error code, the link's folder in `GetRequestLink` |
| readRequestLink   | nothing                                                 | `GetRequestLink` link, matched to the link block's input |
| acceptRequest     | `Accept`, at least 1200 ms after the prompt was seen    | `Accept` gone (the prompt left)          |
| declineRequest    | `Decline`, at least 1200 ms after the prompt was seen   | `Keep waiting` shows (declined)          |
| keepWaiting       | `Keep waiting` (only from the declined view)            | `Copy link` shows again (waiting)        |
| closeRequestLink  | `Close link`                                            | `Make another link` shows (ended)        |
| readRequestResult | nothing                                                 | the done heading `RECEIVED N FILES, ...` and whether the SHA sentence shows |
| dismissRequestResult | `Dismiss`                                          | `Dismiss` gone (the lane back to Ready, the Beta switch unlocked) |
| cancelRequestDrop | `Cancel drop` (teardown of a drop still receiving)     | `Cancel drop` gone                       |
| setAddresses      | nothing (the app's own `SetSettings`, TA-13 only)       | `GetSettings` server and web             |

The runner also flips Settings > Beta > `Request links` on (and back off
at teardown when it turned it on), through the same label click as Hide my
IP, retried for 10 s while the app's own feature probe keeps the switch
disabled.

## What each surface can do

| Surface    | Relay forcer                                                                                                                           | Route oracle                                                                                                                                                                                                                                                                                                                                                                                                       | Completion                                                                    | Stats opt-out proof                                                                                                                                                                  | Source                                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| W sender   | init script wrapping `window.RTCPeerConnection` with `iceTransportPolicy:'relay'` (re-verified by probe P3 on every run that needs it) | `getStats()` nominated `candidate-pair` sampled while live; window event `floe-connection-status` (`direct`, `relay`, `connected`, `offline`); pill textContent `Direct`, `Relay`, `Ready`, `Offline`                                                                                                                                                                                                              | `All Files Sent!`                                                             | senders never report                                                                                                                                                                 | `client/components/P2PTransfer.tsx` (the `floe-connection-status` effect, and `onAllSent`); `client/components/ConnectionStatusBadge.tsx`; `client/hooks/useConnectionType.ts` `useConnectionType` |
| W receiver | same init script                                                                                                                       | same                                                                                                                                                                                                                                                                                                                                                                                                               | `N file received` or `N files received`; one `a[download]` blob href per file | `localStorage['floe:report-stats']` seeded to the literal string `false` before load; `ctx.route('**/api/stats/report', abort)` counting attempts; `floe:bytes-reported` never fires | `client/components/ReceiverPanel.tsx` (the completion line); `client/hooks/useTransferAnalytics.ts` `readInitialReportStats` and `reportBytes`; `client/e2e/docs-screenshots.mjs` `guardStats`      |
| C sender   | none (`--no-relay` is the opposite); `--relay-only` is detected at runtime when `floe send --help` lists it                            | prints nothing; positive-only oracle: the refusal `transfer blocked: relay connections are capped at 2 GB (selected ` on a payload over 2 GiB; optional `PION_LOG_TRACE=ice` stderr line `Set selected candidate pair:` containing the word `relay` (relay legs only, `--pion-trace`); a CLI that carries `--relay-only` (HEAD since #362) prints `  Connected (direct)` or `  Connected (relay)` on every connect | summary box row `Sent`, exit 0                                                | senders never report                                                                                                                                                                 | `cli/cmd/floe/main.go` (the `--no-relay` / `--relay-only` flags; the route line from `connectedLine`); `cli/cmd/floe/send.go` and `receive.go` (the two `peer.New` call sites); `cli/engine/transfer/relay.go` `ErrRelayOverLimit` and `checkRelayGate`               |
| C receiver | none                                                                                                                                   | as above                                                                                                                                                                                                                                                                                                                                                                                                           | summary rows `Received`, `Time`, `Saved to`, exit 0                           | argv `--no-report` and env `FLOE_NO_STATS=1` recorded (either suffices at `cli/cmd/floe/receive.go` `runReceive` (the `statsURL` gate))                                                                                         | `cli/engine/transfer/receiver.go` `ReceiveFilesWithOptions` (the summary rows); `cli/cmd/floe/receive.go` (the `--no-report` flag and the `statsURL` gate in `runReceive`)                                                                       |
| D sender   | `hideIP:true` in `desktop.json` before launch (read once at launch)                                                                    | pill text `Active` then `Direct` or `Relay` (the text, not the dot: while the route is unknown the dot is amber whenever hideIP is on); Wails event `send:route` on the wailsdev lane                                                                                                                                                                                                                              | `Sent 1 item` or `Sent N items`                                               | senders never report                                                                                                                                                                 | `desktop/frontend/src/App.tsx` (`relayTone`, the status badge, the send-done row); `desktop/transfer.go` `relayOpts` and the `send:route` emit in `runSend`                                                            |
| D receiver | `hideIP:true`                                                                                                                          | pill text; `recv:route` on the wailsdev lane                                                                                                                                                                                                                                                                                                                                                                       | `Saved to <dir>`                                                              | `desktop.json` holds `reportStats:false` and `migrated:true`, hashed before launch, restored byte-identical after                                                                    | `desktop/frontend/src/App.tsx` (the `GetSettings` effect and the receive-done row); `desktop/transfer.go` `receiveByCode` (the `recv:route` emit and the `statsURL` gate)                                                             |
| L sender   | none                                                                                                                                   | none (as C)                                                                                                                                                                                                                                                                                                                                                                                                        | as C                                                                          | n/a                                                                                                                                                                                  | the WSL2 harness in memory `project_release_1_10_3_and_0_2_6`                                                                                   |

Which side's evidence counts. Both classifiers OR over the pair
(`cli/engine/peer/connection.go` `ConnectionType`, `client/lib/relay.ts` `isRelayPair`), so one
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
browser has no code UI, `client/lib/roomLink.ts` `getRoomFromUrl` and `ROOM_ID_REGEX`). The
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
(`desktop/frontend/src/App.tsx` `receive`), every D-receiver cell is SKIP
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
| peer connected                | 45 s (D 60 s)               | 60 s (D 75 s)              | CLI `signalWaitTimeout` 30 s + `connectTimeout` 30 s (`cli/engine/peer/connection.go` `signalWaitTimeout` + `connectTimeout`); a TURN allocation adds seconds |
| first bytes after connect     | 30 s                        | 30 s                       | the receiver's own idle timeout is 30 s (`receiver.go` `receiveIdleTimeout`); the product error arrives first and becomes the signature        |
| complete                      | `max(60 s, size / 10 MB/s)` | `max(90 s, size / 1 MB/s)` | measured 38 MB/s on the 500 MiB loopback cell, 1.5 to 2.6 MB/s relayed                                                       |
| process exit after completion | 15 s                        | 15 s                       | receiver 5 s grace (`receiver.go` `ReceiveFilesWithOptions` (the teardown grace)) plus the summary                                                                  |
| route (after connect)         | 15 s                        | 15 s                       | a side with no oracle runs the budget out; both sides wait in parallel                                                       |
| verify, teardown              | 30 s, 20 s                  | same                       | hashing the outputs, then stopping both legs; outside the cell hard cap                                                      |
| cell hard cap                 | sum of the rows above       | sum of the rows above      |                                                                                                                              |

## Expected strings (quote exactly)

| Surface and role | Phase         | String or selector                                                                                                                                                                                                                        | Source                                                      |
| ---------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| C sender         | link          | stdout box rows `Code` and `Link`; regex `/https?:\/\/\S*#room=[^\s]+/`                                                                                                                                                                   | `cli/cmd/floe/send.go` `runSend` (the `PrintBox` rows); `client/e2e/helpers.ts` `spawnSend` |
| C sender         | wait, connect | `  Waiting for peer...`, `  Connecting...`, `  Connected` (a CLI with `--relay-only` prints `  Connected (direct)` or `  Connected (relay)`)                                                                                              | `cli/cmd/floe/send.go` `runSend`                                       |
| C sender         | done          | box rows `Sent` (`<n> files (<size>)`) and `Time`; exit 0                                                                                                                                                                                 | `cli/engine/transfer/sender.go` `SendFilesWithOptions` (the summary rows)                     |
| C receiver       | connect       | `  Connecting to sender...`, `  Connected`, optional `  Peer version: <ver>`                                                                                                                                                              | `cli/cmd/floe/receive.go` `runReceive`; `cli/engine/transfer/receiver.go` `ReceiveFilesWithOptions`                        |
| C receiver       | done          | rows `Received`, `Time`, `Saved to <abs dir>`; optional `  Saved as <name>`; exit 0                                                                                                                                                       | `cli/engine/transfer/receiver.go` `ReceiveFilesWithOptions` (the summary rows)                                   |
| C any            | error         | stderr `Error: <msg>`, exit 1; Ctrl+C prints `  Canceled.` and exits 130                                                                                                                                                                  | cobra default; `cli/cmd/floe/main.go` `main`                            |
| W sender         | link          | `code` element containing `#room=`; button `/create secure link/i`                                                                                                                                                                        | `client/e2e/helpers.ts` `browserSenderSetup`                              |
| W sender         | status        | `Waiting for peer`, `Peer joined. Starting transfer`, `All Files Sent!`                                                                                                                                                                   | `client/components/P2PTransfer.tsx` (the `setStatus` calls)                               |
| W receiver       | joined        | `Secure room joined`, `Waiting for the sender to start`                                                                                                                                                                                   | `client/components/ReceiverPanel.tsx` (the handshake checklist)                                 |
| W receiver       | live          | `Receiving file N of M`; `a[download]` per file                                                                                                                                                                                           | `client/components/P2PTransfer.tsx` `createReceiver` `onFileStart`; `client/components/ReceivedFilesList.tsx`        |
| W receiver       | done          | `N file received` or `N files received`; `Download All` and `Download ZIP` when more than one file                                                                                                                                        | `client/components/ReceiverPanel.tsx` (the completion line and the download buttons)                       |
| W pill           | route         | `Direct`, `Relay`, `Ready`, `Offline` (textContent; rendered uppercase by CSS)                                                                                                                                                            | `client/components/ConnectionStatusBadge.tsx`                           |
| W error          | banners       | `Link Invalid` heading; `Too many refreshes. Reconnecting`; `Connection failed. Enable "Network Relay" to connect across restrictive networks.`; `Transfer blocked. Relay limit exceeded.`; `Peer disconnected. Waiting for reconnection` | `client/components/P2PTransfer.tsx` (the `setError` calls and the error banner)                       |
| D sender         | staged        | button name `Send 1 item` or `Send N items`                                                                                                                                                                                               | `desktop/frontend/src/App.tsx` (the primary send button)                                         |
| D sender         | live          | status `Waiting for the receiver...`, `Peer connected. Sending...`; pill `Active` then `Direct` or `Relay`                                                                                                                                | `desktop/frontend/src/App.tsx` (the `send:status` handler); `desktop/transfer.go` `runSend`                        |
| D sender         | done          | `Sent 1 item` or `Sent N items`                                                                                                                                                                                                           | `desktop/frontend/src/App.tsx` (the send-done row)                                              |
| D receiver       | input         | `input[placeholder="amber-otter-cloud"]`; `input[placeholder="Downloads (default)"]` scoped to the receive view (the placeholder repeats in Settings); button `Receive`                                                                   | `desktop/frontend/src/App.tsx` (the receive view)                               |
| D receiver       | live          | `Connecting... keep this window open.`; `Incoming: <name> · <size>`                                                                                                                                                                       | `desktop/frontend/src/App.tsx` `receive`; `desktop/frontend/src/incoming.ts` `formatIncoming`                         |
| D receiver       | done          | `Saved to <dir>`                                                                                                                                                                                                                          | `desktop/frontend/src/App.tsx` (the receive-done row)                                              |
| D any            | error         | status starting `Error: ` (`friendlyError`), for example `Error: Connected, but the sender never started sending. Ask them to try again.`                                                                                                 | `desktop/frontend/src/errors.ts` `PASSTHROUGH` and `RULES`                      |
| D                | close guard   | dialog heading id `floe-close-title`, buttons `Keep going` and `Close anyway`                                                                                                                                                             | `desktop/frontend/src/App.tsx` (the close-guard dialog)                                         |
| D                | about         | Settings row `Transfer protocol` with value `Version <n>` (`...` while pending)                                                                                                                                                           | `desktop/frontend/src/App.tsx` (the About section)                                         |
| D any            | UIA names     | Name properties carry the rendered case: tabs `SEND`, `RECEIVE`; pill `READY`, `ACTIVE`, `DIRECT`, `RELAY`; the `Receive` button is the last IgnoreCase match (the `RECEIVE` tab is the first)                                            | probe record 2026-08-29                                     |
