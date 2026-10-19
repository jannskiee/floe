# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Floe, please report it privately. Do not open a public issue, as that may expose the vulnerability before a fix is available.

There are two ways to report:

1. **GitHub Security Advisories (preferred):** Open the [Security tab](https://github.com/jannskiee/floe/security/advisories/new) and select "Report a vulnerability". This keeps the report private until a fix is released.
2. **Email:** Send the details to paredesjancarlo99@gmail.com.

Please include as much of the following as possible:

- A description of the vulnerability and its impact
- Steps to reproduce it
- The affected component, one of:
  - the web client or its request-link page
  - the signaling server
  - the CLI
  - Floe Desktop, and whether it came from the Microsoft Store or from a GitHub release
  - a container image
  - an install script
- The version you tested: the output of `floe --version` for the CLI, **App version** under Settings > About for Floe Desktop, or the image tag for a self-hosted server
- Any relevant logs, screenshots, or proof of concept

## What to Expect

- We will acknowledge your report as soon as possible.
- We will investigate and keep you informed of our progress.
- Once a fix is ready, we will release it and credit you in the advisory, unless you prefer to remain anonymous.

## Scope

This policy covers everything that ships from this repository:

- The web client, including the request-link page (`/r/...`) that a sender opens in a browser.
- The signaling server.
- The `floe` CLI and the shared transfer engine in `cli/engine/`, which Floe Desktop is built on too.
- Floe Desktop for Windows: the Microsoft Store build, and the installer and portable builds from GitHub releases.
- The container images for self-hosting, `ghcr.io/jannskiee/floe-server` and `ghcr.io/jannskiee/floe-client`.
- The CLI install scripts, `install.sh` and `install.ps1`, which the web client serves at floe.one.

The signaling server sets up connections and never carries file data. Files go straight between the two devices, encrypted end to end (WebRTC data channels). When a direct path is blocked, a relay (a TURN server) passes the encrypted data along and cannot read it. Floe infrastructure never stores or inspects file data.

## Supported Versions

Security fixes land on `main` and ship in the next release of the affected component. Please make sure you are on the most recent release of the component you are reporting against.

Floe has two release lines, and each component gets a fix through one of them:

| Component | How a fix reaches you |
| --- | --- |
| `floe` CLI | The next `v*` tag, which becomes the repository's Latest release. |
| Container images | The same `v*` tag publishes both images under the version number (for example `1.11.4`) and moves `latest`. Pull the new images, and move `FLOE_IMAGE_TAG` if you pinned a version. |
| Floe Desktop, installer and portable builds | The next `desktop-v*` tag, published on GitHub with the Pre-release label, which only keeps the CLI as the repository's Latest release. These builds do not update themselves; they show a notice when a newer release exists. |
| Floe Desktop, Microsoft Store build | Packed from the same `desktop-v*` tag and delivered by the Microsoft Store, which updates it automatically once the submission has passed Microsoft's certification. It can trail the GitHub release for that reason. |
| Web client at floe.one, including the request-link page and the install scripts | Always runs the newest `main`. |
| Floe's own signaling server at api.floe.one | The maintainer deploys `main` there before the `v*` tag that carries a server fix. There is nothing to update on your side. |
