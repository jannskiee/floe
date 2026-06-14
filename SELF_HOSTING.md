# Self-Hosting Floe

Run your own Floe instance — the web client and the signaling server — on your own
infrastructure, independent of `floe.one`. This guide uses Docker Compose so the whole
stack comes up with a single command.

> **What you're hosting.** The signaling server only brokers WebRTC connection setup
> (offer/answer/ICE) and issues short-lived TURN credentials. **File data never passes
> through it** — transfers go peer-to-peer over encrypted WebRTC data channels. TURN is
> optional and only relays (still encrypted) traffic for peers that can't connect directly.

## Contents

- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [The build-time URL caveat](#the-build-time-url-caveat)
- [Production deployment](#production-deployment)
- [Optional: TURN relay (coturn)](#optional-turn-relay-coturn)
- [Using the CLI against your server](#using-the-cli-against-your-server)
- [Operations](#operations)
- [Self-hosting without Docker](#self-hosting-without-docker)

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose v2 (`docker compose`,
  bundled with modern Docker Desktop / Engine).

## Quick start

```bash
git clone https://github.com/jannskiee/floe.git
cd floe

cp .env.docker.example .env       # defaults work for a local single-machine run
docker compose up -d --build
```

Open <http://localhost:3000>. Open it in a second tab (or another device on your network,
pointing at the host's IP), start a transfer in one and join with the room code in the
other.

This runs **STUN-only**: direct peer-to-peer connections, which work on most home and mobile
networks. To support peers behind strict/symmetric NAT or CGNAT, add a
[TURN relay](#optional-turn-relay-coturn).

## Configuration

All settings live in the `.env` file you copied from `.env.docker.example`.

| Variable | Service | Required | Purpose |
|----------|---------|----------|---------|
| `NEXT_PUBLIC_SOCKET_URL` | client (build) | Yes | URL the **browser** uses to reach the signaling server. Inlined at build time — see [the caveat below](#the-build-time-url-caveat). |
| `PORT` | server | No | Host port the server is published on (default `3001`; the container always listens on 3001 internally). |
| `CLIENT_URL` | server | Yes (prod) | Frontend origin allowed by CORS. Set to your client's public URL. |
| `TRUSTED_PROXY_COUNT` | server | No | Number of trusted reverse-proxy hops in front of the server (for correct `X-Forwarded-For` parsing / rate limiting). `0` = direct, `1` = behind one proxy. |
| `TURN_SECRET` | server | No | Shared HMAC secret for coturn credentials. Empty = STUN-only. Must match coturn's `static-auth-secret`. |
| `TURN_DOMAIN` | server | No | Public hostname of your TURN server. Must match coturn's `realm`. |

## The build-time URL caveat

Next.js inlines `NEXT_PUBLIC_*` variables into the JavaScript bundle **at build time**, not
at runtime. `NEXT_PUBLIC_SOCKET_URL` is therefore baked into the client image when it's
built — setting it only in the running container has no effect.

**After changing `NEXT_PUBLIC_SOCKET_URL`, rebuild the client:**

```bash
docker compose build client
docker compose up -d
```

It must be a URL that **end-users' browsers** can reach — `http://localhost:3001` only works
when the browser runs on the same machine as the server. For anything else, use the server's
LAN IP or public URL (e.g. `https://api.your-domain.com`).

## Production deployment

For a real deployment beyond a single machine:

1. **Put both services behind a reverse proxy with HTTPS** (Nginx, Caddy, Traefik, or a
   platform like Render/Fly). Browsers require a secure context for the APIs Floe uses.
   Proxy the client (`:3000`) and the server (`:3001`) under hostnames you control, e.g.
   `app.your-domain.com` → client, `api.your-domain.com` → server.
2. **Set `NEXT_PUBLIC_SOCKET_URL`** to the server's public URL (e.g.
   `https://api.your-domain.com`) and rebuild the client.
3. **Set `CLIENT_URL`** to the client's public origin (e.g. `https://app.your-domain.com`)
   so CORS allows it.
4. **Set `TRUSTED_PROXY_COUNT`** to the number of proxy hops in front of the server so
   per-IP rate limiting sees real client IPs.

> **CORS note.** The server's allow-list also hard-codes the official `floe.one` origins
> (`server/server.js`). Your `CLIENT_URL` is honored alongside them, so this doesn't block
> anything — but if you'd prefer a clean allow-list for your fork, you can remove those
> hard-coded entries.

## Optional: TURN relay (coturn)

A TURN server relays the (still end-to-end encrypted) stream when two peers can't reach each
other directly — common with symmetric NAT or carrier-grade NAT. Without it, those specific
transfers fail; everything else still works.

TURN has real infrastructure requirements: a **public IP**, a **domain**, and **TLS
certificates**. The bundled `coturn` service uses host networking and is intended for a
Linux host with a public IP.

1. **Create the coturn config:**
   ```bash
   cp coturn/turnserver.conf.example coturn/turnserver.conf
   ```
   Edit it: set `static-auth-secret` to a strong random value, set `realm` to your TURN
   hostname, and point `cert`/`pkey` at your TLS certificate and key (mount them into the
   container — see the volume hint in `docker-compose.yml`).

2. **Match the server's env** in `.env`:
   ```
   TURN_SECRET=<the same value as static-auth-secret>
   TURN_DOMAIN=turn.your-domain.com
   ```

3. **Open the firewall ports** on the host: `3478` (STUN/TURN) and `5349` (TURNS), plus the
   UDP relay range from the config (`49152-65535` by default).

4. **Start the stack with the TURN profile:**
   ```bash
   docker compose --profile turn up -d --build
   ```

Verify with `curl http://localhost:3001/api/turn-credentials` — the response should now
include `turn:` / `turns:` entries in addition to STUN.

The server generates time-limited HMAC-SHA1 credentials (24-hour TTL) that coturn validates
against the shared secret, so no per-user accounts are needed.

## Using the CLI against your server

The Go CLI accepts a `--server` flag, so it can target your instance instead of `floe.one`:

```bash
floe send --server https://api.your-domain.com photo.jpg
floe receive --server https://api.your-domain.com olive-tiger-castle
```

## Operations

```bash
docker compose logs -f                 # tail logs
docker compose ps                      # status (server reports a health check)
docker compose pull && \
  docker compose up -d --build         # update to the latest code after `git pull`
docker compose down                    # stop and remove the stack
```

Health endpoints on the server: `GET /health` (liveness) and `GET /` (status).

## Self-hosting without Docker

If you'd rather run the components directly with Node, pnpm, and Go, the manual setup steps
and environment-variable reference are in [CONTRIBUTING.md](CONTRIBUTING.md#development-setup).
The same environment variables documented above apply.
