# Contributing to Floe

Thank you for your interest in contributing! All contributions are welcome. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork locally
3. Follow the setup below
4. Make your changes on a new branch
5. Submit a pull request with a clear description

---

## Development Setup

Floe has four parts: a **Next.js client**, a **Node.js signaling server**, a **Go CLI**, and a **Wails desktop app**. The CLI and the desktop app share the Go transfer engine in `cli/engine/`, joined by the `go.work` workspace at the repository root.

For most contributions (UI, pages, components), you only need to run the client. Point it at the live signaling server at `api.floe.one` so you do not need to run a server locally.

### Prerequisites

- **Node.js 22 or newer** for the client and the signaling server (CI tests the client on Node 22 and the server on Node 20).
- **pnpm 11** for the client. The repo pins `pnpm@11.1.2` through the `packageManager` field: install it directly with `npm install -g pnpm@11`, or run `corepack enable` once (Corepack ships with Node 22 through 24 and picks up the pinned version automatically; Node 25 dropped it, so run `npm install -g corepack` first there; on Windows run it from an elevated terminal).
- **Go 1.25 or newer** for the CLI and the desktop app.
- **Docker** (optional) for the full-stack Compose setup below.

### Client Only (Recommended for most contributors)

```bash
git clone https://github.com/YOUR_USERNAME/floe.git
cd floe/client

cp .env.example .env.local
# In .env.local, set NEXT_PUBLIC_SOCKET_URL=https://api.floe.one
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). With `NEXT_PUBLIC_SOCKET_URL` set to `https://api.floe.one`, the client uses the live signaling server, so you do not need to run one locally.

### Client + Server (Only needed if you're changing server code)

Run each terminal from the repository root.

```bash
# Terminal 1 - Server
cd server
cp .env.example .env
npm install
npm run dev

# Terminal 2 - Client
cd client
cp .env.example .env.local
# NEXT_PUBLIC_SOCKET_URL is already http://localhost:3001 (the .env.example default)
pnpm install
pnpm dev
```

### CLI (Only needed if you're changing CLI code)

From the repository root:

```bash
cd cli
go build ./cmd/floe
go test ./...
```

### Desktop app (Only needed if you're changing the desktop app)

Build the frontend first: the Go build embeds `desktop/frontend/dist`, which is not checked in, so Go commands in `desktop/` fail on a fresh clone until it exists.

From the repository root:

```bash
cd desktop/frontend
npm install
npm run build
npm test

cd ..
go test ./...
```

For a live-reload development window, install the [Wails CLI](https://wails.io/docs/gettingstarted/installation) at the version `desktop/go.mod` links against (currently v2.12.0) and run `wails dev` from `desktop/`.

### Documentation (Only needed if you're changing docs)

The documentation site lives in `docs/` and is built with [Mintlify](https://mintlify.com).

```bash
cd docs
npx mintlify dev --port 3333
```

Open [http://localhost:3333](http://localhost:3333) to preview the docs locally. The `--port` flag matters when the client dev server is already running: both default to port 3000.

### Full stack with Docker (no local toolchain needed)

To run the client and signaling server together in containers (without installing Node, pnpm, or Go locally), use the Docker Compose setup. Add the build overlay so it compiles your working tree rather than pulling the published images:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

The overlay tags its output `floe-client:dev` and `floe-server:dev`, so a local build never replaces a pulled image under the same name.

Without the overlay, `docker compose up -d` pulls the prebuilt images from ghcr.io and ignores your working tree entirely, which is what a self-hoster wants but almost never what a contributor wants.

Even with the overlay this is a production build with no hot reload, so use it to verify a change against the full stack in one shot, not as a development loop. For running your own instance, see [SELF_HOSTING.md](SELF_HOSTING.md).

---

## Environment Variables

### Client (`client/.env.local`)

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_SOCKET_URL` | No | Signaling server URL the browser connects to. `pnpm dev` already defaults to `http://localhost:3001`; for UI-only work set it to `https://api.floe.one` to use the live server without running one locally. Inlined at build time when set. Self-hosted Docker instances leave it unset and resolve the address at runtime instead. |
| `NEXT_PUBLIC_SITE_URL` | No | Public base URL for canonical links, Open Graph tags, and the sitemap. Defaults to `https://www.floe.one`. Set to your own domain when self-hosting. |
| `NEXT_PUBLIC_SENTRY_DSN` | No | Your Sentry DSN for client-side error tracking. Leave empty to disable. |
| `SENTRY_DSN` | No | Your Sentry DSN for server-side error tracking. Leave empty to disable. |
| `SENTRY_ORG` | No | Your Sentry organization slug. |
| `SENTRY_PROJECT` | No | Your Sentry project slug. |
| `NEXT_PUBLIC_UMAMI_WEBSITE_ID` | No | Your Umami analytics website ID. Leave empty to disable. |

### Server (`server/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `CLIENT_URL` | Prod | Frontend origin added to the CORS allow-list. `http://localhost:3000` is already allowed by default, so this is only needed for other origins (production). |
| `PORT` | No | Signaling server port (default: `3001`) |
| `NODE_ENV` | No | Standard Node.js runtime flag (`development` or `production`). |
| `TRUSTED_PROXY_COUNT` | No | Trusted reverse-proxy hop count for correct client-IP parsing and rate limiting (default: `1`). Set to `0` for direct exposure with no proxy. |
| `MAX_CONNECTIONS_PER_IP` | No | Connection rate limit ceiling per IP per 60 seconds (default: `30`). Raise in staging or test environments. |
| `MAX_CODE_REQUESTS_PER_IP` | No | Rate limit for the `/api/code` endpoints per IP per 60 seconds (default: `60`), shared across registering and resolving codes. Raise in CI or staging. |
| `MAX_ACTIVE_CODES` | No | Maximum number of simultaneously-live room codes (default: `10000`). `POST /api/code` returns `503` when the cap is reached. |
| `MAX_TURN_REQUESTS_PER_IP` | No | Rate limit for `GET /api/turn-credentials` per IP per 60 seconds (default: `20`). Raise in CI or staging. |
| `CLOUDFLARE_TURN_KEY_ID` | No | Turn Token ID of a Cloudflare Realtime TURN key. With the API token below, enables managed TURN with no extra infrastructure. Takes precedence over the coturn variables. |
| `CLOUDFLARE_TURN_KEY_API_TOKEN` | No | API token that pairs with `CLOUDFLARE_TURN_KEY_ID`. Keep it secret. |
| `TURN_SECRET` | No | Shared secret for self-hosted coturn HMAC credentials, used only when the Cloudflare variables are unset. Omit both options to use STUN-only (direct connections). |
| `TURN_DOMAIN` | No | Your self-hosted TURN relay server domain. |
| `UPSTASH_REDIS_REST_URL` | No | Upstash Redis REST URL for the durable global transfer counter. Omit to run the counter in memory only (resets on restart). |
| `UPSTASH_REDIS_REST_TOKEN` | No | Upstash Redis REST token, paired with the URL above. |
| `MAX_REPORT_BYTES` | No | Max bytes accepted per `/api/stats/report` call (default: 5 TiB). |

> **Note:** TURN is optional. Without it, only direct connections work. This is fine for local development and most home networks.

---

## Pull Request Process

1. Create a new branch: `git checkout -b your-branch-name`
2. Make your changes
3. If you touched `client/`, ensure the build passes: `pnpm build` (in `client/`)
4. If you touched `client/`, run the linter: `pnpm lint` (in `client/`)
5. If you touched `client/`, run its tests: `pnpm test` (in `client/`)
6. If you touched `server/`, run its tests: `npm test` (in `server/`)
7. If you touched `cli/`, run its tests: `go test ./...` (in `cli/`)
8. If you touched `desktop/`, run its tests too: `go test ./...` (in `desktop/`, after building the frontend) and `npm test` (in `desktop/frontend/`)
9. Write commit messages in the conventional style: a lowercase, imperative subject with an optional scope, for example `fix(client): keep the progress bar visible while verifying` or `docs: clarify the relay cap`. PRs are squash-merged, so the PR title follows the same convention.
10. Submit a pull request. The template asks for a short summary and a test plan. CI runs automatically on the PR, and the `CI green` check must pass before it can merge (docs-only PRs skip the heavy jobs and go green in about a minute).

---

## Code Style

- TypeScript for all new client code
- Match the formatting of the surrounding code (Prettier is configured repo-wide), and lint before pushing: `pnpm lint` (in `client/`)
- Keep components focused and readable

---

## Reporting Bugs

Open an issue with:
- A clear description of the problem
- Steps to reproduce it
- What you expected vs. what happened

## Suggesting Features

Open an issue and describe what you'd like and why it would be useful.

## Questions

Ask in [Discussions](https://github.com/jannskiee/floe/discussions). For bugs and concrete feature requests, open an issue. We are happy to help.

Thank you for contributing!
