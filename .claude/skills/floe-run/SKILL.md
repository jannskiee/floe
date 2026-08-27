---
name: floe-run
description: 'Use when starting the local Floe stack for a manual check: run the app, start the local signaling server, next dev, browser QA, screenshots, reproducing a transfer bug, or a CLI-to-browser test. Starts server/ with the public stats counter neutralized (test bytes written to Upstash are permanent), proves it before anything can receive, and prints the URLs and CLI flags to use.'
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
node .claude/skills/floe-run/scripts/floe-run.mjs start            server only
node .claude/skills/floe-run/scripts/floe-run.mjs start --client   plus next dev on :3000
node .claude/skills/floe-run/scripts/floe-run.mjs start --relaxed  lift the per-IP limiters, as the e2e config does
node .claude/skills/floe-run/scripts/floe-run.mjs check            what is bound on :3001 and :3000, and whether we own it
node .claude/skills/floe-run/scripts/floe-run.mjs stop             kill what this script started
```

`stop` refuses a pidfile from another checkout and any pid whose process image
no longer matches what this run spawned (exit 1), and it also frees a `:3000`
listener orphaned by a wrapper that died without teardown.

After a branch switch and before `--client`:
`corepack pnpm --dir client install --frozen-lockfile` (or plain `pnpm` where
it is on PATH; pnpm 11's dependency check fails on a stale tree). The script
spawns `pnpm dev` when pnpm is on PATH and `corepack pnpm dev` otherwise. On
the maintainer's Windows box pnpm is not on PATH; corepack is gone from Node
25+, so install pnpm directly there (memory `project_pnpm_via_corepack`).

`--client` makes next dev rewrite `client/next-env.d.ts` and generate
`client/AGENTS.md` and `client/CLAUDE.md`. Do not commit them: run
`git checkout -- client/next-env.d.ts` afterwards and delete the two generated
files.

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
  reads about 200 GB.

A green `start` or `check` proves the environment and nothing else: zero is
necessary, not sufficient (only the pidfile says this script set the
environment), and it says nothing about whether a transfer works, which is
what the e2e suite and a hand test are for.

## Tell the user

- Web: http://localhost:3000 (next dev with
  `NEXT_PUBLIC_SOCKET_URL=http://127.0.0.1:3001`, which beats
  `client/.env.local`; `127.0.0.1` rather than `localhost` matters for the
  reconnect path, see the comment in `client/playwright.config.ts`).
- Server: http://localhost:3001 (`/health`, `/api/stats`,
  `/api/turn-credentials`).
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

`client/playwright.config.ts` sets the same sentinel in `webServer[0].env`, but
`reuseExistingServer: true` makes Playwright adopt any `:3001` server it finds,
guarded or not. If you mix manual and e2e runs, start the manual stack with
this script and run `check` first.
