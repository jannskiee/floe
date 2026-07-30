# Self-Hosting Floe

Run your own Floe instance (the web client and the signaling server) on your own
infrastructure, independent of `floe.one`. File data still flows peer-to-peer; the
server you run only brokers the WebRTC handshake.

Full documentation is at **[floe.one/docs/self-hosting](https://www.floe.one/docs/self-hosting)**,
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
| `FLOE_IMAGE_TAG` | Which published image tag to run. Defaults to `main`. |
| `NEXT_PUBLIC_SOCKET_URL` | URL the browser uses to reach your signaling server. |
| `PORT` | Host port the server is published on. |
| `CLIENT_PORT` | Host port the client is published on. |
| `CLIENT_URL` | Your client's origin, allowed by the server's CORS. Matched exactly. |
| `TRUSTED_PROXY_COUNT` | Reverse-proxy hops in front of the server. `0` direct, `1` behind a proxy. |
| `CLOUDFLARE_TURN_KEY_ID` / `CLOUDFLARE_TURN_KEY_API_TOKEN` | Optional managed TURN via Cloudflare (see below). |
| `TURN_SECRET` / `TURN_DOMAIN` | Optional self-hosted coturn credentials (see below). |

### Applying a change

`NEXT_PUBLIC_SOCKET_URL` is read at runtime, so changing where the browser looks
for your signaling server needs only a restart:

```bash
docker compose up -d
```

`NEXT_PUBLIC_SITE_URL` is the exception. It feeds canonical links, Open Graph
tags, and the sitemap, which Next renders into the page at build time, so a shared
image cannot carry it. The published client simply omits those tags rather than
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
single reverse proxy, route `/socket.io/`, `/ws`, `/api/`, and `/health` to the
server and everything else to the client, and the whole instance lives at one
address. That means one certificate and one URL to configure.

Copy-pasteable Caddy and nginx configuration is in
[the reverse proxy guide](https://www.floe.one/docs/self-hosting/reverse-proxy).

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
  cp coturn/turnserver.conf.example coturn/turnserver.conf
  docker compose --profile turn up -d
  ```

  `TURN_SECRET` must match `static-auth-secret` in `coturn/turnserver.conf`. Skip
  the copy and Docker creates a directory at that path and coturn fails to start.
  TURN needs its own ports and cannot be served through an HTTP reverse proxy; see
  [the TURN relay guide](https://www.floe.one/docs/self-hosting/turn-relay).

## Without Docker

You can also run the two services directly. See the
[CONTRIBUTING guide](CONTRIBUTING.md) for the local dev setup (client on `:3000`,
server on `:3001`), and remember to point `NEXT_PUBLIC_SOCKET_URL` at your server.
