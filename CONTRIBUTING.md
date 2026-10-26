# Contributing to Floe

Thank you for your interest in contributing! All contributions are welcome. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting Started

1. If your change is for an open issue, comment on the issue first to have it assigned to you, so nobody else starts the same work. A pull request for an issue that is assigned to someone else is closed.
2. Fork the repository on GitHub
3. Clone your fork locally
4. Follow the setup below
5. Make your changes on a new branch
6. Submit a pull request with a clear description

You can have at most two open pull requests here at a time, drafts included. Until one of them is merged or closed, GitHub refuses to open another. Its error may read like a permissions problem and not mention the limit, so if a new pull request is refused, count your open ones first.

---

## Development Setup

Floe has four parts: a **Next.js client**, a **Node.js signaling server**, a **Go CLI**, and a **Wails desktop app**. The CLI and the desktop app share the Go transfer engine in `cli/engine/`, joined by the `go.work` workspace at the repository root.

For UI work (pages, components) that never receives a file, you only need to run the client, and it can use the live signaling server at `api.floe.one`. For anything that receives a test transfer, run the server locally too, as in [Client + Server](#client--server-for-server-changes-and-for-test-transfers) below, and read [Test transfers and the public counter](#test-transfers-and-the-public-counter) first.

### Prerequisites

- **Node.js 22.13 or newer.**
  - The client needs it: pnpm 11 requires at least Node.js 22.13, and CI builds and tests the client on Node 22.
  - CI tests the signaling server on Node 22 and on Node 24, and the published container images run both services on Node 24.
  - No `package.json` in the repository declares an `engines` range, so an older Node is not refused up front. It fails later, when something needs a newer one.
- **pnpm 11** for the client. The repo pins `pnpm@11.1.2` through the `packageManager` field. Install it in one of two ways:
  - Directly, with `npm install -g pnpm@11`.
  - Through Corepack: run `corepack enable` once, and Corepack picks up the pinned version automatically. Node 22 through 24 ship Corepack. Node 25 dropped it, so run `npm install -g corepack` first there. On Windows, run these from an elevated terminal.
- **Go 1.26 or newer** for the CLI and the desktop app.
- **Docker** (optional) for the full-stack Compose setup below.

### Test transfers and the public counter

The counter on the floe.one homepage is an all-time total of the bytes that receivers have reported to Floe's own server. After a completed transfer, the receiving side reports its byte count to the signaling server it is connected to, and the server only ever adds to the total. Nothing subtracts, so the bytes of a test transfer stay in the public figure for good.

That matters whenever a development build talks to `api.floe.one`. Before you receive a test transfer through the live server, turn the report off on the receiving side:

| Receiver | How to turn the report off |
|----------|----------------------------|
| Web app | Untick **Contribute to global stats** on the receiving page. It is shown until the first file arrives, it is ticked by default, and the browser remembers the choice per site, so `http://localhost:3000` needs it once. |
| CLI | Pass `--no-report` to `floe receive`, or set `FLOE_NO_STATS=1`. |
| Floe Desktop | Turn off **Contribute to global stats** under Settings, **Privacy**. |

Better still, keep test transfers off the live server: run `server/` locally, as in [Client + Server](#client--server-for-server-changes-and-for-test-transfers) below. A server started from the unedited `server/.env.example` has no Upstash credentials, so its counter lives in memory and resets when it restarts. Never put the production Upstash credentials in a development `server/.env`.

<a id="client-only-recommended-for-most-contributors"></a>

### Client Only (for UI work that never receives a file)

```bash
git clone https://github.com/YOUR_USERNAME/floe.git
cd floe/client

cp .env.example .env.local
# In .env.local, set NEXT_PUBLIC_SOCKET_URL=https://api.floe.one
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). With `NEXT_PUBLIC_SOCKET_URL` set to `https://api.floe.one`, the client uses the live signaling server, so you do not need to run one locally.

> **Warning:** In this setup a transfer you receive adds its bytes to the public counter on floe.one, permanently. Untick **Contribute to global stats** on the receiving page before any test transfer, or run the server locally instead. See [Test transfers and the public counter](#test-transfers-and-the-public-counter).

`pnpm dev` prints a warning that custom Cache-Control headers were detected for `/_next/static/:path*`. That is expected and applies to development only: `next.config.mjs` sets `Cache-Control: no-store` on those assets when `NODE_ENV === 'development'`, so the header never reaches a build. Why it does is in the comment beside it.

<a id="client--server-only-needed-if-youre-changing-server-code"></a>

### Client + Server (For server changes and for test transfers)

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

This is the setup to use for test transfers: your own server does the signaling, and with the Upstash variables empty in `server/.env` its counter is only a number in that server's memory.

### CLI (Only needed if you're changing CLI code)

From the repository root:

```bash
cd cli
go build ./cmd/floe
go test ./...
```

The binary talks to `https://api.floe.one` unless you tell it otherwise. For test transfers, point it at a local server with `--server http://localhost:3001` (or `FLOE_SERVER`), and add `--no-report` to `floe receive` whenever the server is the live one.

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

For a live-reload development window, install the [Wails CLI](https://wails.io/docs/gettingstarted/installation) at the version `desktop/go.mod` links against (currently v2.17.0) and run `wails dev` from `desktop/`.

A development build talks to `api.floe.one` until you set **Server address** under Settings, **Advanced** (`http://localhost:3001` for a local server). Before it receives a test transfer through the live server, turn its stats report off, as [Test transfers and the public counter](#test-transfers-and-the-public-counter) shows.

### Request links (local development)

Request links are off until the server's policy file turns them on, so a local server needs one.

1. In `server/.env`, set `POLICY_FILE` to the absolute path of a JSON file that contains `{"requestLinks": true}`. The repository already has one for the e2e suite: `client/e2e/fixtures/request-policy-on.json`.
2. Restart the server, because the path is read once, at startup. `curl http://localhost:3001/health` then answers with `"features":["request-1"]`. From then on the server re-reads the file's content every 60 seconds, so changing `true` to `false` needs no restart.
3. Make a link. In Floe Desktop from `wails dev`, set **Server address** to `http://localhost:3001` as above, then choose **Receive**, **Request link**, **Make link**. The link points at `http://localhost:3000/r/...`, which the local client serves.
4. Open the link in a browser, or send to it from the CLI: `floe send <files> --to "<link>" --server http://localhost:3001`.

Without the desktop app, the test host the e2e suite uses can stand in for step 3. From `cli/`, `go run ./internal/e2ehost request -out <folder> -timeout 30m` prints one JSON event per line, and the `link` event carries the link. It talks to the local server and client by default, and it accepts a drop without asking.

`cli/internal/e2ehost` (modes `host`, `send` and `request`) and `cli/internal/rlvisitor` (a hostile request-link sender for testing what the desktop app refuses, which only talks to a local or private server) are test tools. Each one's `main.go` lists its flags. GoReleaser builds only `./cmd/floe`, so neither ships.

### Documentation (Only needed if you're changing docs)

The documentation site lives in `docs/` and is built with [Mintlify](https://mintlify.com).

```bash
cd docs
npx mint dev --port 3333
```

Open [http://localhost:3333](http://localhost:3333) to preview the docs locally. The `--port` flag matters when the client dev server is already running: both default to port 3000.

Before you open a docs PR, run the pre-flight from the repository root:

```bash
node .claude/skills/docs-verify/scripts/docs-check.mjs
```

It checks links and anchors, the navigation, frontmatter, headings MDX cannot compile, link labels, table shape, the environment-variable tables, and em and en dashes. Three more checks also fail the run: the docs page standard, the message list and the screenshot manifests. The message list, `.claude/skills/docs-verify/references/messages.json`, has a row for each message Floe can show. Rewording a message of the web app, the website, the server or the install scripts that has a row there, renaming a docs heading a row links to, or adding a sentence to the request page's copy (`client/lib/request/visitorCopy.ts`) without a row fails it. Add or change the row in the same PR, then rewrite `docs/messages.mdx` with `node .claude/skills/docs-verify/scripts/messages-index.mjs --write`. A screenshot manifest fails when a string recorded for a docs picture has left the files that type it. Two more checks, readability and glossary first use, only print notes. It reads `docs/` and the root Markdown files, and also the code and configuration that link to the docs or repeat their facts: the web app, CLI and desktop source, `.github/`, the server's settings, both env examples, `docker-compose.yml`, `unraid/` and `.goreleaser.yml`. It exits 1 on a defect it can decide and prints everything else as `NOTE` lines for you to read. CI runs the same command on every pull request, in the `Repo guardrails` job, so a defect it can decide blocks the merge.

`docs/changelog.mdx` is written by hand. When your change is one a user can see:

1. Add a bullet to the `Unreleased` entry at the top of the timeline. Start one if the newest entry already carries a release tag.
2. Follow the authoring contract in the comment at the top of that file.
3. If you would rather not write it, say in the PR that it needs one.

A change nobody outside the repository can notice needs no entry.

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
| `NEXT_PUBLIC_SOCKET_URL` | No | Signaling server URL the browser connects to. When to set it is under this table. |
| `NEXT_PUBLIC_SITE_URL` | No | Public base URL for canonical links, Open Graph tags, and the sitemap. Defaults to `https://www.floe.one`, but `client/.env.example` sets `http://localhost:3000`, so a copied file uses that until you change or remove the line. Set to your own domain when self-hosting. |
| `REQUEST_REPORT_EMAIL` | No | Where "Report this link" on a request link's page (`/r/...`) sends its email. floe.one uses a built-in address and ignores this. On any other origin, `localhost` included, the page shows the link only when this holds exactly one plain address, so set one to see the link while you work on that page. Read on every request and never inlined at build time. |
| `NEXT_PUBLIC_SENTRY_DSN` | No | Your Sentry DSN for error tracking in the browser. Leave empty to disable. |
| `SENTRY_DSN` | No | Your Sentry DSN for error tracking on the client's own server side (the Next.js server and edge runtimes, not the signaling server). Leave empty to disable. |
| `SENTRY_ORG` | No | Your Sentry organization slug. |
| `SENTRY_PROJECT` | No | Your Sentry project slug. |
| `NEXT_PUBLIC_UMAMI_WEBSITE_ID` | No | Your Umami analytics website ID. Leave empty to disable. |

`NEXT_PUBLIC_SOCKET_URL` in more detail:

- `pnpm dev` already defaults to `http://localhost:3001`, so a local server needs nothing set.
- For UI-only work, set it to `https://api.floe.one` to use the live server without running one locally. Read [Test transfers and the public counter](#test-transfers-and-the-public-counter) first.
- When it is set, it is inlined at build time.
- Self-hosted Docker instances leave it unset and resolve the address at runtime instead.

Two more client variables are left out of this table and of `client/.env.example` on purpose, because a development setup never sets them:

- `SOCKET_URL`, which a running client reads on every request to tell the browser where the signaling server is (the Docker images use it).
- `SOURCE_COMMIT`, which a self-hosted client can set to report the commit it was built from.

Both are in the [Configuration reference](https://www.floe.one/docs/self-hosting/configuration).

### Server (`server/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `CLIENT_URL` | Prod | One extra frontend origin, matched exactly. The server allows it for browser requests (CORS) and for WebSocket connections, on Socket.IO and on `/ws`. `http://localhost:3000` is always allowed, so this is only needed for another origin (production). |
| `PORT` | No | Signaling server port (default: `3001`) |
| `NODE_ENV` | No | Standard Node.js runtime flag (`development` or `production`). Floe's own server code never reads it; Express and some dependencies do, and `server/.env.example` sets `production`. |
| `TRUSTED_PROXY_COUNT` | No | Trusted reverse-proxy hop count for correct client-IP parsing and rate limiting (default: `1`). Set to `0` for direct exposure with no proxy. Docker Compose passes `0` unless you set it. |
| `MAX_CONNECTIONS_PER_IP` | No | Connection rate limit ceiling per IP per 60 seconds (default: `30`). Raise in staging or test environments. |
| `MAX_SOCKETS_PER_IP` | No | Connections one IP may hold open at once, Socket.IO and `/ws` together (default: `60`). A connection past it is refused with `Rate limit exceeded`, as one past the rate limit is. |
| `MAX_CODE_REQUESTS_PER_IP` | No | Rate limit for the `/api/code` endpoints per IP per 60 seconds (default: `60`), shared across registering and resolving codes. Raise in CI or staging. |
| `MAX_FAILED_CODE_RESOLVES` | No | Failed lookups on `GET /api/code/:code` allowed per IP per 60 seconds (default: `10`). How it counts is under this table. |
| `MAX_ACTIVE_CODES` | No | Maximum number of simultaneously-live room codes (default: `10000`). `POST /api/code` returns `503` when the cap is reached. |
| `POLICY_FILE` | No | Absolute path to the request-link policy file, a JSON object such as `{"requestLinks": true}`. Unset means request links are off. The path is read at startup; the content is re-read every 60 seconds, so turning the feature on or off needs no restart. |
| `MAX_TURN_REQUESTS_PER_IP` | No | Rate limit for `GET /api/turn-credentials` per IP per 60 seconds (default: `20`). Raise in CI or staging. |
| `CLOUDFLARE_TURN_KEY_ID` | No | Turn Token ID of a Cloudflare Realtime TURN key. With the API token below, enables managed TURN with no extra infrastructure. Takes precedence over the coturn variables. |
| `CLOUDFLARE_TURN_KEY_API_TOKEN` | No | API token that pairs with `CLOUDFLARE_TURN_KEY_ID`. Keep it secret. |
| `TURN_SECRET` | No | Shared secret for self-hosted coturn HMAC credentials, used when the Cloudflare variables are unset, and as the fallback when Cloudflare returns nothing usable. Omit both options to use STUN-only (direct connections). |
| `TURN_DOMAIN` | No | Your self-hosted TURN relay server domain. |
| `TURN_TLS` | No | Set to `off` when that coturn has no TLS certificate: the `turns:` URL (port 5349) is then left out of the relay list. Unset keeps it. |
| `UPSTASH_REDIS_REST_URL` | No | Upstash Redis REST URL for the durable global transfer counter. Omit to run the counter in memory only (resets on restart). |
| `UPSTASH_REDIS_REST_TOKEN` | No | Upstash Redis REST token, paired with the URL above. |
| `MAX_REPORT_BYTES` | No | Max bytes accepted per `/api/stats/report` call (default: 5 TiB). |

> **Note:** TURN is optional. Without it, only direct connections work. This is fine for local development and most home networks.

About the limits in this table:

- "Per IP" means per IPv4 address, or per /64 for an IPv6 client (a /64 is usually one home or office network).
- Setting a `MAX_*` variable to `0` restores its default; it does not switch the limit off.
- `MAX_FAILED_CODE_RESOLVES` counts only misses, so a receiver retrying a code that works spends none of it. Once an address has used it up, every lookup from that address answers `429` until the misses age out, a working code included.

---

## Testing

Each part has its own unit tests:

| Part | Command | Runs |
|------|---------|------|
| `client/` | `pnpm test` | Vitest |
| `server/` | `npm test` | `node --test`, over every `*.test.js` in `server/` |
| `cli/` | `go test ./...` | The CLI and the shared engine |
| `desktop/frontend/` | `npm test` | Vitest |
| `desktop/` | `go test ./...` | The desktop app's Go side. Build the frontend first. |

### End-to-end tests

The Playwright suite in `client/e2e/` runs real transfers between browser tabs, the `floe` CLI and a Go test host, through a signaling server on your machine.

Before the first run you need:

- Go on your `PATH`. Every run builds the CLI and the test host before the first test, so the whole suite needs it, browser-only specs included.
- The server's dependencies: `npm ci` in `server/`. Playwright starts the server with `node server.js`.
- The client's dependencies and a browser: in `client/`, `pnpm install` and then `pnpm exec playwright install chromium` (on Linux, `pnpm exec playwright install --with-deps chromium`).

Then, from `client/`:

```bash
pnpm test:e2e                                    # the whole suite
pnpm exec playwright test e2e/transfer.spec.ts   # one spec
```

A run starts the signaling server on `:3001` and the client on `:3000` (with `next dev` locally; CI builds the client and serves the build with `next start`). The server it starts is set up for the suite:

- Request links are on, through the policy file `client/e2e/fixtures/request-policy-on.json`.
- The connection, room-code and TURN rate limits are raised to 1,000 a minute.
- The Upstash variables are overridden with a dummy local address and token, so no test byte can reach a real counter.

> **Warning:** Stop your own server and client, anything on `:3001` and `:3000`, before a run. A run refuses to start when something already answers there: Playwright stops before any test and says the address "is already used". Do not follow the hint in that message to set `reuseExistingServer:true`, because a server or client you started yourself has none of the setup above:
>
> - A server you started yourself has request links off unless you turned them on, applies the default rate limits, and sends test bytes to whatever counter its `server/.env` configures.
> - A client you started yourself keeps whatever `NEXT_PUBLIC_SOCKET_URL` it was started with. If that is `https://api.floe.one` (the Client Only setup above), the browser side of the suite would run through the live server, and its test receives would add their bytes to the public counter.
>
> On Windows, stopping `next dev` or `next start` can leave a `next-server` process holding `:3000`. Find it with `Get-NetTCPConnection -LocalPort 3000 -State Listen` in PowerShell and stop the process it names.
>
> With `CI` set, the client is served from the build already in `client/.next`, and the signaling address is compiled into a build. The run refuses a build that was not made with `NEXT_PUBLIC_SOCKET_URL=http://127.0.0.1:3001`.

CI runs the suite on Linux, Windows and macOS, with one worker and one retry. A local run uses Playwright's default workers and no retry. On every CI run that was not canceled, the Playwright report, the traces of retried tests and the CLI transcripts are uploaded as an artifact and kept for 7 days.

Some tests skip themselves unless you set a variable:

| Variable | What it turns on |
|----------|------------------|
| `FLOE_E2E_HEAVY=1` | The heavy request-link cells in `e2e/request-heavy.spec.ts`: a folder of 1,000 files, and one file of 4 GiB plus 1 byte. Never run in CI. |
| `FLOE_E2E_LOCAL_TURN=1` | The one request-link test that sends through a relay with Hide my IP on. Never run in CI. What it needs is under this table. |
| `E2E_EXPECT_UMAMI=1` | Extra assertions in `e2e/request-privacy.spec.ts` that only hold for a client built with an Umami website ID. |
| `FLOE_RELEASED_CLI=<path>` | `e2e/back-compat.spec.ts`, which pairs a released `floe` binary at that path with your working tree. Without it the whole file is skipped. |

`FLOE_E2E_LOCAL_TURN=1` needs:

- A coturn relay running locally.
- Its TURN variables set in the shell that starts the suite.
- A run with `--retries=0` and without `--trace`, because a trace would record the relay credentials.

### Go tests

Run `go vet ./...` and `go test ./...` in `cli/`, and in `desktop/` once the frontend is built. CI runs both, in `cli/` on Linux, Windows and macOS and in `desktop/` on Windows.

- **Your own settings are safe.** The packages whose tests could reach them (`cli/cmd/floe`, `cli/internal/selfupdate` and `desktop`) point the user config, cache, home and temp directories at a temporary folder in `TestMain`.
- **The long test is opt-in.** One test holds real timers for about 10 minutes: the `long` case of `TestDecideBlockingDoesNotTripWatchdog` in `cli/engine/transfer`. It skips unless `FLOE_LONG_TESTS=1`, and it needs an explicit `-timeout`, because it finishes within seconds of Go's 10 minute default:

  ```bash
  cd cli
  FLOE_LONG_TESTS=1 go test -run 'TestDecideBlockingDoesNotTripWatchdog/long' -timeout 20m ./engine/transfer/
  ```

- **Fuzz targets keep their seeds in git.** The `Fuzz*` functions in `cli/engine/code`, `cli/engine/signaling` and `cli/engine/transfer` exercise the decoders of what a peer, the signaling server or a pasted link hands the engine. Their seed inputs are committed under each package's `testdata/fuzz/`, and a plain `go test ./...` replays every one, so CI runs them as ordinary tests. To fuzz a target, name exactly one:

  ```bash
  cd cli
  go test -run '^$' -fuzz '^FuzzParseMetadata$' -fuzztime 30s ./engine/transfer/
  ```

  After you add or change a seed in a `fuzz_test.go`, rewrite the committed files from inside that package's directory: `FLOE_WRITE_FUZZ_SEEDS=1 go test -run '^Fuzz' .`
- **One fixture is shared with the server.** `cli/engine/signaling/testdata/derivation-vectors.json` holds the test vectors for deriving a request link's room id, and `server/server.test.js` reads the same file, so the Go and the Node derivations are checked against one list.
- **Test files are named for what they exercise**, and the Go and TypeScript halves mirror each other: `hash_test.go` is the receiver's side of the per-file SHA-256 and `senderhash_test.go` the sender's, and `receiverHash.test.ts` is the browser receiver's.

---

## Pull Request Process

1. Create a new branch: `git checkout -b your-branch-name`
2. Make your changes
3. If you touched `client/`, ensure the build passes: `pnpm build` (in `client/`)
4. If you touched `client/`, run the linter: `pnpm lint` (in `client/`)
5. If you touched `client/`, run its tests: `pnpm test` (in `client/`)
6. If you touched `server/`, run its tests: `npm test` (in `server/`)
7. If you touched `cli/`, vet and test it: `go vet ./...` and `go test ./...` (in `cli/`). The desktop app is built on `cli/engine/`, so a change there can break `desktop/` as well.
8. If you touched `desktop/`, vet and test it too: `go vet ./...` and `go test ./...` (in `desktop/`, after building the frontend) and `npm test` (in `desktop/frontend/`)
9. Write commit messages in the conventional style: a lowercase, imperative subject with an optional scope, for example `fix(client): keep the progress bar visible while verifying` or `docs: clarify the relay cap`. PRs are squash-merged, so the PR title follows the same convention.
10. Submit a pull request. The template asks for a short summary and a test plan. CI runs on the PR (on your first PR here it waits until the maintainer approves the run), and the `CI green` check must pass before it can merge (docs-only PRs skip the heavy jobs and go green in about three minutes). The maintainer merges the exact commit that was reviewed, once `CI green` has passed on it, so if you push again after a review, say in the PR what you changed.

### What CI runs, and how to run it locally

A first job, `Detect changed paths`, decides which of the jobs below run, and `CI green` passes only when every one that ran has passed. "Code changed" means the PR touches at least one file outside `docs/` and `.claude/skills/`. A PR that changes only `docs/` runs `Repo guardrails` and `Skill test suites` and skips the rest.

| CI job | Runs when | What it checks |
|--------|-----------|----------------|
| `Repo guardrails` | Every PR | That every file reading a value the other peer chose is listed in the peer-data consumer map, and the docs pre-flight: links and anchors, tables, headings MDX cannot compile, documented server defaults, em and en dashes, the docs page standard, the message list and the screenshot manifests |
| `Build & Lint` | Code changed | Client lint, unit tests, production build and page titles, plus a check that the desktop release named in `client/lib/desktopRelease.ts` has its assets on GitHub |
| `Server (Node.js 22)`, `Server (Node.js 24)` | Code changed | Server tests, once on each Node version |
| `CLI (Go, <os>)` | Code changed | Vet, tests and build, on Linux, Windows and macOS |
| `Go formatting` | Code changed | `gofmt -l` over every tracked `.go` file |
| `Desktop (Wails, windows-latest)` | Code changed | Frontend tests and build, Go vet and tests, then a packaging smoke that builds the NSIS installer and packs the MSIX |
| `E2E (browser + CLI interop, <os>)` | Code changed | The Playwright suite, on Linux, Windows and macOS |
| `Back-compat (HEAD vs latest release)` | Code changed | The latest released CLI against your branch, in every pairing with the browser and the new CLI |
| `Docker (self-hosting stack)` | Code changed | The compose files are valid, both images build from source and pass their smoke test, and the stack starts with no `.env` |
| `Lint workflows` | `.github/workflows/`, `.github/scripts/`, `.github/dependabot.yml` or `.github/zizmor.yml` changed | actionlint over the workflows, shellcheck over the scripts, and zizmor's security audit of the workflows and `dependabot.yml` |
| `Skill test suites` | Every PR | The test files of the skills under `.claude/skills/`, on Windows. Some of them read product files, which is why a PR that touches no skill runs them too. |

To run a job locally (commands are for a bash shell):

- **`Repo guardrails`**, from the repository root: `node .claude/skills/untrusted-peer-data/scripts/check-consumers.mjs` and `node .claude/skills/docs-verify/scripts/docs-check.mjs all`.
- **`Build & Lint`**, in `client/`: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm test`, `pnpm build`, `node scripts/check-titles.mjs`.
- **`Server`**, in `server/`: `npm ci`, `npm test`.
- **`CLI`**, in `cli/`: `go vet ./...`, `go test -count=1 ./...`, `go build ./cmd/floe`.
- **`Go formatting`**, from the repository root: `git ls-files -z '*.go' | xargs -0 gofmt -l` must print nothing (see Code Style for a CRLF checkout).
- **`Desktop`**, in `desktop/frontend/`: `npm ci`, `npm test`, `npm run build`. Then in `desktop/`: `go vet ./...`, `go test -count=1 ./...`. The packaging smoke needs Windows with the Wails CLI, NSIS and the Windows SDK: `wails build -s -nsis` in `desktop/`, then `desktop/build/msix/pack.ps1 -Version <X.Y.Z>`.
- **`E2E`**, in `client/`: `pnpm test:e2e` (see [End-to-end tests](#end-to-end-tests)).
- **`Back-compat`**, in `client/`: `FLOE_RELEASED_CLI=/path/to/released/floe pnpm exec playwright test e2e/back-compat.spec.ts`.
- **`Docker`**, from the repository root: `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build --wait`, then `curl --fail http://localhost:3001/health`.
- **`Lint workflows`**, from the repository root: `actionlint -color`, `shellcheck .github/scripts/*.sh` and `zizmor --offline .`. Install the zizmor version that `ZIZMOR_VERSION` in `ci.yml` names, because another version can report different findings. zizmor findings are fixed, not ignored: an exception goes in `.github/zizmor.yml` with a written reason, and the job refuses inline ignore comments.
- **`Skill test suites`**, from the repository root: `node --test ".claude/skills/**/*.test.mjs"`.

A change to `.github/workflows/` also meets two repository settings:

- Every `uses:` line names a full 40-character commit SHA, with the version as a comment after it, as the existing lines do (`uses: actions/checkout@<sha> # vX.Y.Z`). zizmor in `Lint workflows` checks this one in advance.
- Only GitHub's own actions and the six third-party ones the workflows already use may run: `pnpm/action-setup`, `goreleaser/goreleaser-action`, and `docker/setup-buildx-action`, `docker/login-action`, `docker/metadata-action` and `docker/build-push-action`. No job checks this one in advance.

A workflow that breaks either one fails to start, before any of its jobs run, and the run's page shows a message that names the rule. If your change needs another action, say so in the pull request, and the maintainer decides whether to allow it.

---

## Code Style

- TypeScript for all new client code
- Match the formatting of the surrounding code, and lint before pushing: `pnpm lint` (in `client/`)
- Do not run `npm run format`. There is a root `.prettierrc`, but no CI job runs it and almost nothing in the repo is formatted to it: the config leaves `printWidth` at the default 80 against a codebase written to about 120, so it would reflow essentially every file in the repository. Formatting a file you are already editing is fine; reformatting one you are not is a diff nobody can review. (Measured on 2026-09-05: of 320 tracked files Prettier will parse, 315 are unformatted, and the 5 it accepts are lockfiles and generated JSON.)
- Go code is formatted with `gofmt`, and CI fails a pull request that leaves any tracked `.go` file unformatted. Run `gofmt -w` on the Go files you changed, or let your editor format on save. On a Windows checkout with CRLF line endings, `gofmt -l` flags every file it reads, formatted or not, so it is not a usable check there.
- Docs and Markdown are written in American English, with no em dashes and no en dashes. Inside `docs/`, a Vale check on Mintlify's side enforces both (`docs/.vale.ini` and the two rules in `docs/styles/Floe/`). Everywhere else it is a convention, and it covers the text a user can see in the product as well, with one check: the docs pre-flight above fails on an em or en dash in the root Markdown files, the Markdown under `.github/` and `unraid/`, `desktop/README.md`, `desktop/build/README.md` and `.goreleaser.yml`.
- Keep components focused and readable

---

## Reporting Bugs

Open an issue with:
- A clear description of the problem
- Steps to reproduce it
- What you expected vs. what happened

A security vulnerability is the exception: do not open an issue for one. Report it privately, as [SECURITY.md](SECURITY.md) describes.

## Suggesting Features

Open an issue and describe what you'd like and why it would be useful.

## Questions

Ask in [Discussions](https://github.com/jannskiee/floe/discussions). For bugs and concrete feature requests, open an issue. We are happy to help.

Thank you for contributing!
