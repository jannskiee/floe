---
name: floe-run
description: "Use when starting the local Floe stack for a manual check: run the app, start the local signaling server, next dev, browser QA, screenshots, reproducing a transfer bug, a CLI-to-browser test, or testing a request link locally (the /r page, floe send --to, POLICY_FILE, request-1 in /health) or a local relay. Starts server/ with the public stats counter neutralized (test bytes written to Upstash are permanent), proves it before anything can receive, and prints the URLs and CLI flags to use, with request links on when asked. Not for the production server on the Azure VM, and not needed for pnpm test:e2e on its own (Playwright's webServer starts server/ and the client itself)."
---

# Run the local Floe stack

Not for the production server on the Azure VM, and not needed for
`pnpm test:e2e` alone (Playwright starts its own sentinel server).

## The danger

`server/server.js` loads `server/.env` from its cwd (the `dotenv` call at the
top of the file, override off), and in the main checkout that file holds live
Upstash read and write credentials for the public all-time counter
`floe:bytes_total`. The counter only ever takes `INCRBY`, so every byte a local
receiver reports is permanent on floe.one (65 MB got in on 2026-07-10; on
2026-08-16 a local server seeded 197 GB straight from production; memory
`project_homepage_redesign_2026` and `reference_transfer_audit_harness`).
Nothing in the server refuses production, so the guard is the environment you
start it with, and this script is how you start it. The guard covers the stats
counter only: TURN keys from `server/.env` still flow through, which is what a
relay test needs.

## Commands

Run `start` with `run_in_background` and read its READY block.

```text
node .claude/skills/floe-run/scripts/floe-run.mjs start                  server only
node .claude/skills/floe-run/scripts/floe-run.mjs start --client         plus next dev on :3000
node .claude/skills/floe-run/scripts/floe-run.mjs start --relaxed        raise three per-IP limiters, as the e2e config does
node .claude/skills/floe-run/scripts/floe-run.mjs start --request-links  the server lists request-1 (a temp policy file, POLICY_FILE)
node .claude/skills/floe-run/scripts/floe-run.mjs start --local-turn     relay through a local coturn (see Local relay)
node .claude/skills/floe-run/scripts/floe-run.mjs check                  what is bound on :3001 and :3000, and whether we own it
node .claude/skills/floe-run/scripts/floe-run.mjs stop                   kill what this script started
```

The start switches combine (`start --client --relaxed --request-links`).

`--relaxed` raises `MAX_CONNECTIONS_PER_IP`, `MAX_CODE_REQUESTS_PER_IP` and
`MAX_TURN_REQUESTS_PER_IP` to 1000 a minute, and nothing else. What it leaves
alone, all in `server/server.js`: 20 new request links per address in any 24
hours (`REQUEST_CREATES_PER_DAY`; the 21st Make link is refused as `limited`),
10 open links per address (`REQUEST_LIVE_PER_KEY`, refused as `busy`), 6
seatings a minute per link (`REQUEST_SEATINGS_PER_MINUTE`), 30 `request-join`
frames a minute per socket (`REQUEST_JOINS_PER_MINUTE`), and 10 failed code
lookups a minute (`MAX_FAILED_CODE_RESOLVES`). The four request-link numbers
are constants, not env vars, and every local run comes from a loopback
address, so a day of testing shares them. The counts are held in the server's
memory, so a `stop` and a `start` begin again from zero.

`--request-links` writes `{"requestLinks":true}` to `floe-run-policy.json`
beside the pidfile (the OS temp dir, never the repo tree) and starts the
server with `POLICY_FILE` pointing at it; `stop`, and any teardown, deletes
it. Never edit that file by hand. To flip the policy under one running
server instead, leave the switch off and set `POLICY_FILE` yourself to a file
you own, in the same PowerShell call as `start` (the tool keeps no
environment between calls; `start` spreads its environment into the
server): `$env:POLICY_FILE = 'C:/path/policy.json'`. Change that file the way
`server/.env.example` says, by writing a temp file and renaming it over the
old one, so the server never reads it half-written; the change is picked up
within 60 s, no restart.

The switch is not the only way on. `start` does not clear `POLICY_FILE`, and
dotenv fills it in from `server/.env` when the session has none, so a line
there (CONTRIBUTING.md tells contributors to add one) turns request links on
under a plain `start`. The `request links:` line of READY and `check` is the
truth either way: it is read from `/health`, not from the switch.

`check` exits 0 when `:3001` is owned by this script, healthy, and reading
`totalBytes=0`; 1 when `:3001` is bound but not owned, or owned but unhealthy;
2 when nothing is bound. On an idle machine 2 is the expected answer, not a
failure.

The server prints no banner at startup (`server.js` has a bare
`server.listen`). What it can print before READY, shown with the `[server]`
prefix: `TRUSTED_PROXY_COUNT is not set, so the default of 1 is in use. ...`
when neither the session nor `server/.env` sets that variable (a lane clone
with no `server/.env` prints it at every start); the policy's lines,
`request links: on` when a policy file turns them on, `policy file not found,
request links off` when `POLICY_FILE` names a file that is not there, or
`policy file unreadable, keeping previous policy`; `<NAME> is not a whole
number of at least 1. Using the default, <n>.` for a malformed `MAX_*` value;
and `Cloudflare TURN mint failed (<reason>)` when Cloudflare keys reach it and
the mint fails, because `start` asks `/api/turn-credentials` before READY. The
`start` wrapper stays alive for the stack's lifetime and exits 0 with
`floe-run: stopped` after `stop`.

When a port is busy, `start` refuses with exit 3 and `check` names the owner
hint (`netstat -ano | findstr :3001` here, `lsof` elsewhere). Wait for the
other run to finish, or ask. Never kill it.

`stop` refuses a pidfile from another checkout and any pid whose process image
no longer matches what this run spawned (exit 1), and it also frees a `:3000`
listener orphaned by a wrapper that died without teardown.

On a fresh worktree, and after a branch switch, before `--client`:
`cd client && corepack pnpm install --frozen-lockfile` (PowerShell:
`Push-Location client; corepack pnpm install --frozen-lockfile; Pop-Location`).
Run it from `client/`, not with `--dir` from the root: from the root, corepack
picks pnpm 11.7.0, which refuses client's 11.1.2 pin. Plain `pnpm` works the
same where it is on PATH; pnpm 11's dependency check fails on a stale tree.

The script spawns `pnpm dev` when pnpm is on PATH and `corepack pnpm dev`
otherwise. On the maintainer's Windows box pnpm is not on PATH, so the script
falls back to corepack there; on Node 25 or newer corepack is gone, so install
pnpm directly (memory `project_pnpm_via_corepack`).

`--client` makes next dev rewrite `client/next-env.d.ts` and generate
`client/AGENTS.md` and `client/CLAUDE.md`. The two generated files are
gitignored, so they cannot be committed by accident; delete them when you are
done. `client/next-env.d.ts` is tracked: run
`git checkout -- client/next-env.d.ts` after `stop`.

## What start proves

- `:3001` and `:3000` are free, or owned by this script (pidfile
  `floe-run.json` in the OS temp dir). Anything else: it refuses with exit 3
  and prints the `netstat` or `lsof` line that finds the owner. Never kill a
  process you did not start.
- The server got `UPSTASH_REDIS_REST_URL=http://127.0.0.1:9` and a non-empty
  token, so dotenv cannot refill them from `server/.env`; port 9 refuses
  instantly and `upstashPost` swallows the error, so startup never blocks.
- `GET /api/stats` read `{"totalBytes":0}` right after `/health`, and again two
  seconds later (`initStats` is fire-and-forget). With real credentials it
  reads about 200 GB. Neither switch changes this proof or the sentinel.
- `features:` is the list `/health` answered with, and `request links:` is
  the same answer as one word: `on` when the list holds `request-1`, `off`
  when it does not. `--request-links` gives `on` on a server that has the
  policy switch; so does a `POLICY_FILE` the session or `server/.env` already
  named, and READY then says the switch was not what turned them on. With the
  switch set and no `request-1`, the `features:` line says so.
- `turn:` is `coturn` when `/api/turn-credentials` served a `turn:` or
  `turns:` URL and `stun-only` when it served STUN alone. It is decided from
  the URL schemes only: the body carries live credentials, and no username,
  credential or full body is ever printed (the transfer-audit P4 rule).
  Cloudflare keys in the environment or `server/.env` outrank coturn in
  `server/turn.js` and read the same, so a lane clone (no `server/.env`) is
  where `coturn` means the local one.

`check` prints the same `features:`, `request links:` and `turn:` lines, and
`check --json` carries them as `features` (a list, or `null` when `/health`
is unreadable), `requestLinks` (`true`, `false`, or `null`) and `turn`
(`"coturn"`, `"stun-only"`, or `null`).

A green `start` or `check` proves the environment and nothing else: zero is
necessary, not sufficient (only the pidfile says this script set the
environment), and it says nothing about whether a transfer works, which is
what the e2e suite and a hand test are for. The deep cross-surface
matrix (the built desktop app, a forced relay, production, the installed
binaries) is `.claude/skills/transfer-audit/SKILL.md`.

## Local relay

`--local-turn` points the server at a coturn running on this machine (the
maintainers run one in WSL). Set two variables in the same PowerShell call
as `start`, each assigned straight from the command that reads it, so
neither value is ever echoed: `FLOE_LOCAL_TURN_DOMAIN` (the address coturn
listens on) and `FLOE_LOCAL_TURN_SECRET` (its shared auth secret).

The switch hands the pair to the server as `TURN_DOMAIN` and `TURN_SECRET`
and to nothing else: no child sees the `FLOE_LOCAL_TURN_*` names, next dev
never sees either pair, and neither the pidfile, READY nor `check` carries a
value. Without both variables, `start --local-turn` exits 2 with usage before
it probes, writes or spawns anything. READY then reads `turn: coturn`; if it
reads `stun-only`, relay cells cannot run on this stack. Setting `TURN_DOMAIN`
and `TURN_SECRET` directly still works and reads the same in READY, but they
then pass through the environment spread to next dev as well; the switch
keeps the secret in the server's environment alone.

## Tell the user

- Web: http://localhost:3000 (next dev with
  `NEXT_PUBLIC_SOCKET_URL=http://127.0.0.1:3001`, which beats
  `client/.env.local`; `127.0.0.1` rather than `localhost` matters for the
  reconnect path, see the comment in `client/playwright.config.ts`).
- Server: http://localhost:3001 (`/health`, `/api/stats`,
  `/api/turn-credentials`).
- Request links: the READY `request links:` line. `on` means clients pointed
  at this server may offer them, and READY then prints the three lines below
  it; `off` means the server refuses them.
- Making a link (it needs a host, and the page a link opens is the local
  client, so start with `--client` to open it in a browser):
  Floe Desktop from `wails dev`, with Settings, Advanced, **Server address**
  set to exactly `http://localhost:3001`, then Receive, Request link, Make
  link. With **Share link address** left empty, that spelling is the one the
  app maps to `http://localhost:3000`; with `127.0.0.1` the link points at the
  server, which serves no `/r` page. Or, with no window, from `cli/`:
  `go run ./internal/e2ehost request -out <folder> -timeout 30m`. It prints
  one JSON event per line, the `link` event carries the link, and it accepts
  the drop without asking (a test host, never shipped).
- Sending to a link: open it in a browser, or
  `floe send <files> --to "<link>" --server http://localhost:3001`. The `floe`
  on PATH is the released CLI; to send with HEAD, build one into a scratch
  folder first (from `cli/`: `go build -o <scratch>/floe-head.exe ./cmd/floe`)
  and call that. `--server`
  (or `FLOE_SERVER`) is not optional here: for a link whose host is not
  floe.one, `floe send --to` ends with "Couldn't connect to their computer.
  Nothing was sent." before any network call unless a server is chosen.
- Relay: the READY `turn:` line. `stun-only` means relayed transfers cannot
  work here; `coturn` means they can.
- CLI: `floe send <file> --server http://localhost:3001 --web http://localhost:3000`
  and `floe receive <code> --server http://localhost:3001` (or `FLOE_SERVER`).
  A local receive still moves the local `cachedTotal`; that is a useful sign
  the report path ran, and nothing leaves the machine.
- Desktop: the server URL is in Settings, persisted in
  `%APPDATA%\floe\desktop.json`; `reportStats` defaults to true and has no env
  override (`desktop/config.go`). Pointed at this local server it is safe.
  Pointed at api.floe.one it is not: switch "Contribute to global stats" off
  first, or do not receive with it.

## The rule

Never point any receiver at api.floe.one during a test unless stats reporting
is opted out on that surface (browser toggle, stored as
`localStorage['floe:report-stats']`; CLI `--no-report` or `FLOE_NO_STATS=1`;
desktop Settings). Senders never report (CLAUDE.md, Global Stats Counter).

## e2e

`pnpm test:e2e` needs nothing from this skill, and cannot run beside it.
Playwright starts its own server with the same sentinel, the same three
raised limiters, and `POLICY_FILE` set to
`client/e2e/fixtures/request-policy-on.json` (`webServer[0].env` in
`client/playwright.config.ts`), and its own client.

Both `webServer` entries set `reuseExistingServer: false`, so a run stops
before any test when something already answers on `:3001` or `:3000`, this
skill's stack included: `stop` first, then run the suite. Playwright's error
suggests turning the option back on. Do not: an adopted server gets none of
that environment, and an unguarded one sends the suite's test bytes to
whatever counter its `server/.env` names.
