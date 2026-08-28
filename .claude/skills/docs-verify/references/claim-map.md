# Claim map

Keyed by the symbol that is the truth. For each sentence you touched, open the symbol and diff the sentence against it. No values are written here on purpose: a value in this file would go stale the day the code changes, and the point is to read the code. "Script" means docs-check.mjs already compares it; everything else is read by hand.

The map names where a value is stated; grep the old literal repo-wide before finishing, the map is not exhaustive.

## Relay cap

- `RelaySizeLimit` (cli/engine/transfer/relay.go) and `RELAY_SIZE_LIMIT` (client/lib/relay.ts); the comparison is strictly greater-than, sender-side only.
- Docs: docs/how-it-works/2gb-limit.mdx (whole page, including the "exactly N is allowed" sentence), docs/troubleshooting.mdx (the relay-limit headings and the desktop "capped" heading), docs/self-hosting/turn-relay.mdx (end of "How credentials work"), docs/cli/send.mdx "Notes", docs/desktop/settings.mdx "Hide my IP address", CLAUDE.md "Relay Size Limit".

## Protocol version

- `ProtocolVersion` / `MinProtocolVersion` (cli/engine/transfer/protocol.go) and `PROTOCOL_VERSION` / `MIN_PROTOCOL_VERSION` (client/lib/transfer/protocol.ts).
- Tests: `TestProtocolVersionPinnedToClient` (cli/engine/transfer/protocol_test.go) and the `constants` block of client/lib/transfer/protocol.test.ts pin both numbers by hand and name each other; the script does not compare them.
- Docs: docs/reference/transfer-protocol.mdx "Protocol versioning" (which also names both test files) plus every `pv` / `pvMin` example on that page, docs/desktop/settings.mdx "Transfer protocol", docs/changelog.mdx intro (the "no release so far has changed the transfer protocol" sentence), CLAUDE.md "Transfer Protocol Versioning".

## Deployed commit

- `GET` in client/app/api/config/route.ts: `commit` is `VERCEL_GIT_COMMIT_SHA`, then `SOURCE_COMMIT`, else `null`, with an empty value counting as unset; `socketUrl` is unchanged.
- Docs: docs/reference/http-api.mdx "GET /api/config belongs to the web client" (the example and the `commit` paragraph), docs/self-hosting/build-time-url.mdx (the paragraph under the resolution table), docs/self-hosting/configuration.mdx `SOURCE_COMMIT` row (script: presence only); the CONTRIBUTING.md client table and client/.env.example omit it deliberately, as they do `SOCKET_URL`, so the script reports two NOTEs.

## Timeouts

- cli/engine/peer/connection.go: `signalWaitTimeout`, `connectTimeout`, `connectGrace`.
- cli/engine/transfer/sender.go: `ackDeadline`, `drainDeadline` (delivery confirmation), the `time.After` in the backpressure loop (buffer not draining).
- cli/engine/transfer/receiver.go: `receiveIdleTimeout`, `receiveStallTimeout`, the `time.After` teardown grace before returning, the `http.Client` timeout in `reportBytesToServer`.
- client/lib/transfer/protocol.ts: `ACK_TIMEOUT_MS` (the only one the browser shares).
- Docs: docs/reference/transfer-protocol.mdx "Timeouts" table (every row), docs/cli/flags.mdx "Timeouts", docs/troubleshooting.mdx CLI headings that quote the error strings (the strings themselves are in receiver.go and sender.go).

## Rate limits and caps

- server/server.js: `MAX_CONNECTIONS_PER_IP`, `TURN_MAX_REQUESTS`, `CODE_MAX_REQUESTS`, `STATS_MAX_REPORTS` (fixed, no env var), `MAX_ACTIVE_CODES`, `MAX_REPORT_BYTES`; windows `RATE_LIMIT_WINDOW`, `TURN_RATE_WINDOW`, `CODE_RATE_WINDOW`, `STATS_RATE_WINDOW`.
- Docs: docs/self-hosting/configuration.mdx table and "Two things about the limits" (script: server rows), CONTRIBUTING.md server table (script), docs/reference/architecture.mdx "Rate limiting" table, docs/reference/http-api.mdx "Rate limit" line under each endpoint, docs/troubleshooting.mdx "429" and "503" sections, CLAUDE.md "Rate Limiting", server/.env.example comments (script, NOTE).

## Room code TTL

- server/server.js: the `expires:` expression in the `codeToRoom.set(...)` call under `POST /api/code`.
- Docs: docs/reference/http-api.mdx "Room codes" (stated twice), docs/cli/send.mdx "Output", docs/troubleshooting.mdx (the "codes expire after" heading), docs/self-hosting/configuration.mdx `MAX_ACTIVE_CODES` row, CLAUDE.md "Room Codes".

## TURN credential lifetimes

- server/server.js: the `ttl` local in the coturn HMAC path, `CF_TURN_TTL`, `CF_CACHE_MS`.
- Docs: docs/self-hosting/turn-relay.mdx (the expiry sentence under the coturn setup and "How credentials work"), docs/reference/http-api.mdx `GET /api/turn-credentials`, docs/troubleshooting.mdx "The TURN relay is not working", CLAUDE.md "TURN Credentials".

## CLI flags and environment

- cli/cmd/floe/main.go: `flagServer` (`--server`, with its compiled default), `flagNoRelay`, `flagRelayOnly` (`--relay-only`, mutually exclusive with `--no-relay` via `MarkFlagsMutuallyExclusive`), `flagWebURL` (`--web`), `flagIface` (`--iface`, repeatable), `flagOutput` (`-o`, with its default), `flagAutoAccept` (`-y`), `flagNoReport`, `flagUpdateCheck` (`--check`); `FLOE_SERVER`, `FLOE_WEB` and `FLOE_RELAY_ONLY` in `applyEnv` (called from the root `PersistentPreRunE`; a typed `--no-relay` beats `FLOE_RELAY_ONLY`), `FLOE_NO_STATS` in the receive command.
- cli/cmd/floe/main.go `connectedLine`: the `Connected (direct)` / `Connected (relay)` / bare `Connected` status line, read once from `Connection.ConnectionType()` after setup.
- cli/internal/selfupdate/selfupdate.go: `FLOE_NO_UPDATE_CHECK`.
- Docs: docs/cli/flags.mdx (every table), docs/cli/send.mdx and docs/cli/receive.mdx ("Output" quotes the `Connected` line), docs/cli/update.mdx, docs/cli/self-hosted-server.mdx, docs/snippets/stats-optout.mdx, README.md CLI section. `--relay-only` is also described as the twin of Hide my IP in docs/how-it-works/relay-connection.mdx (the badge row, "Turning it off, and the opposite", and the accordion), docs/desktop/settings.mdx "Hide my IP address", docs/choosing-floe.mdx (the "Force the relay" row), docs/how-it-works/known-limitations.mdx, docs/security-privacy.mdx, docs/how-it-works/2gb-limit.mdx "One case that catches people out", and docs/troubleshooting.mdx `timed out establishing a connection`.

## Versions

- `DESKTOP_VERSION` / `DESKTOP_RELEASE_DATE` (client/lib/desktopRelease.ts) must equal desktop/wails.json `productVersion` and the newest `desktop-v*` tag.
- The newest `v*` tag is the example string in docs/cli/flags.mdx (the `--version` row and the `--check` row), docs/self-hosting/images.mdx (the exact-tag row and `FLOE_IMAGE_TAG=`), docs/reference/transfer-protocol.mdx (`"ver"`: two JSON examples plus one prose mention), and the top `<Update>` entries in docs/changelog.mdx.
- The floe-release skill's `check-version-pins.mjs` (separate PR) settles these mechanically; until it lands, `git tag --sort=-v:refname` plus grep.

## Environment variable fan-out

Script (`env`). Canonical: docs/self-hosting/configuration.mdx. Mirrors: CONTRIBUTING.md (two tables), SELF_HOSTING.md (curated subset), server/.env.example (value lines and comments), client/.env.example, .env.docker.example, docker-compose.yml, unraid/\*.xml. Prose that repeats numbers without being a mirror: CLAUDE.md, docs/reference/architecture.mdx.

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
- Two links target the unstable heading in docs/web-app/receiving.mdx (the `links` NOTEs at docs/faq.mdx:62 and docs/troubleshooting.mdx:24); the heading needs an explicit `{#id}`.
