# Self-hosting Floe

Run your own Floe instance (the web client and the signaling server) on your own
infrastructure, independent of `floe.one`. File data still flows peer-to-peer: the
signaling server you run sets up the connection and never carries the files.

Full documentation is at **[floe.one/docs/self-hosting/overview](https://www.floe.one/docs/self-hosting/overview)**,
including production deployment, reverse-proxy and TLS setup, and the complete
configuration reference.

## Quick start (Docker)

Prebuilt images are published to ghcr.io and `docker-compose.yml` pulls them, so
there is nothing to clone and no toolchain to install.

```bash
curl -fsSLO https://raw.githubusercontent.com/jannskiee/floe/main/docker-compose.yml
docker compose up -d
```

Open [http://localhost:3000](http://localhost:3000).

A `.env` file is optional; every value has a working default. To change something,
fetch the annotated example next to the compose file:

```bash
curl -fsSL https://raw.githubusercontent.com/jannskiee/floe/main/.env.docker.example -o .env
```

To build from source instead, add the overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## Configuration

Everything is set in an optional `.env` file next to the compose file. The values
that matter most:

| Variable | What it does |
| --- | --- |
| `FLOE_IMAGE_TAG` | Which published image tag to run, for the client and the server alike. Defaults to `latest`, the newest release. |
| `NEXT_PUBLIC_SOCKET_URL` | URL the browser uses to reach your signaling server. Leave it empty when both services share one domain. |
| `PORT` | Host port the server is published on. |
| `CLIENT_PORT` | Host port the client is published on. |
| `CLIENT_URL` | Your client's origin, matched exactly. The server allows it for browser requests (CORS) and for WebSocket connections, on Socket.IO and on `/ws`. |
| `TRUSTED_PROXY_COUNT` | Reverse-proxy hops in front of the server. `0` direct, `1` behind a proxy. |
| `CLOUDFLARE_TURN_KEY_ID` / `CLOUDFLARE_TURN_KEY_API_TOKEN` | Optional managed TURN via Cloudflare (see below). |
| `TURN_SECRET` / `TURN_DOMAIN` | Optional self-hosted coturn credentials (see below). |
| `POLICY_FILE` | Optional path, inside the container, of the policy file that turns request links on (see [Request links](#request-links)). Unset, or naming a file that does not exist, means request links are off. |

### Applying a change

`NEXT_PUBLIC_SOCKET_URL` is read at runtime, so changing where the browser looks
for your signaling server needs only a restart:

```bash
docker compose up -d
```

`NEXT_PUBLIC_SITE_URL` is the exception. It feeds canonical links, Open Graph
tags, and the sitemap, which Next renders into the page at build time, so a shared
image cannot carry it. The published client leaves its own address out of them (a
relative canonical link, no share-preview image, an empty sitemap) rather than
advertising a domain that is not yours. To set your own, build the client:

```bash
NEXT_PUBLIC_SITE_URL=https://files.example.com \
  docker compose -f docker-compose.yml -f docker-compose.build.yml build client
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d
```

This affects only SEO and link previews. Transfers, signaling, and the relay are
all configured at runtime.

## One domain (recommended for production)

You do not need two hostnames. Put the client and the signaling server behind a
single reverse proxy, route `/socket.io/`, `/ws`, `/api/` (except `/api/config`,
which belongs to the client), and `/health` to the server and everything else to
the client, and the whole instance lives at one address. That means one certificate and one URL to configure.

In `.env`, leave `NEXT_PUBLIC_SOCKET_URL` empty so the browser uses the address it
was loaded from, and tell the server its public address and that one proxy sits in
front of it:

```dotenv
NEXT_PUBLIC_SOCKET_URL=
CLIENT_URL=https://floe.example.com
TRUSTED_PROXY_COUNT=1
```

Set `TRUSTED_PROXY_COUNT` to the real number of proxies. Too high, and a client can
forge `X-Forwarded-For` to slip past the per-address rate limits. Too low, and every
user counts as the proxy's own address.

Copy-pasteable Caddy and nginx configuration is in
[the reverse proxy guide](https://www.floe.one/docs/self-hosting/reverse-proxy).

### Pass the `Host` header through

Since 1.11.0 the server checks the `Origin` of every WebSocket, on Socket.IO and on
`/ws`. It lets in a connection with no `Origin`, an `Origin` on its allow-list
(your `CLIENT_URL`, plus `https://floe.one`, `https://www.floe.one` and
`http://localhost:3000`, which are built in), and an `Origin` whose hostname is
the one in the request's `Host` header (with the same port too, when `Host`
carries one other than the scheme's default).

The last rule is the one the CLI and Floe Desktop rely on. They connect on `/ws`
and send the server address you gave them as their `Origin`. On one domain that
address is your `CLIENT_URL`, so nothing here needs attention. When they reach the
server on a hostname that is not your `CLIENT_URL` (a separate `api.` hostname, for
example), the proxy must pass the original `Host` header through. In nginx that is:

```nginx
proxy_set_header Host $host;
```

A proxy that rewrites `Host` to its upstream address, such as `localhost:3001`,
gets every CLI and desktop connection refused with `403`. The server logs one line
naming the `Origin` and the `Host` it compared, once per path until it restarts.
See [Production deployment](https://www.floe.one/docs/self-hosting/production)
for the two-hostname layout.

## Request links

[Request links](https://www.floe.one/docs/desktop/request-links) (Beta) let one
person send files straight to a PC running Floe Desktop. Your server offers them
only when a policy file says so. Without one they are off, and codes and share
links work as usual.

To turn them on, create `policy/policy.json` next to `docker-compose.yml` with the
content `{"requestLinks": true}`, uncomment the server's `volumes` example in
`docker-compose.yml` so the folder is mounted at `/app/policy`, set
`POLICY_FILE=/app/policy/policy.json` in `.env`, and run `docker compose up -d`.
`GET /health` then lists `"features":["request-1"]`. The server re-reads the file
every 60 seconds, so turning request links off again needs no restart.

Three things catch people out:

- Mount the folder, not the file. An edit puts a new file in place of the old one,
  and a mount of the single file keeps showing the old one.
- A `docker-compose.yml` downloaded before 1.11.0 does not pass `POLICY_FILE` to
  the server, so the setting does nothing. Download the current file first.
- With the default two ports, Floe Desktop needs **Share link address** (Settings,
  **Advanced**) set to the client's address, such as `http://<host>:3000`. Left
  blank, it builds the link from the server address, and the server does not serve
  the page a sender opens. On one domain, leave it blank.

The full steps, the limits, and the rule about matching versions are in
[Turn on request links](https://www.floe.one/docs/self-hosting/request-links).

## Connectivity: STUN vs TURN

- **STUN only (default).** Works for most networks. Peers connect directly and no
  file data passes through your server. Nothing extra to configure.
- **Managed TURN via Cloudflare (recommended).** Needed when both peers are behind
  strict NAT / CGNAT and cannot connect directly. Create a TURN key in the
  Cloudflare dashboard (Realtime > TURN Server), then set
  `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_KEY_API_TOKEN`. No public IP,
  extra ports, or TLS certificates needed. These take precedence over the coturn
  variables below.
- **Self-hosted TURN relay (coturn).** Prefer to run the relay yourself? Create the
  config first (it is gitignored because it holds your secret), set `TURN_SECRET`
  and `TURN_DOMAIN` in `.env`, then start the bundled coturn service:

  ```bash
  curl -fsSL --create-dirs -o coturn/turnserver.conf \
    https://raw.githubusercontent.com/jannskiee/floe/main/coturn/turnserver.conf.example
  docker compose --profile turn up -d
  ```

  `TURN_SECRET` must match `static-auth-secret` in `coturn/turnserver.conf`. Skip
  that download and Docker creates a **directory** at the path; coturn then starts
  anyway and reports healthy on built-in defaults with no auth secret, so relaying
  silently fails. The giveaway is `Default realm: localdomain` in its logs, and
  recovery needs `rmdir coturn/turnserver.conf` first, because copying onto a
  directory succeeds and writes the file inside it.
  TURN needs its own ports and cannot be served through an HTTP reverse proxy; see
  [the TURN relay guide](https://www.floe.one/docs/self-hosting/turn-relay).

## Upgrading to 1.11.0

1.11.0 fixes security issues in the signaling server, so move to it if you run an
older version:

```bash
docker compose pull
docker compose up -d
```

If you pinned `FLOE_IMAGE_TAG`, set it to `1.11.0` first. Then check four things:

- **The `Host` header.** The WebSocket origin check is new in this version. If the
  CLI or Floe Desktop reach your server through a proxy on a hostname that is not
  your `CLIENT_URL`, make sure the proxy
  [passes `Host` through](#pass-the-host-header-through), or they are refused with
  `403`. Browsers on your `CLIENT_URL`, a one-domain setup, and a server with no
  proxy in front of it are not affected.
- **Your `docker-compose.yml`.** Pulling images never changes it. A copy from before
  1.11.0 passes neither `POLICY_FILE` nor `MAX_FAILED_CODE_RESOLVES` to the server,
  so download the current file and copy your own changes across.
- **Matching versions.** Run the client and server images at the same version,
  because the page a request-link sender opens comes from the client. Compose does
  that by default: `FLOE_IMAGE_TAG` picks both.
- **Rate limits count by network.** Every per-address limit now counts an IPv6
  client by its /64, so everyone inside one /64 shares its limits, as users behind
  one IPv4 address always have. A port that a proxy appends to an address in
  `X-Forwarded-For` is dropped before counting. `MAX_FAILED_CODE_RESOLVES` is a new
  optional setting (default `10`): the failed room-code lookups allowed per address
  per 60 seconds. Every setting that existed before keeps its name and default.

Request links arrive in this version and stay off until you
[turn them on](#request-links). Everything else that changed is in the
[changelog](https://www.floe.one/docs/changelog).

## Without Docker

You can also run the two services directly with Node.js.
[Run without Docker](https://www.floe.one/docs/self-hosting/without-docker) has
the steps for a deployment, and the [CONTRIBUTING guide](CONTRIBUTING.md#development-setup)
has the local development setup (client on `:3000`, server on `:3001`).

For a deployment, `NEXT_PUBLIC_SOCKET_URL` is compiled into the bundle, so settle it
before `pnpm build`: your server's address, or empty when both services share one
domain. Set `NEXT_PUBLIC_SITE_URL` to your own address too: a client built this
way, outside Docker, with it unset puts `https://www.floe.one` in its canonical
links, share previews, and sitemap.
