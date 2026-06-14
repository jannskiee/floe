# Self-Hosting Floe

Run your own Floe instance (the web client and the signaling server) on your own infrastructure, independent of `floe.one`.

Full documentation is at **[docs.floe.one/self-hosting](https://docs.floe.one/self-hosting)**, including configuration reference, production deployment, TURN relay setup, and more.

## Quick start

```bash
git clone https://github.com/jannskiee/floe.git
cd floe
cp .env.docker.example .env
docker compose up -d --build
```

Open [http://localhost:3000](http://localhost:3000).
