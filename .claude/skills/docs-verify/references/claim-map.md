# Claim map

Keyed by the symbol that is the truth. For each sentence you touched, open the symbol and diff the sentence against it. "Script" means docs-check.mjs already compares it; everything else is read by hand.

## Relay cap

- `RelaySizeLimit` (cli/engine/transfer/relay.go) and `RELAY_SIZE_LIMIT` (client/lib/relay.ts): 2 GB, strictly greater-than, sender-side only.
- Docs: docs/how-it-works/2gb-limit.mdx (whole page; "Exactly 2 GB is allowed"), docs/troubleshooting.mdx ("Transfer blocked. Relay limit exceeded.", "relay connections are capped at 2 GB", "Every transfer is capped at 2 GB"), docs/self-hosting/turn-relay.mdx (end of "How credentials work"), docs/cli/send.mdx "Notes", docs/desktop/settings.mdx "Hide my IP address", CLAUDE.md "Relay Size Limit".

## Protocol version

- `ProtocolVersion` / `MinProtocolVersion` (cli/engine/transfer/protocol.go) and `PROTOCOL_VERSION` / `MIN_PROTOCOL_VERSION` (client/lib/transfer/protocol.ts): both 1.
- Docs: docs/reference/transfer-protocol.mdx "Protocol versioning" plus every `"pv": 1, "pvMin": 1` example on that page, docs/desktop/settings.mdx "Transfer protocol", docs/changelog.mdx intro ("no release so far has changed the transfer protocol"), CLAUDE.md "Transfer Protocol Versioning".

## Timeouts

- cli/engine/peer/connection.go: `signalWaitTimeout` 30 s, `connectTimeout` 30 s, `connectGrace` 10 s.
- cli/engine/transfer/sender.go: `ackDeadline` 120 s, `drainDeadline` 30 s (delivery confirmation), the 60 s `time.After` in the backpressure loop (buffer not draining).
- cli/engine/transfer/receiver.go: `receiveIdleTimeout` 30 s, `receiveStallTimeout` 60 s, the 5 s `time.After` teardown grace, the 5 s `http.Client` in `reportBytesToServer`.
- client/lib/transfer/protocol.ts: `ACK_TIMEOUT_MS` 120 s (the only one the browser shares).
- Docs: docs/reference/transfer-protocol.mdx "Timeouts" table (every row), docs/cli/flags.mdx "Timeouts", docs/troubleshooting.mdx CLI headings that quote the error strings.

## Rate limits and caps

- server/server.js: `MAX_CONNECTIONS_PER_IP` 30, `TURN_MAX_REQUESTS` 20, `CODE_MAX_REQUESTS` 60, `STATS_MAX_REPORTS` 60 (fixed, no env var), `MAX_ACTIVE_CODES` 10000, `MAX_REPORT_BYTES` 5 TB; windows `RATE_LIMIT_WINDOW`, `TURN_RATE_WINDOW`, `CODE_RATE_WINDOW`, `STATS_RATE_WINDOW` all 60000.
- Docs: docs/self-hosting/configuration.mdx table and "Two things about the limits" (script: server rows), CONTRIBUTING.md server table (script), docs/reference/http-api.mdx "Rate limit" line under each endpoint, docs/troubleshooting.mdx "429" and "503" sections, CLAUDE.md "Rate Limiting".

## Room code TTL

- server/server.js: `codeToRoom.set(code, { roomId, expires: Date.now() + 600000 })` under `POST /api/code`.
- Docs: docs/reference/http-api.mdx "Room codes" ("10 minutes", twice), docs/cli/send.mdx "Output" ("valid for 10 minutes"), docs/troubleshooting.mdx "codes expire after 10 minutes", docs/self-hosting/configuration.mdx `MAX_ACTIVE_CODES` row ("full 10 minutes"), CLAUDE.md "Room Codes".

## TURN credential lifetimes

- server/server.js: `ttl = 24 * 3600` in the coturn HMAC path, `CF_TURN_TTL` 24 h, `CF_CACHE_MS` 12 h.
- Docs: docs/self-hosting/turn-relay.mdx ("Credentials expire after 24 hours", "cached in memory for 12 hours"), docs/reference/http-api.mdx `GET /api/turn-credentials` ("24 hour expiry", "12 hours"), docs/troubleshooting.mdx "The TURN relay is not working" ("12 hours"), CLAUDE.md "TURN Credentials".

## CLI flags and environment

- cli/cmd/floe/main.go: `flagServer` (`--server`, default `https://api.floe.one`), `flagNoRelay`, `flagWebURL` (`--web`), `flagIface` (`--iface`, repeatable), `flagOutput` (`-o`, default `.`), `flagAutoAccept` (`-y`), `flagNoReport`, `flagUpdateCheck` (`--check`); `FLOE_SERVER` and `FLOE_WEB` in the root `PersistentPreRunE`, `FLOE_NO_STATS` in the receive command.
- cli/internal/selfupdate/selfupdate.go: `FLOE_NO_UPDATE_CHECK`.
- Docs: docs/cli/flags.mdx (every table), docs/cli/receive.mdx, docs/cli/update.mdx, docs/cli/self-hosted-server.mdx, docs/snippets/stats-optout.mdx, README.md CLI section.

## Versions

- `DESKTOP_VERSION` / `DESKTOP_RELEASE_DATE` (client/lib/desktopRelease.ts) must equal desktop/wails.json `productVersion` and the newest `desktop-v*` tag.
- The newest `v*` tag is the example string in docs/cli/flags.mdx (`floe 1.10.4`, `Already up to date (1.10.4)`), docs/self-hosting/images.mdx (the exact-tag row and `FLOE_IMAGE_TAG=`), docs/reference/transfer-protocol.mdx (`"ver": "1.10.4"`, two JSON examples plus one prose mention), and the top `<Update>` entries in docs/changelog.mdx.
- The floe-release skill's `check-version-pins.mjs` (separate PR) settles these mechanically; until it lands, `git tag --sort=-v:refname` plus grep.

## Environment variable fan-out

Script (`env`). Canonical: docs/self-hosting/configuration.mdx. Mirrors: CONTRIBUTING.md (two tables), SELF_HOSTING.md (curated subset), server/.env.example, client/.env.example, .env.docker.example, docker-compose.yml, unraid/\*.xml.

## Docs URLs inside shipped binaries and workflows

Script (`links`). cli/cmd/floe/main.go (two `https://www.floe.one/docs` strings), desktop/frontend/src/App.tsx (`BrowserOpenURL`), client/lib/desktopRelease.ts and .github/workflows/desktop-release.yml (changelog URL), client/components/layout/Footer.tsx (mirror of docs.json `footer.links`).

## Frozen zones (never edit)

- Shipped `<Update label="...">` entries in docs/changelog.mdx: label = tag = anchor.
- The authoring-contract comment at the top of docs/changelog.mdx (changing it is a restructure).
- docs/docs.json `name` ("Floe" feeds the " - Floe" tab suffix and the schema.org Organization).
- The `CI green` job name in .github/workflows/ci.yml (the ruleset's required check).

## Known drift as of 2026-08-28 (fixed in a separate PR)

- server/.env.example NODE_ENV comment describes the Express stack-trace behavior that #239 made irrelevant, and the file has two em dashes (not a `dashes` surface, so the script cannot see them).
- CONTRIBUTING.md "Corepack ships with Node 22": true only below Node 25.
- client/components/layout/Footer.tsx and docs/docs.json footer say "Self-Hosting"; the docs settled on "Self-hosting" (#337). Change both together.
- client/app/how-it-works/page.tsx chips name pages by titles they do not have (the `labels` NOTEs).
