# Self-Hosting Floe

Run your own Floe instance (the web client and the signaling server) on your own
infrastructure, independent of `floe.one`. File data still flows peer-to-peer; the
server you run only brokers the WebRTC handshake.

Full documentation is at **[docs.floe.one/self-hosting](https://docs.floe.one/self-hosting)**,
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
| `CLIENT_URL` | Your client's origin, allowed by the server's CORS. |
| `TURN_SECRET` / `TURN_DOMAIN` | Optional relay credentials (see below). |

### Build-time variables (important)

`NEXT_PUBLIC_SOCKET_URL` and `NEXT_PUBLIC_SITE_URL` are inlined into the client
**at build time** (a Next.js behaviour, not specific to Floe). If you change either
one, rebuild the client image so the new value takes effect:

```bash
docker compose build client && docker compose up -d
```

## Connectivity: STUN vs TURN

- **STUN only (default).** Works for most networks. Peers connect directly and no
  file data passes through your server. Nothing extra to configure.
- **TURN relay (optional).** Needed when both peers are behind strict NAT / CGNAT
  and cannot connect directly. Set `TURN_SECRET` and `TURN_DOMAIN`, then start the
  bundled coturn service:

  ```bash
  docker compose --profile turn up -d
  ```

  `TURN_SECRET` must match `static-auth-secret` in `coturn/turnserver.conf`.

## Without Docker

You can also run the two services directly. See the
[CONTRIBUTING guide](CONTRIBUTING.md) for the local dev setup (client on `:3000`,
server on `:3001`), and remember to point `NEXT_PUBLIC_SOCKET_URL` at your server.
