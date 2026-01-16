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

Floe is an open-source, browser-based file transfer application that enables direct peer-to-peer connections between
devices. Unlike traditional file sharing services, Floe does not upload files to any server. Files stream directly from
the sender's device to the receiver's device using WebRTC technology.

This approach provides unlimited file sizes, enhanced privacy, and faster transfers without the overhead of server
storage.

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

### Technical Overview

The signaling server facilitates peer discovery and WebRTC negotiation. Once connected, all file data flows directly
between browsers. No file data passes through or is stored on any server.

## Tech Stack

### Frontend

- Next.js 16
- TypeScript
- Tailwind CSS
- shadcn/ui
- simple-peer (WebRTC)
- Socket.IO Client
- fflate (ZIP compression)

### Backend

- Node.js
- Express
- Socket.IO
- Helmet (security headers)

## Installation

### Prerequisites

- Node.js 18.x or higher
- npm 9.x or higher

### Clone Repository

```bash
git clone https://github.com/jannskiee/floe.git
cd floe
```

### Install Dependencies

**Server:**

```bash
cd server
npm install
```

**Client:**

```bash
cd client
npm install
```

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

### Run Locally

Start the server:

```bash
cd server
npm start
```

Start the client (in a new terminal):

```bash
cd client
npm run dev
```

Open `http://localhost:3000` in your browser.

## Project Structure

```
floe/
├── client/                   # Next.js frontend
│   ├── app/                  # App Router pages
│   │   ├── page.tsx          # Home page
│   │   ├── layout.tsx        # Root layout
│   │   ├── icon.svg          # Application icon
│   │   ├── privacy/          # Privacy policy
│   │   └── terms/            # Terms of service
│   ├── components/           # React components
│   │   ├── P2PTransfer.tsx   # Main transfer component
│   │   ├── FileIcon.tsx      # File type icons
│   │   ├── layout/           # Layout components
│   │   └── ui/               # UI primitives
│   └── lib/                  # Utilities
│
├── server/                   # Signaling server
│   ├── server.js             # Main server
│   └── package.json
│
└── README.md
```

## Deployment

### Client (Vercel)

1. Connect your GitHub repository to Vercel
2. Set root directory to `client`
3. Add environment variable:
    - `NEXT_PUBLIC_SOCKET_URL`: Your deployed server URL

### Server (Render)

1. Create a Web Service on Render
2. Connect your GitHub repository
3. Set root directory to `server`
4. Build command: `npm install`
5. Start command: `node server.js`
6. Add environment variable:
    - `CLIENT_URL`: Your deployed client URL (e.g., `https://floe.one`)

## Security

### Transport Security

- WebRTC data channels use DTLS encryption
- All peer-to-peer traffic is encrypted end-to-end
- File data never passes through servers

### Server Security

- Helmet.js for secure HTTP headers
- CORS restricted to allowed origins
- Rate limiting: 10 connections per IP per minute
- UUID validation for room identifiers
- Input validation on all socket events

### Privacy

- No file storage on any server
- No user tracking or analytics
- No registration or personal data collection
- Connection data is ephemeral

## Contributing

Contributions are welcome from the community.

### How to Contribute

1. Fork the repository
2. Create a feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. Make your changes
4. Commit with a descriptive message:
   ```bash
   git commit -m "Add: description of change"
   ```
5. Push to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```
6. Open a Pull Request

### Reporting Issues

If you encounter any bugs or have suggestions for improvements, please open an issue on GitHub. Any feedback is
appreciated.

## Sponsorship

Floe is a free and open-source project.

### Fund Allocation

All sponsorship contributions are directed toward infrastructure costs:

**Primary Priority: Backend Hosting**

Sponsorship funds will be used to upgrade to a paid hosting plan for the signaling server. This ensures:

- Higher availability and uptime
- Improved connection reliability
- Support for increased concurrent users
- Faster signaling for quicker peer connections

### How to Sponsor

If you find Floe useful, please consider supporting its continued development:

**[Support on Ko-fi](https://ko-fi.com/jannskiee)**

Your contribution helps keep Floe running and freely available to everyone.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

## Acknowledgments

Built
with [Next.js](https://nextjs.org/), [React](https://react.dev/), [shadcn/ui](https://ui.shadcn.com/), [Radix UI](https://www.radix-ui.com/), [Tailwind CSS](https://tailwindcss.com/), [WebRTC](https://webrtc.org/), [Socket.IO](https://socket.io/),
and [simple-peer](https://github.com/feross/simple-peer).

<p align="center">
  <sub>Open source. Built for everyone.</sub>
</p>
