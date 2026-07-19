<p align="center">
  <img src="client/app/icon.svg" alt="Floe" width="100" height="100" />
</p>

<h1 align="center">Floe</h1>

<p align="center">
  <strong>Secure, encrypted peer-to-peer file transfer</strong>
</p>

<p align="center">
  <a href="https://github.com/jannskiee/floe/releases/latest"><img src="https://img.shields.io/github/v/release/jannskiee/floe" alt="Latest release" /></a>
  <a href="https://github.com/jannskiee/floe/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/jannskiee/floe/ci.yml?branch=main&label=build" alt="Build status" /></a>
  <a href="https://github.com/jannskiee/floe/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" /></a>
  <a href="https://github.com/jannskiee/floe/issues"><img src="https://img.shields.io/github/issues/jannskiee/floe" alt="Issues" /></a>
  <a href="https://github.com/jannskiee/floe/stargazers"><img src="https://img.shields.io/github/stars/jannskiee/floe?style=social" alt="Stars" /></a>
  <a href="https://github.com/jannskiee/floe/network/members"><img src="https://img.shields.io/github/forks/jannskiee/floe?style=social" alt="Forks" /></a>
</p>

<p align="center">
  <a href="https://floe.one">Try Floe</a> ·
  <a href="https://floe.one/how-it-works">How It Works</a> ·
  <a href="https://docs.floe.one">Documentation</a> ·
  <a href="#cli">CLI</a> ·
  <a href="#self-hosting">Self-Hosting</a> ·
  <a href="#contributing">Contributing</a>
</p>

## About

Floe is an open-source peer-to-peer file transfer application built on WebRTC. Files stream directly between devices with no server storage, no accounts, and no registration required. When a direct path is unavailable due to network restrictions, a TURN relay server bridges the connection while maintaining end-to-end encryption.

A signaling server (`api.floe.one`) handles WebRTC negotiation and issues short-lived TURN credentials. It does not handle file data. No component in Floe's infrastructure stores, decrypts, or inspects transferred files.

## Quick Start

[floe.one](https://floe.one) runs entirely in your browser. Open it, pick a file, and share the code or link. No account or installation required.

New to Floe? The [Quick Start guide](https://docs.floe.one/quickstart) walks through sending and receiving your first file.

## How It Works

Files transfer directly between devices using WebRTC. A signaling server handles connection setup, then steps aside once both peers are connected. When a direct path cannot be established, an optional TURN relay bridges the connection with encrypted data that is never stored.

For a plain-language overview, visit [floe.one/how-it-works](https://floe.one/how-it-works). For the full technical reference covering signaling, ICE and NAT traversal, encryption, and relay fallback, see the [documentation](https://docs.floe.one/how-it-works/signaling).

## CLI

Floe provides a command-line interface for transferring files from headless devices, servers, and automated workflows. The CLI connects to the same signaling infrastructure as the web app. Browser-to-CLI and CLI-to-browser transfers are fully supported.

### Install

**macOS**
```sh
brew install --cask jannskiee/tap/floe
```

**Windows**
```powershell
winget install jannskiee.floe
# or: scoop bucket add jannskiee https://github.com/jannskiee/scoop-bucket && scoop install floe
```

**Linux / any OS**
```sh
curl -fsSL https://floe.one/install.sh | sh
# Windows PowerShell: irm https://floe.one/install.ps1 | iex
```

No runtime or dependencies required. For Go devs: `go install github.com/jannskiee/floe/cli/cmd/floe@latest`. For all install options, checksum verification, and PATH setup, see the [installation guide](https://docs.floe.one/cli/installation).

### Update

```sh
floe update              # for script / manual installs
brew upgrade floe        # Homebrew
winget upgrade jannskiee.floe  # Winget
scoop update floe        # Scoop
```

### Usage

**Send a file:**
```sh
floe send photo.jpg
```

**Send multiple files or a folder:**
```sh
floe send file1.txt file2.pdf folder/
```

**Receive:**
```sh
floe receive olive-tiger-castle
```

The sender's terminal will display a room code and a browser link. The receiver can join using either the code (CLI) or the link (browser).

After a successful transfer, the receiver reports only the total byte count to Floe's signaling server to power the public "transferred globally" counter on the homepage. No file names or contents are included. The sender never reports. To opt out:

```sh
floe receive olive-tiger-castle --no-report   # single transfer
FLOE_NO_STATS=1 floe receive ...              # permanent (add to shell profile)
```

The global total is visible only in the browser. The CLI contributes to it but never displays it.

For all commands, flags, and advanced usage, see the [documentation](https://docs.floe.one).

## Self-Hosting

Prefer to run your own instance instead of using `floe.one`? The web client and signaling server ship with Docker support, so the full stack comes up with one command:

```sh
cp .env.docker.example .env
docker compose up -d --build
```

This runs the client on `:3000` and the signaling server on `:3001` (STUN-only, which works on most networks). See **[SELF_HOSTING.md](SELF_HOSTING.md)** for configuration, production deployment behind HTTPS, and the optional TURN relay.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, environment variables, and the pull request process.

If you encounter a bug or have a feature suggestion, please open an [issue](https://github.com/jannskiee/floe/issues).

## Support

Floe is free and open source. Contributions help cover the ongoing costs of backend infrastructure that keeps the service accessible to everyone. This includes the signaling server for WebRTC connection negotiation and room management, and the TURN relay server that provides encrypted relay for users behind strict firewalls or Carrier-Grade NAT.

**[GitHub Sponsors](https://github.com/sponsors/jannskiee)**\
**[Ko-fi](https://ko-fi.com/jannskiee)**

## Acknowledgments

Floe is supported by open source sponsorship programs that donate the tools and infrastructure behind it:

- **Error monitoring** is generously provided by [Sentry](https://sentry.io) through [Sentry for Good](https://sentry.io/for/good/).
- **Documentation** is generously hosted by [Mintlify](https://mintlify.com) through the [Mintlify OSS Program](https://mintlify.com/oss-program).
- **Development** is supported by [Claude](https://claude.com/claude-code) through Anthropic's open source program.

Thank you to these programs for helping keep Floe sustainable as an independent open source project.

<p align="center">
  <a href="https://sentry.io"><img src="https://img.shields.io/badge/Monitored%20by-Sentry-362D59?logo=sentry&logoColor=white" alt="Monitored by Sentry" /></a>
  <a href="https://mintlify.com"><img src="https://img.shields.io/badge/Docs%20by-Mintlify-18E299?logo=mintlify&logoColor=white" alt="Documentation by Mintlify" /></a>
  <a href="https://www.anthropic.com"><img src="https://img.shields.io/badge/Sponsored%20by-Anthropic-D97757?logo=anthropic&logoColor=white" alt="Sponsored by Anthropic" /></a>
</p>

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

<p align="center">
  <sub>Open source. Built for everyone.</sub>
</p>

