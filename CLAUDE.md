# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Floe** is a browser-native, peer-to-peer file transfer app built on WebRTC. Three components work together:

- **`client/`** - Next.js 16 (React 19) web app
- **`server/`** - Node.js signaling server (Express + Socket.IO + WebSocket)
- **`cli/`** - Go CLI (`floe`) for headless transfers

File data never touches the server. WebRTC data channels carry it directly between peers. The server only brokers WebRTC signaling (offer/answer/ICE candidates) and optionally issues TURN relay credentials.

## Commands

### Client (Next.js)
```bash
cd client
pnpm install
pnpm dev         # dev server on :3000
pnpm build       # production build
pnpm lint        # ESLint
```

### Server (Node.js)
```bash
cd server
npm install
npm run dev      # nodemon auto-restart on :3001
npm start        # production
```

### CLI (Go)
```bash
cd cli
go build ./cmd/floe    # local binary
go test ./...          # run all tests
```

The CLI uses GoReleaser for cross-platform distribution; version is injected via `-ldflags "-X main.version=v..."`.

## Environment Setup

**Server** - copy `server/.env.example` to `server/.env`:
```
CLIENT_URL=http://localhost:3000
PORT=3001
TURN_SECRET=                 # optional Coturn HMAC secret
TURN_DOMAIN=                 # optional TURN server hostname
UPSTASH_REDIS_REST_URL=      # optional, durable global stats counter
UPSTASH_REDIS_REST_TOKEN=    # optional, pairs with the URL above
MAX_REPORT_BYTES=            # optional, per-report cap (default 5 TB)
```

**Client** - copy `client/.env.example` to `client/.env.local`:
```
NEXT_PUBLIC_SOCKET_URL=http://localhost:3001
NEXT_PUBLIC_SENTRY_DSN=    # optional
```

## Architecture

### Signaling Flow
1. A peer joins a room (`join-room` event) → server assigns role: **sender** (first) or **receiver** (second).
2. When both peers are present, server emits `user-connected` to the sender.
3. Peers exchange WebRTC `signal` messages (offer → answer → ICE candidates) via the server.
4. Once WebRTC connects, the data channel is used directly (server is out of the loop).

Browser peers communicate via **Socket.IO**; CLI peers communicate via **WebSocket at `/ws`**. Both share the same `rooms` registry on the server (`Map<roomId, [peer, peer]>`), so browser-to-CLI transfers work transparently.

### Transfer Protocol Versioning
The data-channel transfer protocol carries its own version, independent of the release version (1.x.y). Peers exchange `pv` (highest protocol version), `pvMin` (lowest supported), and `ver` (release string) inside the existing `metadata` and `ack` messages. Compatibility is a range-overlap check; if the ranges miss, the receiver sends an `incompatible` message before any file bytes move and both sides print a "run `floe update`" hint. Constants: `ProtocolVersion` / `MinProtocolVersion` in `cli/internal/transfer/protocol.go`, mirrored as `PROTOCOL_VERSION` / `MIN_PROTOCOL_VERSION` in `client/lib/transfer/protocol.ts`. Both are 1 today. Bump `ProtocolVersion` only on a breaking wire change; keep the two implementations in sync. Peers omitting the fields (pre-1.6.0) are treated as protocol 1.

### Room Codes
`POST /api/code` registers a short human-readable phrase (e.g. `olive-tiger-castle`) mapping to a room ID with 10-min TTL. `GET /api/code/:code` resolves it. Words come from `server/words.json`.

### TURN Credentials
`GET /api/turn-credentials` issues short-lived (24h) Coturn HMAC-SHA1 credentials. Called by both client and CLI before connecting. If `TURN_SECRET` is unset, only STUN is returned.

### Global Stats Counter
A public, all-time counter of total bytes transferred across every Floe user, shown on the homepage (`client/components/GlobalStats.tsx`) with a NumberFlow odometer animation. Because Floe is P2P and file bytes never reach the server, the **receiver** peer reports the byte count out-of-band over HTTP after a completed transfer. Only the receiver reports (browser receiver in `P2PTransfer.tsx`, CLI receiver in `cli/internal/transfer/receiver.go`), so each transfer is counted exactly once. The sender never reports. The data-channel protocol is unchanged, so no `ProtocolVersion` bump is needed.

The global total is viewable only in the browser (the `GlobalStats` component on the homepage). The CLI receiver contributes to the counter but never fetches or displays it.

- `GET /api/stats` returns `{ totalBytes }` straight from an in-memory `cachedTotal`, so homepage polling (every 10s) never touches Redis.
- `POST /api/stats/report` body `{ bytes }`: validates a positive integer `<= MAX_REPORT_BYTES` (`validateReportBytes`), rate-limits per IP (`statsRateLimits`, 60/min), increments `cachedTotal`, then fires `INCRBY floe:bytes_total` to Upstash without awaiting (a Redis hiccup never fails the response).
- Durability is Upstash Redis over its REST API via native `fetch` (no SDK). `initStats()` seeds `cachedTotal` from Redis on startup. If `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are unset, the counter degrades gracefully to in-memory only (resets to 0 on restart). This is a best-effort vanity metric with lightweight guardrails, not a tamper-proof figure.

**Opt-out:** Both the browser and the CLI receiver support opting out of reporting.
- Browser: a "Contribute to global stats" toggle on the receiver view (persisted in `localStorage['floe:report-stats']`). When unchecked, neither the `POST /api/stats/report` call nor the optimistic `floe:bytes-reported` event fires.
- CLI: pass `--no-report` to `floe receive`, or set `FLOE_NO_STATS=1` in the environment. Both gate the report by passing an empty `statsURL` to `ReceiveFiles`, which hits the existing `if serverURL == "" { return }` guard in `reportBytesToServer` (`receiver.go:36-39`). No change to `ReceiveFiles` signature or `receiver.go` logic.

### Rate Limiting
Three independent per-IP limiters, each over a 60s window, tracked in plain `Map`s and cleaned every 60s. Connection limiter: 30 per IP (configurable via `MAX_CONNECTIONS_PER_IP`), shared across Socket.IO and WebSocket connections (`checkRateLimit`). TURN endpoint: a separate 20 requests per IP for `GET /api/turn-credentials` (`turnRateLimits`). Stats endpoint: a separate 60 reports per IP for `POST /api/stats/report` (`statsRateLimits`).

### React Strict Mode is intentionally disabled
`next.config.mjs` sets `reactStrictMode: false`. Strict Mode's double-mount breaks Socket.IO connections and `simple-peer` instances. All socket/peer logic uses refs and cleanup functions to handle component lifecycle correctly.

### Key Client Modules
- `client/components/P2PTransfer.tsx` - entire transfer UI (role detection, file selection, progress, download)
- `client/hooks/useWakeLock.ts` - Screen Wake Lock API wrapper (prevents device sleep during transfers)
- `client/lib/transferUtils.ts` - `formatSpeed()` and `formatETA()` used by the progress display

### CLI Internal Packages
All under `cli/internal/`:
- `signaling/` - WebSocket client for the `/ws` endpoint
- `peer/` - WebRTC peer setup via Pion
- `transfer/sender.go` / `transfer/receiver.go` - binary protocol over the data channel
- `ice/` - fetches STUN/TURN credentials from server
- `code/` - registers and resolves short room codes

## Documentation Site and Automations

The docs live in `docs/` (Mintlify), git-synced to `main`, and deploy to docs.floe.one. The site runs on the Mintlify OSS sponsorship (10,250 credits/month). Overages are OFF and a usage alert fires at 80%, so the plan can never incur a charge.

Four "require review" automations are configured in the Mintlify dashboard. Each one opens a pull request against `main`, only edits `docs/**`, and never auto-merges:

| When | Automation | Job |
|---|---|---|
| Every Monday | Update from code changes | Keep docs accurate to merged PRs |
| Every Friday | Apply style guide | Enforce no em dashes and voice consistency |
| 1st of month | Fix broken links | Catch external link rot |
| 15th of month | Audit SEO metadata | Titles, descriptions, headings, canonical tags |

`docs/changelog.mdx` is written by hand. The automations are instructed (via their additional prompts) not to touch it.

Intentionally OFF: Draft changelog, Draft improvements from assistant conversations, Draft improvements from user feedback (enable later once the docs have real traffic), Translate content (English only), and Fix grammar & typos (the style-guide automation already covers it).

CI on docs-only changes is skipped via `paths-ignore: docs/**` in `.github/workflows/ci.yml`, so bot doc PRs do not run the client/server/CLI/e2e suite.

## Writing Style

Do not use em dashes (--) in any markdown files or documentation. Use periods, commas, hyphens, or parentheses instead. In `docs/`, this is enforced deterministically by Vale (`docs/.vale.ini` plus the `docs/styles/Floe/EmDash.yml` rule, surfaced as the Mintlify Grammar linter CI check) and reinforced by the weekly Apply style guide automation.

## Git Conventions

Do not credit Claude or any AI assistant as an author. Specifically:

- Omit the `Co-Authored-By: Claude ...` trailer from commit messages.
- Omit the `🤖 Generated with Claude Code` footer from pull request descriptions.

Commit messages and PR bodies stay attribution-free. PR Summary and Test plan sections are fine, just leave out any AI footer or co-author line.
