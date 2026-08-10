<p align="center">
  <img src="client/app/icon.svg" alt="Floe" width="100" height="100" />
</p>

<h1 align="center">Floe</h1>

<p align="center">
  <strong>Encrypted peer-to-peer file transfer for the browser, desktop, and command line</strong>
</p>

<p align="center">
  <a href="https://github.com/jannskiee/floe/releases/latest"><img src="https://img.shields.io/github/v/release/jannskiee/floe?filter=v*&label=CLI" alt="CLI release" /></a>
  <a href="https://github.com/jannskiee/floe/releases"><img src="https://img.shields.io/github/v/release/jannskiee/floe?filter=desktop-v*&label=Windows&include_prereleases" alt="Desktop release" /></a>
  <a href="https://github.com/jannskiee/floe/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/jannskiee/floe/ci.yml?branch=main&label=build" alt="Build status" /></a>
  <a href="https://github.com/jannskiee/floe/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" /></a>
  <a href="https://github.com/jannskiee/floe/stargazers"><img src="https://img.shields.io/github/stars/jannskiee/floe?style=social" alt="Stars" /></a>
</p>

<p align="center">
  <a href="https://floe.one">Try Floe</a> ·
  <a href="https://www.floe.one/docs">Documentation</a> ·
  <a href="#desktop">Desktop</a> ·
  <a href="#cli">CLI</a> ·
  <a href="#self-hosting">Self-hosting</a> ·
  <a href="#contributing">Contributing</a>
</p>

## About

Floe is an open-source peer-to-peer file transfer application built on WebRTC. Files stream directly between devices; the signaling server negotiates connections and never stores, inspects, or decrypts file data. When a direct path is blocked, an optional TURN relay bridges the transfer while the data stays end-to-end encrypted. The only report a client sends about a transfer is an optional, anonymous byte count that powers the public counter, and every client can opt out. The floe.one website itself runs cookieless analytics and error monitoring, detailed in the [security and privacy docs](https://www.floe.one/docs/security-privacy).

Three clients share one wire protocol: the web app at [floe.one](https://floe.one), a Windows desktop app, and a Go CLI. Send from a browser tab and receive in the desktop app or the CLI, or any other combination, even across different networks.

For the design behind this, see [how it works](https://www.floe.one/how-it-works) and the [technical reference](https://www.floe.one/docs/how-it-works/signaling).

## Quick start

Open [floe.one](https://floe.one), pick a file, and share the generated link or QR code with the receiver. No account or installation required. The [quickstart guide](https://www.floe.one/docs/quickstart) walks through sending and receiving your first file.

## Desktop

Floe for Windows 10 and 11 (x64), currently in beta. The Microsoft Store build is signed and updates automatically.

<a href="https://apps.microsoft.com/detail/9NBQ8ZQ1065L"><img src="client/public/ms-store-badge.svg" alt="Download from the Microsoft Store" width="161" height="44" /></a>

Prefer a direct download? An installer and a portable build are on the [download page](https://www.floe.one/download). Setup details are in the [desktop installation guide](https://www.floe.one/docs/desktop/installation).

## CLI

Send and receive from terminals, servers, and scripts.

```sh
brew install --cask jannskiee/tap/floe        # macOS
winget install jannskiee.floe                 # Windows
curl -fsSL https://floe.one/install.sh | sh   # Linux and other systems
```

Send with `floe send photo.jpg`, receive with `floe receive olive-tiger-castle`, and update in place with `floe update`. Senders in the CLI and the desktop app produce both a short code and a browser link, so the receiver can join from any client.

Other install channels, checksum verification, and PATH setup are covered in the [CLI installation guide](https://www.floe.one/docs/cli/installation).

## Self-hosting

Prefer your own infrastructure? Prebuilt images on ghcr.io bring up the full stack in two commands, with no clone and no toolchain:

```sh
curl -fsSLO https://raw.githubusercontent.com/jannskiee/floe/main/docker-compose.yml
docker compose up -d
```

All three clients can point at a self-hosted server. Configuration, deployment behind HTTPS, and the optional TURN relay are covered in [SELF_HOSTING.md](SELF_HOSTING.md) and the [self-hosting docs](https://www.floe.one/docs/self-hosting/overview).

## Documentation

Everything else lives in the [documentation](https://www.floe.one/docs):

- [Quickstart](https://www.floe.one/docs/quickstart)
- [FAQ](https://www.floe.one/docs/faq)
- [Troubleshooting](https://www.floe.one/docs/troubleshooting)
- [Changelog](https://www.floe.one/docs/changelog)

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the pull request process, and open an [issue](https://github.com/jannskiee/floe/issues) for bugs or feature requests. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Support

Floe is free and open source. Contributions help cover the ongoing costs of backend infrastructure that keeps the service accessible to everyone. This includes the signaling server for WebRTC connection negotiation and room management, and the TURN relay service that provides encrypted relay for users behind strict firewalls or Carrier-Grade NAT.

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

MIT License, Copyright Jan Carlo Paredes. See [LICENSE](LICENSE) for details.

<p align="center">
  <sub>Open source. Built for everyone.</sub>
</p>
