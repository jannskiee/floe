# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Floe** is an encrypted, peer-to-peer file transfer app built on WebRTC, with browser, desktop, and CLI surfaces. Four components work together:

- **`client/`** - Next.js 16 (React 19) web app
- **`server/`** - Node.js signaling server (Express + Socket.IO + WebSocket)
- **`cli/`** - Go CLI (`floe`) for headless transfers, plus the shared transfer engine in `cli/engine/`
- **`desktop/`** - Wails v2 desktop app (Go backend + React frontend), built on the same `cli/engine/`

File data never touches the server. WebRTC data channels carry it directly between peers. The server only brokers WebRTC signaling (offer/answer/ICE candidates) and optionally issues TURN relay credentials.

The Go side is a two-module workspace: the root `go.work` joins `cli/` and `desktop/` so the desktop app builds against the engine without publishing it. The workspace is active for every build, goreleaser's included, so a `desktop/go.mod` bump can change the dependency graph of the released `floe` binary. The `replace` directive in `desktop/go.mod` would make `GOWORK=off` work, but no Floe build sets it; the only `GOWORK=off` in the repo is the `go install` of the external Wails CLI.

## Commands

### Client (Next.js)
```bash
cd client
pnpm install
pnpm dev         # dev server on :3000
pnpm build       # production build
pnpm lint        # ESLint
pnpm test        # vitest unit suite
pnpm test:e2e    # Playwright e2e (needs Go on PATH; starts server/ and the client itself; see below)
```

`pnpm test:e2e` needs more than Node. Its global setup (`client/e2e/global-setup.ts`) runs `go build` for the CLI and for the test-only host harness `cli/internal/e2ehost`, so the Go toolchain must be on PATH for every spec, the browser-only ones included. The same setup then asks the client for every image its pages name, one at a time (`client/e2e/warm-images.ts`): on Next 16.3.8 an image request that a closing test page abandoned while the optimizer was still resizing that image left the image unanswerable for minutes, and only an image not yet in the optimizer's cache was affected. Next 16.4.0 fixed that upstream (vercel/next.js#98168; the before-and-after measurement is in that file), and the warm-up stays as a cheap guard, so no test is the first to ask.

Playwright starts `node server.js` from `server/` (install its dependencies first) and the client (`next dev` locally, `next start` on CI, where the workflow has already run `pnpm build`; both through Next's own entry point, so no package manager has to be on PATH) before that global setup runs, because its `webServer` entries set up first; that order is what lets the setup ask the client for images. Chromium has to be installed once with `pnpm exec playwright install chromium`.

It adopts neither: both `webServer` entries set `reuseExistingServer: false`, so a run stops before any test when something already answers on :3001 or :3000. Keep it that way, and stop whatever holds the port instead of following the hint in Playwright's error to turn the option on. Only the signaling server Playwright starts gets `POLICY_FILE=e2e/fixtures/request-policy-on.json` (request links on), the raised per-IP limits and the sentinel Upstash pair. An adopted server would have none of the three, so the request-link specs would fail against it, and if its `server/.env` held live Upstash credentials the suite's receives would be added to the public counter, which only ever takes `INCRBY`. An adopted client would keep whatever `NEXT_PUBLIC_SOCKET_URL` it was started with, and one pointed at `https://api.floe.one` would run the browser side of the suite through the live server. A build has that address compiled in and `next start` serves whatever build is on disk, so with `CI` set the global setup first refuses a `client/.next` that does not carry the suite's own address (`E2E_SOCKET_URL` in `client/e2e/socket-url.ts`, which `client/lib/e2eSocketUrl.test.ts` pins).

### Server (Node.js)
```bash
cd server
npm install
npm run dev      # nodemon auto-restart on :3001
npm start        # production
npm test         # node --test (discovers every server/*.test.js)
```

### CLI (Go)
```bash
cd cli
go build ./cmd/floe    # local binary
go test ./...          # run all tests
```

The CLI uses GoReleaser for cross-platform distribution; version is injected via `-ldflags "-X main.version={{ .Version }}"`, which carries NO leading `v` (a v1.11.5 tag produces a binary that prints `floe 1.11.5`). The desktop app differs: desktop-release.yml injects the tag verbatim (`desktop-v1.0.2`).

### Desktop (Wails)
```bash
cd desktop/frontend
npm install
npm run build          # REQUIRED before any Go command in desktop/ (see below)
npm test               # vitest

cd ../                 # desktop/
go test ./...
wails dev              # live-reload development
wails build            # production build -> build/bin/
```

`desktop/main.go` embeds `frontend/dist` (`//go:embed all:frontend/dist`), and that directory is gitignored, so on a fresh clone every Go command in `desktop/` fails with "no matching files found" until the frontend has been built once. Build the frontend first, always. Note that `wails build` can exit 0 on a silent failure; verify the executable timestamp changed.

## Environment Setup

**Server** - copy `server/.env.example` to `server/.env`. The block says what each variable is for; the example file holds the working values (it sets `NODE_ENV=production`, `TRUSTED_PROXY_COUNT=0` for a direct run, and the six per-IP and code `MAX_*` limits to their defaults):
```
CLIENT_URL=http://localhost:3000   # one extra allowed origin, exact match once one trailing slash is dropped: HTTP CORS and the WebSocket origin check (/ws and Socket.IO)
PORT=3001
CLOUDFLARE_TURN_KEY_ID=      # optional, managed Cloudflare Realtime TURN (takes precedence)
CLOUDFLARE_TURN_KEY_API_TOKEN= # optional, pairs with the key ID above
TURN_SECRET=                 # optional coturn HMAC secret (used when Cloudflare vars unset)
TURN_DOMAIN=                 # optional coturn hostname
TURN_TLS=                    # optional; off (or false, 0, no) leaves the turns: URL out of the coturn list
UPSTASH_REDIS_REST_URL=      # optional, durable global stats counter
UPSTASH_REDIS_REST_TOKEN=    # optional, pairs with the URL above
MAX_REPORT_BYTES=            # optional, per-report cap (default 5 TiB)
NODE_ENV=                    # optional; Floe never reads it (errorHandler answers the same generic JSON at every setting)
TRUSTED_PROXY_COUNT=         # optional, proxy hops for client-IP parsing (default 1; affects every per-IP limiter)
MAX_CONNECTIONS_PER_IP=      # optional, plus MAX_SOCKETS_PER_IP, MAX_CODE_REQUESTS_PER_IP,
MAX_SOCKETS_PER_IP=          #   MAX_TURN_REQUESTS_PER_IP, MAX_FAILED_CODE_RESOLVES,
MAX_FAILED_CODE_RESOLVES=    #   MAX_ACTIVE_CODES: see server/.env.example for the full
MAX_ACTIVE_CODES=            #   annotated list
POLICY_FILE=                 # optional, request-link policy file path (unset = request links off; re-read every 60s)
```

**Client** - copy `client/.env.example` to `client/.env.local`. As above, the example file holds the working values: it sets `NEXT_PUBLIC_SITE_URL=http://localhost:3000` (unset, a build outside the Docker image uses `https://www.floe.one`) and `NEXT_TELEMETRY_DISABLED=1`:
```
NEXT_PUBLIC_SOCKET_URL=http://localhost:3001  # build-time override; self-hosted Docker resolves at runtime via client/lib/socketUrl.ts
NEXT_PUBLIC_SITE_URL=         # optional, canonical/OG/sitemap base for self-hosts
NEXT_PUBLIC_SENTRY_DSN=       # optional (SENTRY_DSN for the Next.js server and edge runtimes; SENTRY_ORG / SENTRY_PROJECT only at build, for the Sentry plugin in next.config.mjs)
NEXT_PUBLIC_UMAMI_WEBSITE_ID= # optional analytics
REQUEST_REPORT_EMAIL=          # optional, read per request (not at build time): where "Report this link" on /r writes on a server that is not floe.one; unset = no link
```

## Architecture

### Signaling Flow
1. A peer joins a room (`join-room` event) → server assigns role: **sender** (first) or **receiver** (second).
2. When both peers are present, server emits `user-connected` to the sender.
3. Peers exchange WebRTC `signal` messages (offer → answer → ICE candidates) via the server.
4. Once WebRTC connects, the data channel is used directly (server is out of the loop).

A disconnect removes only that peer from the room (the room is deleted once empty), and browser peers re-send `join-room` automatically after a Socket.IO reconnect until the WebRTC connection is up. When a sender page's re-join is answered `room-full` (its old socket can hold the seat for up to about 45 s), the page retries on the ladder in `client/lib/rejoinRetry.ts` (2, 4, 8, 15, 15 and 15 s, about 59 s in all) showing "Reconnecting to your link", then stops on "Link stopped working"; no retry runs once the peer is connected or the transfer is complete.

An ordinary room also seals by network (the room seal): once peers under two different rate keys have each routed a signal through it, a `join-room` from a third key is answered `room-full` for as long as the room exists. The server keeps only `sealDigest` digests of the keys (`roomMeta.keys`), counts a key in `handleSignal` and checks it in `handleJoinRoom`. Peers that share a key (one NAT, one IPv6 /64) never reach two, so it fails open for them.

Request rooms (Request link) are the one exception to join order. Floe Desktop joins `/ws` with `join-room {roomId, hostToken}` and gets role `host`; the room id must be the derivation of the token (`server/hosttoken.js`), the server keeps only `SHA-256(hostToken)`, and seat 0 belongs to whoever presents the token, the newest valid socket winning. The reservation outlives an empty room (the host can reclaim it within 10 minutes; a new host socket replacing a ghost unseats an unsealed visitor with `host-absent`), a plain `join-room` into it answers `room-full`, and `POST /api/code` refuses its id. The room seals, so a later `request-join` answers `room-full`, once both seats have routed a signal or on the host's `request-seal`; the room seal's key history is not kept for it. Any `room-joined` role other than `host` means an old server that ignored the token (`ErrOldServer` in `cli/engine/signaling/client.go`).

The visitor's only way in is `request-join` (Socket.IO from the `/r` page, `/ws` from `floe send --to`), which never creates a room and never takes seat 0. `handleRequestJoin` answers in a fixed order, and the order is the contract: a frame past the per-socket budget is dropped with no reply; a malformed id gets `error {message:'Invalid room ID'}`; while request links are off, every join gets `disabled`; an id with no reservation gets `host-absent` (an unknown id and an ordinary room's id answer alike, so there is no existence oracle), or `link-ended` when that link ended within the last 24 hours; a peer already seated in that room gets no reply and no second `user-connected` (an idempotent re-join); a sealed or used link gets `room-full`; a host away in its grace gets `host-absent`, or `link-ended` once the link has passed the end its host named; a taken seat or a link past its seating budget gets `room-full`; and only then the seat, `request-joined {role:'visitor'}` to the visitor and `user-connected` to the host. A host join is answered `room-joined {role:'host'}`, `refused {code}` (`disabled`, `limited` or `busy`), `room-full` (a used link, or a token whose digest does not match the reservation) or `error` (`Invalid room ID`, `Invalid host token`). `handleHostJoin` checks the token's shape and derivation before the policy, so a foreign token never learns whether request links are on. The host join may carry `endsIn`, the link's remaining life in milliseconds; it is what lets a link whose host is asleep or offline at its end answer `link-ended` instead of `host-absent`.

Three host-only control frames ride `/ws` (`handleRequestControl`; Socket.IO has no listener for them, and a frame from anyone but the seated host is ignored with no reply): `request-seal`, `request-reopen` (evicts a seated visitor with `room-full` and unseals the room; while request links are off it ends the link instead, as the switch ends an unsealed one, so the host hears `refused {code:'disabled'}`) and `request-close`. Closing a sealed room swaps the reservation for a used marker, so for 24 hours a `request-join` answers `room-full` and a host join is refused with `room-full`; closing an unsealed room forgets the reservation and the id answers `link-ended` for 24 hours. Every other end (the 10 minute grace after the host socket closes, the age ceiling of 7 days plus 10 minutes, a lazy expiry at the next host join, the kill switch) forgets the reservation and never leaves a used marker. The comment block above `REQUEST_GRACE_FULL_MS` in `server/server.js` is the full statement of these rules; read it before changing any of them.

Browser peers communicate via **Socket.IO**; CLI and desktop peers communicate via **WebSocket at `/ws`**. Both share the same `rooms` registry on the server (`Map<roomId, [peer, peer]>`), so browser-to-CLI transfers work transparently. Both transports refuse a connection whose `Origin` is not allowed (`isAllowedOrigin`): no `Origin` header at all passes, as does the allow-list (`CLIENT_URL`, the two floe.one origins, `http://localhost:3000`) and an Origin whose host name is the request's own `Host`, which is what the Go clients send (`originFromServer`). `/ws` answers a refused upgrade with 403, Socket.IO refuses in `allowRequest`, and each logs one line per path for the life of the process.

### Transfer Protocol Versioning
The data-channel transfer protocol carries its own version, independent of the release version (1.x.y). Peers exchange `pv` (highest protocol version), `pvMin` (lowest supported), and `ver` (release string) inside the existing `metadata` and `ack` messages (`ver` is optional: the Go peers send it, the browser builds both messages without it today). Compatibility is a range-overlap check; if the ranges miss, the receiver sends an `incompatible` message before any file bytes move and each side prints a remedy for its own surface (the CLI says run `floe update`, the desktop points at the Store and floe.one/download via the `UpdateHint` option on Send/ReceiveOptions). Current peers on both implementations rebuild the message locally from the frame's `pv`/`pvMin`; the wire `Reason` is worded from the recipient's perspective, in words that name no surface, for peers that display it verbatim (`peerCompatErrorMessage` in both `protocol.go` and `protocol.ts`).

Constants: `ProtocolVersion` / `MinProtocolVersion` in `cli/engine/transfer/protocol.go`, mirrored as `PROTOCOL_VERSION` / `MIN_PROTOCOL_VERSION` in `client/lib/transfer/protocol.ts`. Both are 1 today. Bump `ProtocolVersion` only on a breaking wire change; keep the two implementations in sync. Peers omitting the fields (pre-1.6.0) are treated as protocol 1.

The `end` frame may carry `sha256`, `received` may carry `verified`, `ack` may carry `confirms`, and `incompatible` may carry `code` and `saved`; all are optional, so none of them bumps `ProtocolVersion`.

Every receiver sets `confirms: true` on its acks, a promise to answer the last file with `received` or a refusal: every Go receiver, and the browser receiver while `RECEIVER_CONFIRMS` in `client/lib/transfer/protocol.ts` (its rollback lever) is on. A Go sender whose first ack carries it (the literal `true` only: `parseAckConfirms`, twin `ackConfirmsOf`) ends the send only on that word or the close, never on a drained buffer; the browser sender ignores it. The browser receiver sends `received` (with `verified`, the batch's matched count, 0 included) once its own count of handed-over files reaches the batch's `total` and every part of the last file has read back, as the last step of the hand-over; a browser receiver of web app 1.11.1 or earlier sends neither, so a Go sender still ends at the drain against it.

Both senders fill `sha256` with the digest of the bytes they sent, and only when the receiver acked offset 0; both receivers check it and delete a file that does not match. The rollback levers are `SEND_FILE_HASHES` in `client/lib/transfer/protocol.ts` and `sendFileHashes` in `cli/engine/transfer/sender.go`: with either false that side stops hashing and its peer falls back to the byte-count check.

### Relay Size Limit
Relayed (TURN) transfers are capped at 2 GB per session; Floe sets no size limit on a direct transfer (a browser that receives is still limited by what that browser can hold). The cap is a sender-side, pre-transfer gate: once the connection is established the sender inspects the selected ICE candidate pair, and only a confirmed relay path with more than the limit queued blocks (strictly greater-than, so exactly 2 GB is allowed). Detection failures fail open so a probe hiccup never blocks a legitimate transfer. Constants: `RELAY_SIZE_LIMIT` in `client/lib/relay.ts` (browser) and `RelaySizeLimit` in `cli/engine/transfer/relay.go` (CLI and desktop); keep the two in sync. The gate is local policy on the sender, not part of the wire protocol, so changing it needs no `ProtocolVersion` bump; the receiver runs the same check only on a request-link drop where the host confirms a relay on its own side.

### Request links (server)
The request-link handlers are behind a kill switch: a JSON policy file named by `POLICY_FILE` (`server/policy.js`), read at startup and re-read on every tick of the 60s cleanup interval, so a flip needs no restart. Only `{"requestLinks": true}` turns them on; an unset path, a missing file or a server that never read a good file means off, and a file that cannot be read or parsed keeps the last good policy. `/health` always carries `features`: `["request-1"]` while on, `[]` while off. Turning it off ends every unsealed request room (`applyPolicyChange`: the seated host is sent `refused {code:'disabled'}`, a seated visitor `disabled`); a sealed one is left to finish on its data channel, and a later `request-reopen` of it ends it the same way (`endRequestRoomOff`). While off, a host join answers `refused {code:'disabled'}` and a `request-join` answers `disabled`; ordinary rooms, codes and TURN are untouched. The store logs fixed lines only (a change of the effective setting, an unreadable file, a configured file that is missing), never the path or the file's content.

### Room Codes
`POST /api/code` registers a short human-readable phrase (e.g. `olive-tiger-castle`) mapping to a room ID with a 10-min TTL. `GET /api/code/:code` resolves it (`resolveCodeHandler`). Words come from `server/words.json`. The TTL is the outside limit, not the lifetime: `codeToRoom` has a reverse index `roomToCode`, and `forgetCode(roomId)` retires a room's code at three points: when the second seat is taken in `handleJoinRoom` (burn at pairing); inside `destroyRoom(roomId)`, the single way an ordinary room stops existing, which has three call sites (`leaveCurrentRoom`, the leave-first step of every join; `handleDisconnect`; and `handleHostJoin` when a token holder takes its derived id back from an ordinary room); and in `registerCodeHandler` before a new phrase is stored, so a room never has two working phrases. Request-room paths call `rooms.delete` directly and never `destroyRoom`, on purpose: a request room cannot own a code, because `registerCodeHandler` refuses a reserved id and `handleHostJoin` calls `forgetCodesFor(id)` on a create, which retires every code registered for that id in any letter case. `dropCode(code, roomId)` is the delete that keeps both maps in step, and is what the 60s sweeper calls. Resolving is deliberately the one thing that does NOT retire a code: a receiver can fail after the lookup and before it takes its seat (a 429 on ICE credentials, an unwritable `-o`, `--relay-only` against a relay-less server, desktop Hide my IP), so every pre-join failure must be able to retry the same phrase. Never burn on the first GET.

### TURN Credentials
`GET /api/turn-credentials` returns the ICE server list (`server/turn.js`), and every surface fetches it before it connects: the main web page on load and again before a connection when no read has succeeded or the list is an hour old (`client/lib/iceList.ts`), the `/r` page once per attempt, the CLI and the desktop once per transfer, and the desktop request lane at every `user-connected`. Precedence: **Cloudflare Realtime TURN** when `CLOUDFLARE_TURN_KEY_ID` / `CLOUDFLARE_TURN_KEY_API_TOKEN` are set (what floe.one runs; credentials valid for 24 hours, minted from Cloudflare's `generate-ice-servers` API, cached in memory for 5 minutes, a mint timing out after 10 s, and while the API fails the last good copy served for up to about 23 hours, with STUN and TURN returned as separate entries so the client's relay-off filter can strip TURN while keeping STUN), then self-hosted **coturn** HMAC-SHA1 credentials (24h) when `TURN_SECRET` / `TURN_DOMAIN` are set (with `TURN_TLS=off` the `turns:` URL is left out, for a coturn with no TLS certificate), otherwise Google STUN only. Cloudflare's full 8-URL list is trimmed to a minimal 3-URL set (one STUN, one UDP TURN, one TLS TURN on 443) by `selectMinimalIceUrls` before serving; clients gather ICE candidates per URL per network interface, so redundant URLs multiply connection-setup time on multi-adapter machines.

### Global Stats Counter
A public, all-time counter of total bytes transferred across every Floe user, shown on the homepage (`client/components/GlobalStats.tsx`) with a NumberFlow odometer animation. Because Floe is P2P and file bytes never reach the server, the **receiver** peer reports the byte count out-of-band over HTTP after a completed transfer. Only the receiver reports (browser receiver via `client/hooks/useTransferAnalytics.ts`, composed by `P2PTransfer.tsx`; CLI and desktop receivers via `cli/engine/transfer/receiver.go`), so each transfer is counted exactly once. The sender never reports. The data-channel protocol is unchanged, so no `ProtocolVersion` bump is needed.

A request-link drop that stops after Accept reports the bytes of files already saved under their final names, once, through the same guard; `.part` bytes and hash-mismatched files never count.

The global total is viewable only in the browser (the `GlobalStats` component on the homepage). The CLI receiver contributes to the counter but never fetches or displays it.

- `GET /api/stats` returns `{ totalBytes }` straight from an in-memory `cachedTotal`, so homepage polling (every 10s) never touches Redis.
- `POST /api/stats/report` body `{ bytes }` (`statsReportHandler` in `server/stats.js`, where the counter lives): rate-limits per IP first (`statsRateLimits`, 60/min, so a report with an invalid byte count still spends one and a `429` is answered before `bytes` is checked; the global `express.json()` has already parsed the body, and a body it cannot parse is refused by `errorHandler` without reaching the limiter), then validates a positive integer `<= MAX_REPORT_BYTES` (`validateReportBytes`), increments `cachedTotal`, then hands the bytes to the next `INCRBY floe:bytes_total` to Upstash without awaiting it (a Redis hiccup never fails the response): one call is in flight at a time, each ends at 10 s, and the bytes reported meanwhile are carried into the next (`sendPendingBytes`).
- Durability is Upstash Redis over its REST API via native `fetch` (no SDK). `initStats()` seeds `cachedTotal` from Redis on startup, and each `INCRBY` reply (the counter's new total) raises it; the total only moves up, so a report that lands before the seed is never lost from it. If `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are unset, the counter degrades gracefully to in-memory only (resets to 0 on restart). This is a best-effort vanity metric with lightweight guardrails, not a tamper-proof figure.

**Opt-out:** All three receivers (browser, CLI, desktop) support opting out of reporting.
- Browser: a "Contribute to global stats" toggle on the receiver view (`client/components/StatsContributionToggle.tsx`, persisted in `localStorage['floe:report-stats']` by `client/hooks/useTransferAnalytics.ts`). When unchecked, neither the `POST /api/stats/report` call nor the optimistic `floe:bytes-reported` event fires.
- CLI: pass `--no-report` to `floe receive`, or set `FLOE_NO_STATS=1` in the environment. Both gate the report by passing an empty `statsURL` to `ReceiveFilesWithOptions` (the call in `cli/cmd/floe/receive.go`), which hits the empty-URL guard at the top of `reportBytesToServer` in `cli/engine/transfer/receiver.go`. The receiver itself carries no opt-out logic.
- Desktop: a "Contribute to global stats" switch in Settings (`desktop/frontend/src/App.tsx`), persisted as `reportStats` in `%APPDATA%\floe\desktop.json` by `desktop/config.go` (under `os.UserConfigDir()`, so the folder differs on macOS and Linux; the file, not localStorage, is the truth). When off, `desktop/transfer.go` passes an empty `statsURL` to `ReceiveFilesWithOptions`, the same guard the CLI uses. There is no environment override: `FLOE_NO_STATS` is CLI-only.

### Rate Limiting
Four independent per-IP limiters plus one per-key budget, each over a 60s window, tracked in plain `Map`s and cleaned every 60s, and one cap on the sockets a key holds open, which has no window. Every `MAX_*` value is read by `envLimit` (`server/envlimit.js`): anything that is not a whole number of at least 1 falls back to the default and logs one line that names the variable, never its value; docs-check reads each default out of those calls. Every one of them keys on `rateKey` (`server/ratekey.js`): a port that a proxy appended to the address is removed first (`203.0.113.5:4711`, `[2001:db8::1]:443`), then IPv6 keys by its /64, IPv4-mapped IPv6 is unwrapped to plain IPv4, and anything unparseable (including a zone id) is used unchanged.

- Connection limiter: 30 per IP (configurable via `MAX_CONNECTIONS_PER_IP`), shared across Socket.IO and WebSocket connections (`checkRateLimit`), counting admitted connections only (a refused attempt is not recorded, so a client that keeps retrying is not locked out past the window).
- Open-socket cap: 60 connections held open per key (configurable via `MAX_SOCKETS_PER_IP`), Socket.IO and WebSocket together (`openSocketsByKey`). It is checked read-only BEFORE `checkRateLimit`, in `io.use` and in the `/ws` connection handler, so a refusal at the cap spends nothing from the rate window, and it refuses with the rate limit's own words (`Rate limit exceeded`, 1008 on `/ws`), so every client shows what it shows for the rate limit. Socket.IO holds a place in `io.on('connection')` and gives it back on that socket's `disconnect`, never in `io.use`: Socket.IO drops a socket whose session closed before its deferred `next()` with no `disconnect`, so a place taken there would leak. `/ws` holds one after both checks and gives it back on `'close'` alone. A burst of namespace connects on one Engine.IO session passes the check together, so the connection handler disconnects whatever lands past the cap. An Engine.IO session that never connects to a namespace is not counted (Socket.IO's `connectTimeout` closes it after 45 s), and one whose client leaves the namespace is closed on that `disconnect` (reason `client namespace disconnect`), because the connect cleared `connectTimeout` and the session would otherwise stay open uncounted. An entry is deleted at zero, so the map needs no sweep.
- TURN endpoint: a separate 20 requests per IP (configurable via `MAX_TURN_REQUESTS_PER_IP`) for `GET /api/turn-credentials` (`turnRateLimits`).
- Stats endpoint: a separate 60 reports per IP for `POST /api/stats/report` (`statsRateLimits`).
- Code endpoint: a separate 60 requests per IP (configurable via `MAX_CODE_REQUESTS_PER_IP`), shared across `POST /api/code` and `GET /api/code/:code` (`codeRateLimits`), applied via the shared `makeRateLimiter` middleware factory.
- Failed-resolve budget: a separate 10 FAILED lookups per key per 60s (`codeFailures`, configurable via `MAX_FAILED_CODE_RESOLVES`) inside `resolveCodeHandler`, not a middleware. It is the guessing control the shared 60/min limiter is not. Three rules hold it together and each is load-bearing: the budget is spent BEFORE the lookup, so a 429 says nothing about the phrase asked for; only a miss is charged, so a receiver holding a working code never spends any of it; and the 404 body is unchanged (`cli/engine/code/client.go` branches on 404). It logs nothing at the threshold, because the key is a client address and logging without it is a flood lever.

As a second guard, `POST /api/code` returns 503 once `codeToRoom` holds `MAX_ACTIVE_CODES` (default 10000) live codes, bounding memory regardless of source IP.

Request rooms add five budgets outside that 60s pattern, every one a constant with no environment variable.

- (1) 20 successful host creates per rate key per rolling 24h (`REQUEST_CREATES_PER_DAY`, counted in `requestCreates`, keyed by `sealDigest` of the key, never the key, and holding at most `REQUEST_CREATE_KEYS_MAX` (10000) keys, least recently created dropped first, never a refusal; a reclaim is not a create, a re-create after the grace or a restart is). Past it a host join answers `refused {code:'limited'}`, the only code that names the joiner's own budget.
- (2) 10 live reservations per rate key (`REQUEST_LIVE_PER_KEY`, counted in `liveByKey`).
- (3) A global ceiling of `MAX_REQUEST_ROOMS` (5000) live reservations, counted in `requestRoomIds` without a walk. Past (2) or (3) a host join answers `refused {code:'busy'}`. None of the three touches ordinary rooms or codes.
- (4) 30 `request-join` frames per socket per 60s window (`requestJoinAllowed`, state on the peer object), past which a frame is dropped silently.
- (5) 6 seatings per reservation in any rolling 60s (`seatingAllowed`, the times of the last six on the reservation's own record, reset by nothing but time), past which a `request-join` that would seat answers `room-full` and changes nothing. That last one exists because Floe Desktop fetches TURN credentials at every `user-connected` from its own address, so a link holder seating and leaving at its own pace would otherwise spend the host network's 20-a-minute TURN budget.

What an ended link leaves behind is bounded by count too, and holds no `MAX_REQUEST_ROOMS` slot: at most `REQUEST_USED_MAX` (10000) used markers and `REQUEST_ENDED_MAX` (20000) ended marks, each kept 24 hours, the oldest dropped first. On the Go side `JoinRoomWithTokenUntil` names only `disabled` and `limited`; `busy` reaches a caller as `HostRefusedUnknown`, which `joinCode` in `desktop/requestlink.go` turns into the snapshot code `unknown`, the generic "Couldn't make a link".

### React Strict Mode is intentionally disabled
`next.config.mjs` sets `reactStrictMode: false`. Strict Mode's double-mount breaks Socket.IO connections and `simple-peer` instances. All socket/peer logic uses refs and cleanup functions to handle component lifecycle correctly.

### Key Client Modules
- `client/components/P2PTransfer.tsx` - transfer UI orchestrator; the extracted logic lives in `client/hooks/` (useSignaling, useFileManagement, useDownloadManager, useConnectionType, useTransferAnalytics, useRelayConfiguration, useWakeLock, and usePageGuards, shared with the request page) and in pure modules under `client/lib/` (`roomLink.ts`, `relay.ts`, `peerErrors.ts`, `receiverClose.ts`, `peerDisconnect.ts`, `senderStop.ts`, `senderSelfStop.ts`, `iceList.ts`, `pageGuards.ts`, `verifiedLine.ts`, `clipboard.ts`, `socketUrl.ts` (which signaling server the page talks to), `roomSeat.ts` (what a receiver page knows about its seat, and when it gives the seat back), `rejoinRetry.ts` (the sender's retries after a re-join answered `room-full`), `refusalBanner.ts` (the connection-refused banner and the Link Invalid card's state), `reloadGate.ts` (the page's own reloads never end a transfer unasked: one after a deploy is skipped while the page holds the tab, one for a new room link waits unless the browser can ask), `routeLog.ts` (the route each connection took, for the reports a transfer ends with), `zipWriter.ts` (Download ZIP: each file read a slice at a time into a stored entry, and refused up front at 4 GB or more than 65,534 files, which fflate cannot write without ZIP64) with `heldObjectUrl.ts` (the archive's object URL kept alive until the download has started), and `receiveSummary.ts` and `sendSummary.ts` (the end-of-transfer lines, from how the transfer ended), each with a `.test.ts` sibling); the presentational pieces are siblings in `client/components/` (ConnectionStatusBadge, RelayFallbackToggle, ShareLinkPanel, TransferProgressBar, SelectedFilesList, ReceiverPanel)
- `client/lib/transfer/` - browser side of the wire protocol (protocol.ts, sender.ts, receiver.ts) and of the per-file SHA-256: `fileHash.ts` (`hashBlob`, the one hashing interface the sender and the receiver call), `fileHash.worker.ts` (the Worker it starts, so a large file never blocks the page), `sha256Slices.ts` (the Worker's slab-by-slab hash-wasm logic, free of Worker and DOM types so vitest can run it) and `receiveFailure.ts` (classifies a throw inside the receiver, an out-of-memory one included, so the transfer stops with fixed words). `verify.ts` sits beside them but is retained and unwired, the same status as `engine/verify` below
- The request-link visitor is a second page with its own tree, parallel to `P2PTransfer`. It reuses the wire protocol (`lib/transfer/`), `lib/relay.ts`, `lib/socketUrl.ts`, the `useSignaling` socket, `useConnectionType` and `useWakeLock`, and deliberately not `useFileManagement` or any of the main page's UI. Its parts: the route `client/app/r/[linkId]/page.tsx` (static metadata and no props on purpose, so the link id never reaches a title or a preview), the orchestrator `client/components/RequestVisitor.tsx`, the views in `client/components/request/`, the selection and tab-guard hooks `useRequestFiles` and `useVisitorGuards`, and the pure modules in `client/lib/request/`. Start with `visitorState.ts` (the reducer: every state and transition), `visitorCopy.ts` (every string the page renders, frozen approved copy), `requestLink.ts` (parsing `/r/<linkId>#<roomId>`) and `constants.ts` (the page's limits and timers). The page never renders a peer-supplied string: a refusal reaches it as an allowlisted code, a clamped count and one boolean
- `client/lib/transferUtils.ts` - `formatSpeed()` and `formatETA()` used by the progress display
- `client/sentry.client.config.ts` - browser error reporting. Its noise filters live in `client/lib/`, one module per shape of noise, each with tests and a header explaining why the other levers cannot see its shape: `browserExtensions.ts` (extension URL schemes, via `denyUrls`, which runs before frames are rewritten to `app://`), `ignoredErrors.ts` (message wordings, via `ignoreErrors`), `injectedScripts.ts` (a throwing `<anonymous>` frame, via `beforeSend`), `nonBrowserRuntimes.ts` (deno_core `ext:` frames from headless scrapers, via `beforeSend`) and `webkitDomDesync.ts` (WebKit's NotFoundError from a native removeChild or insertBefore, the translator desync, via `beforeSend`). A fifth shape is kept rather than dropped: `staleBundle.ts` marks a chunk-load error after a deploy as one warning-level issue, inside `beforeSend`. Eight more modules govern what the reports carry and how many are sent: `scrubUrl.ts` (the room secret and the request-link id, from events, spans and breadcrumbs), `sentryDataCollection.ts` (what the SDK may collect on its own, stated in full, since SDK 11 has no `sendDefaultPii` and collects everything without the block), `failClosed.ts` (every send hook of the three configs fails closed: the SDK itself drops an event or a breadcrumb whose hook threw, but sends a span unmodified, share link and all, when `beforeSendSpan` throws), `noLocation.ts`, `deviceHints.ts`, `eventBudget.ts`, `sentryIntegrations.ts` and `traceSampling.ts`. The privacy page (`client/app/privacy/page.tsx`, Error monitoring) states what they let through, so a change to any of them moves with that page. Check a report's stack and breadcrumbs before treating it as a visitor's: FLOE-G, first read as a real crash, was the Obscura scraper.

### Shared Go Engine
All under `cli/engine/`, imported by both the CLI (`cli/cmd/floe`) and the desktop app (`desktop/`):
- `signaling/` - WebSocket client for the `/ws` endpoint (`client.go`: the ordinary join, plus the request-room calls `JoinRoomWithTokenUntil` and `RequestJoin`, which return a typed result and never server text, and the host's `RequestSeal`, `RequestReopen` and `RequestClose`); `hosttoken.go` makes a request link's three values (`NewHostToken`, `RoomIDFromToken`, `NewLinkID`). The derivation must match `server/hosttoken.js` byte for byte, and both sides are pinned to `signaling/testdata/derivation-vectors.json`
- `peer/` - WebRTC peer setup via Pion (`connection.go`: `SetupAsSender`, `SetupAsReceiver`, `Early()`, `Failed()`, `ConnectionType()`); `framequeue.go` bounds the early-message pump by bytes as well as count; `icefilter.go` keeps link-local addresses out of ICE gathering and implements `--iface`; `sdp.go` reads and filters SDP; `setuperror.go` is the typed setup failure (`SetupError` with a stage), so callers pick fixed copy by stage instead of matching text; `logging.go` escapes pion's log lines before they reach a terminal
- `transfer/` - the binary protocol over the data channel, one concern per file:
  - `sender.go` / `receiver.go` - the two loops (`SendFilesWithOptions`, `ReceiveFilesWithOptions`), with `protocol.go` (versions and the compat messages), `control.go` (classifying an inbound frame, parsing metadata, `AbortSend`) and `deadlines.go` (the ack and decision clocks: the 120 s default ack wait, `VisitorAckTimeout`, `VisitorAckGrace` and the derived `HostDecisionWindow`; `protocol.ts` mirrors the first three as `ACK_TIMEOUT_MS`, `REQUEST_ACK_TIMEOUT_MS` and `REQUEST_ACK_GRACE_MS`)
  - `refusal.go` - the twelve `RefusalCode`s a receiver can stop with, `AbortWithCode` and the `RefusedError` a caller reads back; mirrored by `REFUSAL_CODES` in `client/lib/transfer/protocol.ts`
  - `limits.go` - what a sender's metadata may ask of this machine. Layer 1 is always on for every Go receiver (a path at most 32 components deep and 235 UTF-16 units long, which is `maxPathUnits` 240 less the 5 units of the `.part` suffix the count includes, never rooted or on a drive, a size the volume can hold). Layer 2 is `ReceiveLimits`, which only the desktop request lane sets in a shipped build (`requestLimits` in `desktop/transfer.go`)
  - `decide.go` (the `Decide` hook's three answers), `lane.go` (`DiskFree`, `VolumeNamedStreams`, the 24 hour `DropTimeLimit`), `blockshell.go` (the request-link name hook: Explorer-parsed file types saved as `<name>.floe-blocked`), `dropcheck.go` (`PrecheckDrop` and `MaxDropFiles`, the request-link sender's own check before any network)
  - `relay.go` (the 2 GB gate, and `SelectedPath`, the one walk to the selected candidate pair, which `peer`'s `ConnectionType()` takes too), `sanitize.go` (`safeJoin`), `partial.go` (the `.part` registry and `AbandonPartials`), `collect.go`, `format.go` and `progress.go`, plus the per-OS pairs `diskfree_*`, `diskfull_*`, `motw_*`, `rename_*` and `winbuild_*` (Windows and "other")
- `ice/` - fetches STUN/TURN credentials from server, falling back to Google STUN on any failure (`FetchDetail` reports whether it did)
- `code/` - registers and resolves short room codes, and parses a request link (`ParseRequestLink`); `linkhost.go` holds the one rule for whether a pasted link was made on the server this run is pointed at (`LinkServerMismatch`, `CheckLinkServer`), which `floe send --to`, `floe receive` and Floe Desktop all use
- `serverurl/` - normalizes user-supplied server URLs (`Normalize`: whitespace, trailing slashes, the case of the scheme and host, a default port) and maps a server origin to the web app origin that share and request links point at (`Web`)
- `verify/` - short authentication string for out-of-band MITM verification; retained and tested but unwired, since the user-facing code left every surface (CLI, browser, desktop) and its last callers went with it. Nothing imports it today. PAKE is the intended replacement; see DESKTOP.md, Phase 3a

The CLI itself is `cli/cmd/floe/`: `main.go` (the root command, the shared flags with their environment twins, the network seams `fetchICE` and `connectSignaling`, vars a test replaces with its own fake, and error printing), `interrupt.go` (the Ctrl+C and SIGTERM handler, and where a command waits once the handler has its ending), `links.go` (telling a link typed where it does not belong, in a command's place, as a path or as a receive input, without printing it back), `send.go` and `receive.go` (the two plain flows), `sendto.go` (`floe send --to <request link>`: the CLI as a request-link visitor, with fixed lines of its own), `connfailed.go` (closes the connection when ICE gives up, which is what ends a wait for `received` that can never come), `pionlog.go` (which pion log scopes are silenced) and `update.go` (`floe version` and `floe update`).

`cli/internal/` holds `selfupdate/`, which stays private to the CLI on purpose (`floe update` has no meaning for the desktop app), `e2ehost/`, a test-only Go peer that `client/e2e/global-setup.ts` builds (modes `host`, `send` and `request`; `request` is the request-link host the Playwright specs drive), and `rlvisitor/`, a test-only hostile request-link visitor for the desktop QA cells that refuses any server that is not local or private; GoReleaser builds only `./cmd/floe`, so neither ships.

### Desktop Backend
`desktop/` is package `main`. Wails binds `*App`'s exported methods to the frontend (`frontend/wailsjs/go/main/App.d.ts` is generated from them), and one Go concern lives per file:
- `main.go` (the Wails options, the single-instance lock `one.floe.desktop`, the embedded frontend) and `app.go` (startup, shutdown, a second instance's launch, file arguments)
- `transfer.go` - driving a send, a code receive and a request drop end to end (`runSend`, `receiveByCode`, `runRequestDrop`); `transferstate.go` is the one-transfer-at-a-time state machine for Send and code Receive (generations, and whether a close request may proceed)
- `requestlink.go` - the Request link lane: its own slot, mutex and generation, so an open link never blocks Send or code Receive and neither of them can supersede or close it. `a.mu` and the lane's `l.mu` are never held together, and no network or disk I/O runs under `l.mu`. `requestauto.go` is the per-link Auto-accept decision, `requestconn.go` closes a connection when ICE fails (Send shares it), `savedir.go` resolves the folder typed into Save to, `dropfolder.go` names and makes a drop's own folder (and removes it when a stopped drop saved nothing in it), `requestquit.go` keeps the record of a drop Floe is closed during (`quit-drop.json` beside `desktop.json`, written at most once a second and retried when Windows refuses the write), which the next launch shows as stopped
- `endpoints.go` and `config.go` (which server and web app this build talks to, and `desktop.json`), `serverprobe.go` (Settings > Test, and `RequestLinkSupport`, the `request-1` probe), `updatecheck.go`, `contextmenu*.go`, `reveal.go`, `clipboard*.go`, `closequit.go`
- Windows-only behavior sits in `*_windows.go` files, each with an `*_other.go` twin for every other GOOS: `toast_windows.go` (the one file that imports go-toast; every OS toast goes out through its COM path), `attention_windows.go` (the taskbar flash), `power_windows.go`, `wake_windows.go`, `volume_windows.go`, `packaged_windows.go` (MSIX identity), `shellopen_windows.go` (Open on a received file, through ShellExecute, so a name holding `#` or `%` opens) and `fatal_windows.go`
- The frontend follows the same split in `desktop/frontend/src/`: `App.tsx` orchestrates, `components/RequestLinkView.tsx` is everything the owner sees of a request link, and pure modules with a `.test.ts` sibling carry the logic (`requestLink.ts`, `requestCopy.ts` for every Request link string, `errors.ts`, `history.ts`, `settings.ts`, `incoming.ts`, `paths.ts`, `progress.ts`, `update.ts`, `clear.ts`, `reset.ts`, `cardPin.ts`), beside `copied.ts` (`useCopied`, the clipboard write and Copied mark every copy button shares)

### Request Links, Surface by Surface
A request link lets one person send files to a Floe Desktop that is waiting for them. The host (Floe Desktop) is always the receiver and always a Go peer on `/ws`; the visitor (the `/r` page or `floe send --to`) is always the sender. The WebRTC roles run the other way from an ordinary room: the host makes the offer (`runRequestDrop` calls `SetupAsSender`) and the visitor answers (`SetupAsReceiver` in `sendto.go`).

| Surface | What it does | Where |
| --- | --- | --- |
| Server | reserves the room for a host token, seats the visitor, relays signals, enforces the budgets and the kill switch | `server/server.js` (`handleHostJoin`, `handleRequestJoin`, `handleRequestControl`, `applyPolicyChange`), `server/hosttoken.js`, `server/policy.js` |
| Engine | makes the token, room id and link id; the join calls; the receive limits, the accept decision and the refusal codes | `cli/engine/signaling/hosttoken.go` and `client.go`; `cli/engine/transfer/limits.go`, `decide.go`, `lane.go`, `blockshell.go`, `refusal.go`, `deadlines.go`, `dropcheck.go`; `ParseRequestLink` in `cli/engine/code/client.go` |
| Floe Desktop (host) | makes the link, holds seat 0, shows the Accept prompt (or Auto-accept), receives into a subfolder of its own per drop | `desktop/requestlink.go`, `desktop/transfer.go` (`runRequestDrop`, `requestDecide`, `requestLimits`, `endRequestDrop`), `requestauto.go`, `requestconn.go`, `savedir.go`, `serverprobe.go`; `desktop/frontend/src/requestLink.ts`, `requestCopy.ts`, `components/RequestLinkView.tsx` |
| Browser (visitor) | the page at `/r/<linkId>#<roomId>` | `client/app/r/[linkId]/page.tsx`, `client/components/RequestVisitor.tsx`, `client/components/request/`, `client/lib/request/`, `client/hooks/useRequestFiles.ts`, `useVisitorGuards.ts` |
| CLI (visitor) | `floe send <paths> --to <link>`; `floe receive` refuses a request link with a fixed line | `cli/cmd/floe/sendto.go`, `cli/cmd/floe/receive.go` |
| Tests | a Go host for Playwright, a hostile visitor, the browser specs | `cli/internal/e2ehost` (`request` mode), `cli/internal/rlvisitor`, `client/e2e/request-*.spec.ts` with `request-helpers.ts` |

Rules that cross those surfaces, each pinned by a test where one is named:
- The link is `<web>/r/<linkId>#<roomId>`. The link id is 11 base64url characters in the path, is not a secret and never reaches the signaling server. The room id is a UUID in the fragment and is the capability. It is derived from the host token (32 random bytes as 43 base64url characters), which stays in the desktop's memory and leaves it only inside the host's `join-room` frame.
- One clock pair, never a restated literal: the visitor waits `VisitorAckTimeout` plus `VisitorAckGrace` (10 min 15 s) for the first ack, and the host answers `expired` on the owner's behalf at `HostDecisionWindow` (9 min 45 s). `REQUEST_ACK_TIMEOUT_MS` and `REQUEST_ACK_GRACE_MS` mirror them (`TestDeadlineConstantsMatchTS`).
- 10,000 files per drop, stated once per surface: `MaxDropFiles` (engine), `requestMaxFiles` (`desktop/transfer.go`) and `MAX_REQUEST_FILES` (`client/lib/request/constants.ts`), held together by `TestMaxDropFilesMatchesTheOtherSurfaces`.
- Success is the host's `received` and nothing else: both visitors send with require-received on (`RequireReceived` in `sendto.go`, `requireReceived` in `RequestVisitor.tsx`), so a drained buffer or a close is never reported as delivered.
- Every sentence either side shows is fixed copy chosen by a code: `visitorCopy.ts`, `requestCopy.ts` and the line constants at the top of `sendto.go`. The other peer's prose is never rendered or printed: a refusal travels as one of the twelve `RefusalCode`s plus a clamped count. The one visitor-derived text Floe Desktop shows is the engine's display-safe file name while a drop is receiving.
- Only the host reports to the stats counter. A visitor is a sender and has no report path.
- "Report this link" on `/r` writes to the built-in address on the two floe.one origins and nowhere else. On any other origin it writes to the operator's `REQUEST_REPORT_EMAIL`, and with none set the page has no such link (`reportAddressFor` in `client/lib/request/report.ts`). The `/r` server component reads the variable per request, checks it (`configuredReportAddress`: one plain address or nothing) and passes it down as a prop. It is never fetched and never a `NEXT_PUBLIC_` name; `client/lib/request/visitorBoundaries.test.ts` and `client/e2e/request-privacy.spec.ts` pin each step.

## Documentation Site

The docs live in `docs/` (Mintlify), git-synced to `main`, and are served at `floe.one/docs` (Mintlify deployment `floe` at base path `/docs`, reverse-proxied through the Vercel app's `next.config.mjs` rewrite to `floe.mintlify.site`, on a Vercel build only (`client/lib/docsRoutes.mjs`; every other build, the self-hosted image included, redirects `/docs` to `https://www.floe.one/docs`); the old `docs.floe.one` 301-redirects there).

- `docs/changelog.mdx` is written by hand and is never auto-generated. Its shape is fixed by the authoring contract in the MDX comment at the top of the file: one timeline for both version lines, `label` is the git tag verbatim (and therefore the anchor, so never edit a shipped one), `description` is the release date, and `tags` come from the fixed set `Web`, `Desktop`, `CLI`, `Self-hosting`, primary surface first. Follow that contract when adding an entry. Changing the contract itself is a restructure and needs its own discussion.
- `docs/style.css` is auto-loaded by Mintlify on every docs page (no `docs.json` entry, that is how Mintlify works). Since the docs redesign (#269) it carries every docs override: the footer, card icons, the sidebar and contents-list states, tabs, the theme menu, the assistant, the changelog chips, and since #526 four rules that fix what Mintlify renders badly (the cell floor for four-column tables, inline code that stays whole in running text, the troubleshooting contents list, and neutral field names and code tabs in the light theme). Each rule's comment records what was measured and which hook it depends on. The changelog tag-separator rule near the top is still the only thing keeping the tags in an entry's left gutter legible (Mintlify renders them as bare space-separated text with no delimiter of its own), and its selector is undocumented by Mintlify, so if the tag row ever loses its separators that is the first thing to check.
- Docs-only PRs stay fast without dodging branch protection: the `changes` job in `.github/workflows/ci.yml` diffs the PR and, when every changed file is under `docs/`, the heavy jobs skip and the `CI green` check reports success in about three minutes, so docs and Mintlify PRs merge quickly without running the client/server/CLI/e2e suite. A skills-only PR (every non-docs file under `.claude/skills/`) skips the heavy jobs the same way. Two jobs have no path filter, run on every PR, docs-only and skills-only included, and are in the gate. `Repo guardrails` (the peer-data consumer map and the docs pre-flight, `docs-check.mjs`) is one, so a docs defect the script can decide blocks the merge. `Skill test suites` is the other (every `*.test.mjs` under `.claude/skills/`, on a Windows runner). It is what a docs-only PR waits those three minutes for, and it runs on every PR because some of its suites read product files: sentences of the web app that the transfer audit waits for, desktop and CLI source, docs pages.
- Three things Mintlify does to a page are invisible in the source, and each has shipped: a table whose delimiter row does not match its header renders as raw pipe text; a table of more than three columns is cut at 1280 wide (the comparison grid on `choosing-floe` is the one four-column table, kept fitting by a `style.css` rule); a straight quote that opens a table cell renders as a closing mark, so that quotation is typed with curly marks. `docs-check.mjs` fails on the first and the third. `render-audit.mjs` beside it measures all of them on a preview or on production; run it after a docs PR has a preview, and again after any fix made in response to it.

Automated doc-maintenance PRs (style, links, SEO) are managed in the Mintlify dashboard. They open PRs against `main`, only edit `docs/**`, and never auto-merge.

## CI

`CI green` is the single required status check on `main`. It is a gate job in `.github/workflows/ci.yml` whose `needs` lists every other job; any new CI job must be added to that list or its failures are invisible to branch protection. New or experimental jobs should start OUTSIDE the gate's needs (visible but non-blocking) and be promoted in once stable. `skills` (the Skill test suites) took that path: it soaked from 2026-09-05 and joined the gate on 2026-10-13, and no job is outside the gate today. Deterministic linters (for example actionlint) are the exception and may enter the gate's `needs` immediately: their failures are reproducible locally, and their whole purpose is to block broken workflow edits, which a soak period outside the gate would defeat.

ci.yml also has a `workflow_dispatch` trigger: a dispatched run behaves exactly like a push (full suite, no path skips). Use it to recover from a lost push event or to re-roll the suite when investigating flaky tests. The e2e and back-compat jobs upload a Playwright evidence artifact (HTML report, traces, and stamped CLI transcripts) on every non-cancelled run, so a test that fails once and passes on the CI retry still leaves its first attempt inspectable.

Seven checks behind the gate run something the Commands section does not list. Run them before a push that touches their area:

- `go vet ./...` in `cli/` and in `desktop/` (the `cli` and `desktop` jobs run it before the tests).
- `go run honnef.co/go/tools/cmd/staticcheck@v0.8.2 -checks U1000 ./...` in `cli/` and in `desktop/` (the dead-code step right after `go vet` in the same two jobs; U1000 only, and the desktop step runs on Windows, where a const only the Windows build reads counts as used).
- `git ls-files -z '*.go' | xargs -0 gofmt -l` from the repo root must print nothing (the `gofmt` job, Linux only: with `core.autocrlf=true` on Windows, `gofmt -l` lists every CRLF file).
- `node .claude/skills/untrusted-peer-data/scripts/check-consumers.mjs` (`Repo guardrails`): fails when a `.go`, `.ts` or `.tsx` file starts referencing a peer-supplied field without a row in the consumer map (`.claude/skills/untrusted-peer-data/references/consumer-map.md`), or when a row's file or anchor symbol is gone. Adding or moving code that reads a wire field means updating that map in the same change.
- `node .claude/skills/docs-verify/scripts/docs-check.mjs all` (`Repo guardrails`, the docs pre-flight step): fails on a docs link or anchor that goes nowhere, in `docs/` or in any code, workflow or Markdown file that links to the docs, on a table that will not render, on a heading with a tag MDX cannot close (the page then stops compiling on Mintlify while every other check stays green), on a documented server default that differs from the server's code (the `envLimit` and `process.env` reads in `server/server.js`, `server/turn.js` and `server/stats.js`), on an em or en dash in the Markdown it reads, on a break of the docs page standard, and on the message list (`.claude/skills/docs-verify/references/messages.json`) falling behind the product: a web, site or server row, or a CLI row typed in `client/public` (the install scripts), whose words left its file, a docs picture's recorded string that left its sources, a sentence added to `visitorCopy.ts` with no row, and `docs/messages.mdx` out of date, which renaming a heading or sidebarTitle a row links to also causes (run `messages-index.mjs --write`). A change to a server default, to a floe.one/docs URL in Go or TypeScript, or to a web-app, server or install-script message can therefore fail it; add or edit the row in the same PR. Other desktop and CLI rows are held to the release snapshot, `released-strings.json`: they move at release prep, and a row added between releases needs the snapshot written again at the same tags (the failing line names the command).
- `node scripts/check-titles.mjs` in `client/` after `pnpm build` (a step of `Build & Lint`).
- `node --test ".claude/skills/**/*.test.mjs"` from the repo root (`Skill test suites`, on Windows in CI; a quoted glob, never a directory). It runs on every PR, so run it before a push that touches `.claude/skills/`, and before one that rewords a product string or moves a symbol a skill test reads (`client/lib/senderStop.ts` and `client/lib/rejoinRetry.ts` are two such files).

## File Size and Structure

Split a file when it has stopped being one thing, not when it crosses a line
count. The useful test is whether a reader looking for X has to skip past Y to
find it. Prefer the shapes this repo already uses: pure logic in a small module
with a `.test.ts` sibling (`clear.ts`, `reset.ts`, `download.ts`, `relay.ts`),
presentational components in `components/` with the props they already declare,
one Go concern per file inside the same package.

Some things are one thing however long they are, and splitting them makes them
worse. `ReceiveFilesWithOptions` is a linear protocol state machine whose
auditability comes from being one continuous read: what has been claimed on
disk, and what must be undone, is visible in a single pass. `App.tsx`'s mount
effect is eleven event listeners plus the window file-drop handler, each with a
matching teardown, and a first-render closure contract. Its keyboard effects reference action refs declared below them, so
hoisting them into a hook is a temporal-dead-zone crash. The ws upgrade
handler's ordering is load-bearing twice over: the no-op socket error listener
has to precede anything that can throw, and the Socket.IO pass-through has to
precede anything that can refuse, or every browser silently drops to
long-polling. Two refusals follow the pass-through return today, the 404 for a
path that is neither `/ws` nor engine.io's and the Origin check (a 403), and
`server/server.test.js` pins that order from the source. Leave these alone.

Separate a move from a behavior change. Never put both in one commit: git
cannot merge "this hunk moved to a new file" with "this hunk changed in
place", and a bisect through a mixed commit tells you nothing. A pure move is
also the only kind of change that can be PROVED rather than argued, and the
proofs are cheap:

- Go: `diff <(cd <base>/cli && go doc -all -u ./pkg) <(cd cli && go doc -all -u ./pkg)`
  must be empty, or hold only whole `const` and `var` groups in another place.
  The `-u` includes unexported symbols, and `go doc` sorts by name within
  CONSTANTS, VARIABLES, FUNCTIONS and TYPES rather than by file, except a
  parenthesized `const` or `var` group of more than one spec, which it lists
  in the order it reads the files (`sortingName` in go/doc). A pure move that carries such a group to another
  file can therefore move it in the raw output: compare the two outputs
  sorted, which is empty for a pure move, then read the raw diff to see that
  each group moved whole. `go doc` cannot see `init()` ordering or cobra flag
  registration, so a `cmd/` split is proved instead by diffing every command's
  `--help` against a binary built from the base.
- Desktop Go: `frontend/wailsjs/go/main/App.d.ts` must be byte-identical.
  Wails reflects over `*App`'s package-scoped method set, so a file move
  cannot change it, and a change there means something else moved too.
- TypeScript: every added line in the surviving file must be an `import`, and
  each moved block must `diff` clean against the base. Do not claim a
  byte-identical bundle: Rollup renames module-scope bindings on a move, so
  the `dist` hash legitimately differs.

Three traps worth stating outright:

- In Go, a new file named `*_windows.go`, `*_linux.go`, `*_darwin.go` or any
  other GOOS/GOARCH suffix picks up an implicit build constraint and silently
  disappears from every other platform. Name split files by concern
  (`sanitize.go`, `reveal.go`, `install.go`), and run the `go doc` proof once
  per GOOS when the file has platform branches in it.
- In Go, a comment placed immediately above `package x` becomes the PACKAGE
  doc comment, and Go concatenates those across files. A per-file note goes
  below the package clause, or it silently rewrites the package's docs.
- In React, a view extracted from a large component must be a top-level module
  component. Defined inside its parent it is a new type on every render, so
  controlled inputs remount and the caret jumps to the end of the field.

Comments earn their place by recording a decision, a measurement, a platform
quirk or a prohibition. A comment that restates the line beneath it does not.

Many comments cite a design record by id: a spec section (`spec 04 5.6.4`), a
decision (`D-116`), a review finding (`W3 R1-01`, `CP-SE F1-2`, `E-15`), a
copy row (`TL-03`, `P9`), or a file such as `approved-copy-cli.txt` or
`work/14-test-evidence/...`. Those records are the owner's planning notes and
are kept outside this repository, so no id resolves to a file here. Read an
id as a label for the decision the comment itself explains: the comment and
the test beside it are the authority. The approved copy tables are outside
the repository too. The strings themselves live in
`desktop/frontend/src/requestCopy.ts`, `client/lib/request/visitorCopy.ts`
and the line constants of `cli/cmd/floe/sendto.go`, each pinned by literal
expectations in its own test file, and they are frozen: change one only with
the owner's approval. `desktop/frontend/src/approvedCopy.test.ts` also
byte-matches the desktop strings against the table when `FLOE_APPROVED_COPY`
names it, and skips when it is unset.

Tests follow the same rules, plus these conventions:

- A Go test that holds real timers for minutes is opt-in through
  `FLOE_LONG_TESTS`, read only in its `_test.go` file. CI and the local gates
  run `go test ./...` without `-short`, and a package's default timeout is 10
  minutes.
- Test files are named by the concern they exercise, and the Go and
  TypeScript halves mirror each other: `hash_test.go` is the receiver's side
  of the per-file digest and `senderhash_test.go` the sender's, and
  `receiverHash.test.ts` is the browser receiver's.
- A decoder that both implementations have is pinned twice. The parity table
  in `cli/engine/transfer/parity_test.go` and `client/lib/transfer/parity.test.ts`
  is the same list of literal frames with each side's decision, and each suite
  reads the other file and fails when the two copies drift. A change to how
  either side reads `end`, `received`, `ack`, `incompatible` or a metadata
  frame is a change to both files.
- The Go engine's decoders of peer-chosen bytes have fuzz targets: twelve
  `Fuzz*` functions in the `fuzz_test.go` of `cli/engine/code`,
  `cli/engine/signaling` and `cli/engine/transfer`. Their corpora are
  committed under each package's `testdata/fuzz/<FuzzName>/`, and a plain
  `go test ./...` replays every committed file as an ordinary test case, so a
  corpus entry that fails breaks CI. `go test -run '^$' -fuzz=FuzzParseMetadata ./engine/transfer`
  (from `cli/`, one target at a time) explores. A crasher the fuzzer found is
  kept as a corpus file beside the seeds
  (`FuzzParseReceived/crash-type-key-case` is one), which keeps its fix
  pinned. The `seed-*` files are generated from the `f.Add` seeds:
  `FLOE_WRITE_FUZZ_SEEDS=1 go test -run '^Fuzz' .` in the package rewrites
  them, and nothing else in those test files writes.
- The e2e suite has three opt-ins that no CI leg sets, and one that only CI
  sets: `FLOE_E2E_HEAVY=1` runs `request-heavy.spec.ts`,
  `FLOE_E2E_LOCAL_TURN=1` runs the one local-relay cell of
  `request-link.spec.ts` (it needs a local coturn), `E2E_EXPECT_UMAMI=1`
  adds the arm of `request-privacy.spec.ts` that needs a build carrying an
  Umami website id, and `FLOE_RELEASED_CLI` (the path of a released `floe`)
  is what un-skips `back-compat.spec.ts`, exported by the `back-compat` job.
- The server has two test-only environment knobs, `HEARTBEAT_MS` and
  `FLOE_TEST_REQUEST_GRACE_MS` (it can only shorten the 10 minute grace). No
  deployment file sets either; never document them as operator settings.

## Writing Style

Do not use em dashes in any markdown files or documentation. Use periods, commas, hyphens, or parentheses instead. In `docs/`, Vale checks this (`docs/.vale.ini` plus the `docs/styles/Floe/EmDash.yml` rule, surfaced as the Mintlify Grammar linter CI check), reinforced by the weekly Apply style guide automation.

What Vale actually covers is narrower than this rule: it matches the em dash and en dash characters only, in `docs/` only. An ASCII `--` used as a dash is a human-review matter, because a token for it fires on every CLI flag in the docs. Markdown outside `docs/` has no style linter either (root Prettier can format it), but its dashes are checked: the docs-verify skill's `docs-check.mjs`, which CI runs on every pull request in `Repo guardrails`, fails on either character in the root `*.md` files, the Markdown under `.github/` and `unraid/`, `desktop/README.md`, `desktop/build/README.md`, `.goreleaser.yml` and `docs/style.css`. Those two desktop files are named one by one, not found by a walk, so a new Markdown file under `desktop/` has to be added to that list in `docs-check.mjs` to be checked.

Floe writes American English, in the docs and in user-facing product strings alike. In `docs/`, Vale enforces it (`docs/styles/Floe/Spelling.yml`), with `docs/changelog.mdx` exempted because its shipped entries describe releases whose UI really did say "Cancelling". The word list is short on purpose: it covers the pairs that have actually come up here rather than English generally, so extend it when a new one appears. The rule must stay at `level: error`, because `MinAlertLevel = error` makes Vale skip a lower-level rule entirely rather than merely hiding its output. Outside `docs/` this is a convention rather than a check, and it covers text a user can see (window titles, status lines, error messages, CLI output), not code comments or identifiers. Wails runtime names such as `WindowMinimise` are upstream API and stay as they are.

## Git Conventions

Do not credit Claude or any AI assistant as an author. Specifically:

- Omit the `Co-Authored-By: Claude ...` trailer from commit messages.
- Omit the `🤖 Generated with Claude Code` footer from pull request descriptions.

Commit messages and PR bodies stay attribution-free. PR Summary and Test plan sections are fine, just leave out any AI footer or co-author line.
