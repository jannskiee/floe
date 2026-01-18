<p align="center">
  <img src="client/app/icon.svg" alt="Floe" width="100" height="100" />
</p>

<h1 align="center">Floe</h1>

<p align="center">
  <strong>Secure, serverless peer-to-peer file transfer</strong>
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
  <a href="#installation">Installation</a> |
  <a href="#contributing">Contributing</a> |
  <a href="#sponsorship">Sponsor</a>
</p>

## About

Floe is an open-source, browser-based file transfer application that enables direct peer-to-peer connections between devices. Unlike traditional file sharing services, Floe does not upload files to any server. Files stream directly from the sender's device to the receiver's device using WebRTC technology.

This approach provides unlimited file sizes, enhanced privacy, and faster transfers without the overhead of server storage.

## Features

| Feature               | Description                                                    |
|-----------------------|----------------------------------------------------------------|
| Peer-to-Peer Transfer | Files transfer directly between devices without server storage |
| Unlimited File Size   | No restrictions on file size, limited only by device capacity  |
| End-to-End Encryption | All transfers are encrypted using WebRTC DTLS                  |
| No Registration       | No account creation required                                   |
| Multi-File Support    | Send multiple files in a single session                        |
| ZIP Download          | Download multiple files as a single archive                    |
| Real-Time Progress    | Live transfer speed, progress, and ETA display                 |
| Mobile Responsive     | Fully functional on all devices                                |

## How It Works

### Sender

1. Open Floe in your browser
2. Drag and drop files or click to select
3. Click "Create Link" to generate a shareable URL
4. Share the link with your recipient
5. Keep your browser tab open until the transfer completes

### Receiver

1. Open the shared link
2. Wait for the connection to establish
3. Click "Download" to receive files directly from the sender

The signaling server only helps browsers find each other. Once connected, all file data flows directly between browsers with no server involvement.

## Tech Stack

**Frontend:** Next.js, TypeScript, Tailwind CSS, shadcn/ui, simple-peer (WebRTC), Socket.IO Client

**Backend:** Node.js, Express, Socket.IO, Helmet

## Installation

### Prerequisites

- Node.js 18.x or higher
- npm 9.x or higher

### Setup

```bash
# Clone repository
git clone https://github.com/jannskiee/floe.git
cd floe

# Install and start server
cd server
npm install
npm start

# In a new terminal, install and start client
cd client
npm install
npm run dev
```

Open `http://localhost:3000` in your browser.

### Environment Variables

**Server** (`server/.env`):
```env
PORT=3001
CLIENT_URL=http://localhost:3000
```

**Client** (`client/.env.local`):
```env
NEXT_PUBLIC_SOCKET_URL=http://localhost:3001
```

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

If you encounter any bugs or have suggestions, please open an issue on GitHub.

## Sponsorship

Floe is a free and open-source project. All sponsorship contributions go toward backend hosting costs to ensure reliable service.

**[GitHub Sponsors](https://github.com/sponsors/jannskiee)**\
**[Ko-fi](https://ko-fi.com/jannskiee)**

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

## Acknowledgments

Built with [Next.js](https://nextjs.org/), [React](https://react.dev/), [shadcn/ui](https://ui.shadcn.com/), [Radix UI](https://www.radix-ui.com/), [Tailwind CSS](https://tailwindcss.com/), [WebRTC](https://webrtc.org/), [Socket.IO](https://socket.io/), and [simple-peer](https://github.com/feross/simple-peer).

<p align="center">
  <sub>Open source. Built for everyone.</sub>
</p>
