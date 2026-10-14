<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/floe-mark-dark.svg">
    <img src=".github/assets/floe-mark-light.svg" alt="Floe" width="100" height="100" />
  </picture>
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
  <a href="https://github.com/jannskiee/floe"><img src="https://img.shields.io/github/stars/jannskiee/floe?style=social" alt="Stars" /></a>
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

Floe sends files straight from one device to another. Nothing is uploaded to storage on the way, so both people have to be online at the same time.

It is open source and built on WebRTC. A small signaling server introduces the two devices and never stores, inspects, or decrypts file data. When the two devices cannot reach each other directly, an optional relay (a TURN server) passes the encrypted data along without being able to read it. A transfer through the relay is capped at 2 GB.

Each file is checked when it arrives: the receiver compares its size and, when the sender supplied one, a fingerprint of its contents (SHA-256), and discards a file that does not match (see [File checks](https://www.floe.one/docs/how-it-works/file-checks)). A file that passes both checks arrived intact. Floe does not scan files for malware.

The desktop app and the CLI contain no analytics or telemetry. Beyond the transfer itself, each sends only two things, both on by default and both easy to turn off:

- **An anonymous byte count**, which the receiving side reports to the public counter after a transfer. Turn it off with **Contribute to global stats** under Settings, **Privacy** in Floe Desktop, or with `--no-report` (or `FLOE_NO_STATS=1`) on `floe receive`.
- **An update check against GitHub.** The desktop app's installer and portable builds check when they start, and after a check that succeeds they wait a day before the next one; the Microsoft Store build never checks. The CLI checks only when you run `floe version`. Turn it off with **Check for updates** under Settings, **Privacy** in Floe Desktop, or with `FLOE_NO_UPDATE_CHECK=1` for either app.

The floe.one website itself runs cookieless, anonymous analytics (including transfer outcomes) and error monitoring, detailed in the [security and privacy docs](https://www.floe.one/docs/security-privacy).

The three apps speak the same transfer protocol, so any one can send to any other: the web app at [floe.one](https://floe.one), a Windows desktop app, and a Go CLI. Send from a browser tab and receive in the desktop app or the CLI, or any other combination, even across different networks.

For the design behind this, see the [overview](https://www.floe.one/how-it-works) and, in the docs, [How a transfer works](https://www.floe.one/docs/how-it-works/signaling).

## Quick start

1. Open [floe.one](https://floe.one) and pick a file.
2. Click **Create secure link**.
3. Send the link to the receiver (**Copy**), or let them scan it from your screen (**Show QR**).

The receiver opens the link in a browser, and the file comes across from your device, ready to save. Keep your tab open until it finishes. No account or installation is needed.

The [quickstart guide](https://www.floe.one/docs/quickstart) walks through sending and receiving your first file.

## Desktop

Floe Desktop runs on Windows 10 and 11 (x64) and is currently in Beta. The Microsoft Store build is signed by Microsoft and updates automatically.

<a href="https://apps.microsoft.com/detail/9NBQ8ZQ1065L"><img src="client/public/ms-store-badge.svg" alt="Download from the Microsoft Store" width="161" height="44" /></a>

Prefer a direct download? An installer and a portable build are on the [download page](https://www.floe.one/download). Setup details are in the [desktop installation guide](https://www.floe.one/docs/desktop/installation).

Request links (Beta) let one person send files straight to your PC.

- **To receive:** make a one-time link in Floe Desktop and send it to them. Nothing is saved until you accept, unless you turn on Auto-accept for that link. See [Request links](https://www.floe.one/docs/desktop/request-links).
- **To send through one:** open it in a browser, or run `floe send <files> --to <link>`. During the Beta the browser page is supported in current Chrome and Edge on a computer. See [Sending through a request link](https://www.floe.one/docs/web-app/request-links).

## CLI

Send and receive from terminals, servers, and scripts.

```sh
brew install --cask jannskiee/tap/floe        # macOS
winget install jannskiee.floe                 # Windows
curl -fsSL https://floe.one/install.sh | sh   # Linux, or macOS without Homebrew
```

Send with `floe send photo.jpg`, receive with `floe receive olive-tiger-castle`, and update with `floe update`. An install that Homebrew, Scoop, or winget owns updates through that package manager instead, and `floe update` prints the command to run.

Senders in the CLI and the desktop app produce both a short code and a browser link, so the receiver can join from any of the three apps.

`floe send <files> --to <link>` sends through a [request link](https://www.floe.one/docs/cli/send#send-through-a-request-link) made in Floe Desktop instead of creating a code.

Other install channels, checksum verification, and PATH setup are covered in [Install the CLI](https://www.floe.one/docs/cli/installation).

## Self-hosting

Prefer your own infrastructure? Prebuilt images on ghcr.io bring up the full stack in two commands, with no clone and no toolchain:

```sh
curl -fsSLO https://raw.githubusercontent.com/jannskiee/floe/main/docker-compose.yml
docker compose up -d
```

All three clients can point at a self-hosted server. Configuration, deployment behind HTTPS, and the optional TURN relay are covered in [SELF_HOSTING.md](SELF_HOSTING.md) and the [self-hosting docs](https://www.floe.one/docs/self-hosting/overview). Request links are off on a self-hosted server until a policy file (a small settings file on the server) turns them on: see [Turn on request links](https://www.floe.one/docs/self-hosting/request-links).

## Documentation

The [documentation](https://www.floe.one/docs) covers all three clients in depth, from your first transfer to a self-hosted deployment.

The [FAQ](https://www.floe.one/docs/faq) answers the questions that come up most, from transfer limits to privacy, and the [troubleshooting guide](https://www.floe.one/docs/troubleshooting) starts from the symptom when something will not connect. The [changelog](https://www.floe.one/docs/changelog) records every user-visible change to the web app, the desktop app, the CLI, and the self-hosted server.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, environment variables, and the pull request process. If you encounter a bug or have a feature suggestion, please open an [issue](https://github.com/jannskiee/floe/issues).

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Support

Floe is free and open source. Contributions help cover the ongoing costs of backend infrastructure that keeps the service accessible to everyone. This includes the signaling server for WebRTC connection negotiation and room management, and the relay that carries encrypted transfers for people whose networks block direct connections (strict firewalls or carrier-grade NAT).

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
