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
  <a href="https://floe.one">Live Demo</a> |
  <a href="#features">Features</a> |
  <a href="#contributing">Contributing</a> |
  <a href="#sponsorship">Sponsor</a>
</p>

## About

Floe is an open-source, browser-based file transfer application built on WebRTC. It does not upload or store files on any server. In most cases, files stream directly between browsers. When a direct path is unavailable due to network restrictions, a TURN relay server bridges the connection with end-to-end encryption.

A signaling server (`api.floe.one`) handles WebRTC negotiation and issues short-lived TURN credentials. It does not handle file data. A TURN relay server (`turn.floe.one`) routes encrypted data when a direct connection cannot be established. No component in Floe's infrastructure stores, decrypts, or inspects transferred files.

## Features

| Feature | Description |
|-----------------------|--------------------------------------------------------------------------------------|
| P2P Transfer | Files stream directly between devices with no server storage. |
| Relay Fallback | Automatic encrypted relay when a direct connection is unavailable. |
| End-to-End Encryption | All transfers use DTLS-SRTP encryption, whether direct or relayed. |
| No Registration | No account or sign-up required. |
| Multi-File + ZIP | Send multiple files and download them as a single archive. |

## How It Works

### Sender

1. Open Floe in your browser
2. Drag and drop files or click to select
3. Copy the generated link and share it with the recipient
4. Keep your browser tab open until the transfer completes

### Receiver

1. Open the shared link
2. Wait for the connection to establish
3. Click "Download" to receive files directly from the sender

### Connection Types

**Direct:** The signaling server introduces both browsers via WebRTC. Once connected, it steps aside and file data flows directly between devices. No size limits. No relay.

**Relay:** When a direct path cannot be established (e.g., strict corporate firewalls, Carrier-Grade NAT), Floe automatically falls back to a TURN relay server. File data passes through the relay in encrypted form and is never stored. Relay transfers are capped at 2 GB per session.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

If you encounter any bugs or have suggestions, please open an issue on GitHub.

## Sponsorship

Floe is a free and open-source project. Sponsorship contributions go toward hosting costs for the signaling server and TURN relay infrastructure, which are required to keep the service reliable and accessible.

**[GitHub Sponsors](https://github.com/sponsors/jannskiee)**\
**[Ko-fi](https://ko-fi.com/jannskiee)**

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

<p align="center">
  <sub>Open source. Built for everyone.</sub>
</p>
