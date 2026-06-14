<p align="center">
  <img src="client/app/icon.svg" alt="Floe" width="100" height="100" />
</p>

<h1 align="center">Floe</h1>

<p align="center">
  <strong>Secure, encrypted peer-to-peer file transfer</strong>
</p>

<p align="center">
  <a href="https://github.com/jannskiee/floe/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" />
  </a>
  <a href="https://github.com/jannskiee/floe/stargazers">
    <img src="https://img.shields.io/github/stars/jannskiee/floe?style=social" alt="Stars" />
  </a>
  <a href="https://github.com/jannskiee/floe/network/members">
    <img src="https://img.shields.io/github/forks/jannskiee/floe?style=social" alt="Forks" />
  </a>
  <a href="https://github.com/jannskiee/floe/issues">
    <img src="https://img.shields.io/github/issues/jannskiee/floe" alt="Issues" />
  </a>
</p>

<p align="center">
  <a href="https://floe.one">Quick Start</a> |
  <a href="#cli">CLI</a> |
  <a href="#contributing">Contributing</a> |
  <a href="#support">Support</a>
</p>

## About

Floe is an open-source peer-to-peer file transfer application built on WebRTC. Files stream directly between devices with no server storage, no accounts, and no registration required. When a direct path is unavailable due to network restrictions, a TURN relay server bridges the connection while maintaining end-to-end encryption.

A signaling server (`api.floe.one`) handles WebRTC negotiation and issues short-lived TURN credentials. It does not handle file data. No component in Floe's infrastructure stores, decrypts, or inspects transferred files.

## Quick Start

Visit [floe.one](https://floe.one) to transfer files directly in your browser. No account or installation required.

## How It Works

Files transfer directly between devices using WebRTC. A signaling server handles connection setup, then steps aside once both peers are connected. When a direct path cannot be established, an optional TURN relay bridges the connection with encrypted data that is never stored.

For a detailed explanation of the connection lifecycle, encryption model, and relay fallback, visit [floe.one/how-it-works](https://floe.one/how-it-works).

## CLI

Floe provides a command-line interface for transferring files from headless devices, servers, and automated workflows. The CLI connects to the same signaling infrastructure as the web app. Browser-to-CLI and CLI-to-browser transfers are fully supported.

### Install

Download the latest binary for your platform from the [Releases](https://github.com/jannskiee/floe/releases) page. No runtime or dependencies required.

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

For complete documentation, flags, and advanced usage, see the [CLI Documentation](https://docs.floe.one).


## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, environment variables, and the pull request process.

If you encounter a bug or have a feature suggestion, please open an [issue](https://github.com/jannskiee/floe/issues).

## Support

Floe is free and open source. Contributions help cover the ongoing costs of backend infrastructure that keeps the service accessible to everyone. This includes the signaling server for WebRTC connection negotiation and room management, and the TURN relay server for encrypted relay for users behind strict firewalls or Carrier-Grade NAT.

**[GitHub Sponsors](https://github.com/sponsors/jannskiee)**\
**[Ko-fi](https://ko-fi.com/jannskiee)**

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

<p align="center">
  <sub>Open source. Built for everyone.</sub>
</p>
