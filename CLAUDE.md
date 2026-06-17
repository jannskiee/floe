# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Floe** is a browser-native, peer-to-peer file transfer app built on WebRTC. Three components work together:

- **`client/`** - Next.js 16 (React 19) web app
- **`server/`** - Node.js signaling server (Express + Socket.IO + WebSocket)
- **`cli/`** - Go CLI (`floe`) for headless transfers

File data never touches the server. WebRTC data channels carry it directly between peers. The server only brokers WebRTC signaling (offer/answer/ICE candidates) and optionally issues TURN relay credentials.

## Commands

### Client (Next.js)
```bash
cd client
pnpm install
pnpm dev         # dev server on :3000
pnpm build       # production build
pnpm lint        # ESLint
```

### Server (Node.js)
```bash
cd server
npm install
npm run dev      # nodemon auto-restart on :3001
npm start        # production
```

### CLI (Go)
```bash
cd cli
go build ./cmd/floe    # local binary
go test ./...          # run all tests
```

The CLI uses GoReleaser for cross-platform distribution; version is injected via `-ldflags "-X main.version=v..."`.

## Environment Setup

**Server** - copy `server/.env.example` to `server/.env`:
```
CLIENT_URL=http://localhost:3000
PORT=3001
TURN_SECRET=       # optional Coturn HMAC secret
TURN_DOMAIN=       # optional TURN server hostname
```

**Client** - copy `client/.env.example` to `client/.env.local`:
```
NEXT_PUBLIC_SOCKET_URL=http://localhost:3001
NEXT_PUBLIC_SENTRY_DSN=    # optional
```

## Architecture

### Signaling Flow
1. A peer joins a room (`join-room` event) → server assigns role: **sender** (first) or **receiver** (second).
2. When both peers are present, server emits `user-connected` to the sender.
3. Peers exchange WebRTC `signal` messages (offer → answer → ICE candidates) via the server.
4. Once WebRTC connects, the data channel is used directly (server is out of the loop).

Browser peers communicate via **Socket.IO**; CLI peers communicate via **WebSocket at `/ws`**. Both share the same `rooms` registry on the server (`Map<roomId, [peer, peer]>`), so browser-to-CLI transfers work transparently.

### Room Codes
`POST /api/code` registers a short human-readable phrase (e.g. `olive-tiger-castle`) mapping to a room ID with 10-min TTL. `GET /api/code/:code` resolves it. Words come from `server/words.json`.

### TURN Credentials
`GET /api/turn-credentials` issues short-lived (24h) Coturn HMAC-SHA1 credentials. Called by both client and CLI before connecting. If `TURN_SECRET` is unset, only STUN is returned.

### Rate Limiting
Two independent per-IP limiters, each over a 60s window, tracked in plain `Map`s and cleaned every 60s. Connection limiter: 30 per IP, shared across Socket.IO and WebSocket connections (`checkRateLimit`). TURN endpoint: a separate 20 requests per IP for `GET /api/turn-credentials` (`turnRateLimits`).

### React Strict Mode is intentionally disabled
`next.config.mjs` sets `reactStrictMode: false`. Strict Mode's double-mount breaks Socket.IO connections and `simple-peer` instances. All socket/peer logic uses refs and cleanup functions to handle component lifecycle correctly.

### Key Client Modules
- `client/components/P2PTransfer.tsx` - entire transfer UI (role detection, file selection, progress, download)
- `client/hooks/useWakeLock.ts` - Screen Wake Lock API wrapper (prevents device sleep during transfers)
- `client/lib/transferUtils.ts` - `formatSpeed()` and `formatETA()` used by the progress display

### CLI Internal Packages
All under `cli/internal/`:
- `signaling/` - WebSocket client for the `/ws` endpoint
- `peer/` - WebRTC peer setup via Pion
- `transfer/sender.go` / `transfer/receiver.go` - binary protocol over the data channel
- `ice/` - fetches STUN/TURN credentials from server
- `code/` - registers and resolves short room codes

## Writing Style

Do not use em dashes (--) in any markdown files or documentation. Use periods, commas, hyphens, or parentheses instead.
