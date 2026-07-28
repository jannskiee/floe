# Self-Hosting Floe

Run your own Floe instance (the web client and the signaling server) on your own
infrastructure, independent of `floe.one`. File data still flows peer-to-peer; the
server you run only brokers the WebRTC handshake.

Full documentation is at **[floe.one/docs/self-hosting](https://www.floe.one/docs/self-hosting)**,
including production deployment, reverse-proxy and TLS setup, and the complete
configuration reference.

## Quick start (Docker)

Both the client and the server ship with a `Dockerfile`, and `docker-compose.yml`
wires them together (plus an optional coturn relay).

```bash
git clone https://github.com/jannskiee/floe.git
cd floe
cp .env.docker.example .env
docker compose up -d --build
```

Open [http://localhost:3000](http://localhost:3000).

## Configuration

Everything is set in the `.env` file you copied above. The values that matter most:

| Variable | What it does |
| --- | --- |
| `NEXT_PUBLIC_SOCKET_URL` | URL the browser uses to reach your signaling server. |
| `NEXT_PUBLIC_SITE_URL` | Public URL of your client (canonical links, share previews, sitemap). |
| `PORT` | Host port the server is published on. |
| `CLIENT_PORT` | Host port the client is published on. |
| `CLIENT_URL` | Your client's origin, allowed by the server's CORS. Matched exactly. |
| `TRUSTED_PROXY_COUNT` | Reverse-proxy hops in front of the server. `0` direct, `1` behind a proxy. |
| `CLOUDFLARE_TURN_KEY_ID` / `CLOUDFLARE_TURN_KEY_API_TOKEN` | Optional managed TURN via Cloudflare (see below). |
| `TURN_SECRET` / `TURN_DOMAIN` | Optional self-hosted coturn credentials (see below). |

### Build-time variables (important)

`NEXT_PUBLIC_SOCKET_URL` and `NEXT_PUBLIC_SITE_URL` are inlined into the client
**at build time** (a Next.js behaviour, not specific to Floe). If you change either
one, rebuild the client image so the new value takes effect:

```bash
docker compose build client && docker compose up -d
```

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
