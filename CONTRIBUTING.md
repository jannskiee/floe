# Contributing to Floe

Thank you for your interest in contributing! All contributions are welcome.

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork locally
3. Follow the setup below
4. Make your changes on a new branch
5. Submit a pull request with a clear description

---

## Development Setup

Floe has two parts: a **Next.js client** and a **Node.js signaling server**.

For most contributions (UI, pages, components), you only need to run the client. It connects to the live signaling server at `api.floe.one` by default.

### Client Only (Recommended for most contributors)

```bash
git clone https://github.com/YOUR_USERNAME/floe.git
cd floe/client

cp .env.example .env.local
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The client connects to `api.floe.one` automatically.

### Client + Server (Only needed if you're changing server code)

```bash
# Terminal 1 — Server
cd floe/server
cp .env.example .env
npm install
npm start

# Terminal 2 — Client
cd floe/client
cp .env.example .env.local
# Change NEXT_PUBLIC_SOCKET_URL to http://localhost:3001
npm install
npm run dev
```

---

## Environment Variables

### Client (`client/.env.local`)

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_SOCKET_URL` | Yes | Signaling server URL. Defaults to `https://api.floe.one` — no changes needed for UI contributions. |
| `NEXT_PUBLIC_SENTRY_DSN` | No | Your Sentry DSN for client-side error tracking. Leave empty to disable. |
| `SENTRY_DSN` | No | Your Sentry DSN for server-side error tracking. Leave empty to disable. |
| `SENTRY_ORG` | No | Your Sentry organization slug. |
| `SENTRY_PROJECT` | No | Your Sentry project slug. |
| `NEXT_PUBLIC_UMAMI_WEBSITE_ID` | No | Your Umami analytics website ID. Leave empty to disable. |

### Server (`server/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `CLIENT_URL` | Yes | Frontend origin for CORS (default: `http://localhost:3000`) |
| `PORT` | No | Signaling server port (default: `3001`) |
| `TURN_SECRET` | No | Shared secret for coturn HMAC credentials. Omit to use STUN-only (direct connections). |
| `TURN_DOMAIN` | No | Your TURN relay server domain. |

> **Note:** TURN is optional. Without it, only direct connections work — which is fine for local development and most home networks.

---

## Pull Request Process

1. Create a new branch: `git checkout -b your-branch-name`
2. Make your changes
3. Ensure the build passes: `npm run build` (in `client/`)
4. Run the linter: `npm run lint` (in `client/`)
5. Submit a pull request with a clear title and description

---

## Code Style

- TypeScript for all new client code
- Follow the existing formatting (Prettier is configured)
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

Feel free to open an issue — we're happy to help.

Thank you for contributing!
