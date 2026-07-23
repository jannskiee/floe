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
| `FLOE_SOCKET_URL` | Runtime signaling URL override for a prebuilt client image. |
| `FLOE_SOCKET_PORT` | Runtime signaling port used with the browser hostname (default: `3001`). |
| `NEXT_PUBLIC_SITE_URL` | Public URL of your client (canonical links, share previews, sitemap). |
| `PORT` | Host port the server is published on. |
| `CLIENT_URL` | Your client's origin, allowed by the server's CORS. |
| `CLOUDFLARE_TURN_KEY_ID` / `CLOUDFLARE_TURN_KEY_API_TOKEN` | Optional managed TURN via Cloudflare (see below). |
| `TURN_SECRET` / `TURN_DOMAIN` | Optional self-hosted coturn credentials (see below). |

### Build-time variables (important)

`NEXT_PUBLIC_SOCKET_URL` and `NEXT_PUBLIC_SITE_URL` are inlined into the client
**at build time** (a Next.js behaviour, not specific to Floe). If you change either
one, rebuild the client image so the new value takes effect:

```bash
docker compose build client && docker compose up -d
```

Prebuilt client images can set `FLOE_SOCKET_URL` and `FLOE_SOCKET_PORT` at
runtime instead. Restart the container after changing them. If the URL is empty,
the client derives it from the hostname opened in the browser and the configured
port. See the [Unraid deployment guide](docs/self-hosting/unraid.mdx) for the
two-container setup.

## Connectivity: STUN vs TURN

- **STUN only (default).** Works for most networks. Peers connect directly and no
  file data passes through your server. Nothing extra to configure.
- **Managed TURN via Cloudflare (recommended).** Needed when both peers are behind
  strict NAT / CGNAT and cannot connect directly. Create a TURN key in the
  Cloudflare dashboard (Realtime > TURN Server), then set
  `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_KEY_API_TOKEN`. No public IP,
  extra ports, or TLS certificates needed. These take precedence over the coturn
  variables below.
- **Self-hosted TURN relay (coturn).** Prefer to run the relay yourself? Set
  `TURN_SECRET` and `TURN_DOMAIN`, then start the bundled coturn service:

  ```bash
  docker compose --profile turn up -d
  ```

  `TURN_SECRET` must match `static-auth-secret` in `coturn/turnserver.conf`.

## Without Docker

You can also run the two services directly. See the
[CONTRIBUTING guide](CONTRIBUTING.md) for the local dev setup (client on `:3000`,
server on `:3001`), and remember to point `NEXT_PUBLIC_SOCKET_URL` at your server.
