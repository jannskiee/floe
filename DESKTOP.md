# Floe Desktop

Status tracker and plan for the Floe desktop app, the third surface alongside the
browser web app and the CLI. All three share one WebRTC wire protocol, so they
interoperate automatically (browser <-> CLI <-> desktop).

## Vision

A small, fast, native desktop app for sending and receiving files peer to peer,
with the conveniences a browser tab cannot offer: background transfers, a system
tray, drag and drop, folder sends without zipping, and OS notifications. It reuses
the same Go transfer engine as the CLI and the same visual design as the web app.

## Architecture decisions

1. **Framework: Wails v2 (stable).** A Go core with a system webview for the UI,
   chosen because it reuses the existing Go/Pion engine with no rewrite. (Tauri
   would force a Rust rewrite, Electron ships a 100 MB+ Chromium runtime.)
2. **WebRTC runs in Go, not the webview.** The webview is UI only. This sidesteps
   the broken WebRTC support in WebKitGTK on Linux and gives identical behavior on
   all three operating systems. File bytes flow from Pion to disk entirely in Go.
3. **Shared engine lives in `cli/engine/`** (public packages inside the existing
   `cli` module), not a separate module. A separate module would need a local
   `replace` directive, which breaks the public
   `go install github.com/jannskiee/floe/cli/cmd/floe@latest`. Keeping the engine
   in the `cli` module preserves `go install` with zero go.mod churn. The desktop
   app depends on the `cli` module and imports `cli/engine/...`.
4. **Monorepo.** Browser, server, CLI, and desktop stay in one repo. One
   `vX.Y.Z` tag releases the CLI plus the desktop. The desktop needs native OS
   runners (macOS, Windows, Linux) because Wails cannot cross compile, unlike the
   pure Go CLI.
5. **Protocol version source of truth** is `cli/engine/transfer/protocol.go`,
   mirrored once in `client/lib/transfer/protocol.ts`.

## Repo layout (target)

```
cli/
  cmd/floe/            CLI binary (unchanged behavior)
  engine/              shared transfer engine (public)
    transfer/          protocol, sender, receiver, format  (ProtocolVersion here)
    peer/              Pion WebRTC setup
    signaling/         WebSocket signaling client
    ice/               STUN/TURN credential fetch
    code/              short room-code register and resolve
  internal/
    selfupdate/        CLI-only self updater (stays private)
desktop/               Wails app (to be created): imports cli/engine/...
  frontend/            web UI (shared design with client/)
  app.go               Go methods bound to the UI
  main.go              Wails bootstrap
go.work                ties cli + desktop for local dev (to be added)
```

## Phases

### Phase 0 - Foundations  [DONE]
- [x] Install Wails v2 toolchain, verify `wails doctor` (system ready)
- [x] Extract shared engine from `cli/internal/` to `cli/engine/`
      (transfer, peer, signaling, ice, code)
- [x] Keep `selfupdate` private in `cli/internal/`
- [x] Update imports; CLI builds, vets, and passes all tests

### Phase 1 - Walking skeleton  [DONE]
- [x] Scaffold the Wails app in `desktop/`, depending on the `cli` module
- [x] Add `go.work` (use ./cli and ./desktop) plus a replace in desktop/go.mod
- [x] Bind a minimal "receive by code" Go method that uses the engine (`ReceiveByCode`)
- [x] Full app builds: `wails build` produces a 16.5 MB `desktop.exe`, engine linked
- [x] Proved interop: desktop received files sent from floe.one (browser) AND the `floe` CLI

### Phase 2 - Real app  [IN PROGRESS]
- [x] Send from desktop: native file picker (`SelectFiles`) + code/link via the engine sender, reported through Wails events (`send:code/status/done/error`)
- [x] Basic Send / Receive two-mode UI
- [x] Live progress bar (percent + bytes) via an engine progress callback (`SendFilesWithProgress`/`ReceiveFilesWithProgress`) plus throttled `send:progress`/`recv:progress` Wails events
- [x] Speed and ETA readout on the progress bar
- [x] Drag and drop files onto the window to send
- [ ] Polished UI sharing the web app's design (QR code, matching styles)
- [x] Folder sends, a "Browse..." save-folder picker, and "Show in folder" after receive
- [x] OS notifications on transfer complete / failure (native Wails; auto toast AppUserModelID on Windows)
- [ ] System tray / minimize-to-tray (NOT in Wails v2 - `onhold`, deferred to the v3 migration). Transfers already keep running while the window is minimized.
- [ ] Dark mode toggle (the app already ships dark by default)
- [ ] App auto-update (Sparkle on macOS, WinSparkle on Windows)

### Phase 3 - Security keystone (ecosystem wide)  [IN PROGRESS]

Why: WebRTC encrypts the data channel with DTLS, but the fingerprints are
exchanged through the signaling server, so a malicious/compromised server could
swap them and man-in-the-middle the "peer to peer" link (RFC 8827). The fix is to
verify the connection independently of the server.

**3a - Connection verification code  [DONE - all surfaces]**
- [x] `engine/verify` derives a short code from both DTLS fingerprints
      (ZRTP / Signal "safety number" model); unit-tested (order-independent,
      case-insensitive, and a swapped fingerprint changes the code)
- [x] `engine/peer` exposes `Fingerprints()` parsed from the negotiated SDPs
- [x] CLI prints "Verify NNNN NNNN" on send and receive; desktop shows it in the UI
- [x] Browser parity: the web app computes the same code from the SDP fingerprints
      (`client/lib/transfer/verify.ts`, unit-tested to match the Go canonical vector
      `1337 5359`) and shows it after connecting. Verification now works browser <-> CLI <-> desktop.

**3b - PAKE auto-verification (removes the human compare)**
- [ ] PAKE (CPace or SPAKE2) keyed by the room code, bound to the DTLS fingerprints,
      run over the data channel before any file bytes (magic-wormhole / croc model)
- [ ] Move room-word generation to the client so the server never learns the code
- [ ] Optional: wrap file bytes in AEAD under the PAKE key (defense in depth)
- [ ] Bump the protocol version in Go and TS together

**3c - Signed auto-updates**
- [ ] Sign `checksums.txt` (minisign or cosign, Ed25519), embed the public key,
      and verify the signature before applying in `internal/selfupdate`

**3d - Quick wins**
- [x] Dedupe/expand `server/words.json` (was 275 unique with 13 dupes; now 288 unique)
- [x] Shorten TURN credential TTL (24h -> 2h)
- [ ] Optional feature (not a bug): a "hide my IP" mode that sets `iceTransportPolicy: 'relay'`.
      The existing "Network Relay Fallback" toggle works as intended (relay on/off); it just
      isn't an IP-hiding mode.

### Phase 4 - Release pipeline
- [ ] `.goreleaser.desktop.yml` plus a native-runner matrix workflow
- [ ] Windows signing via SignPath Foundation
- [ ] macOS notarization (deferred until the Apple Developer account is funded)
- [ ] Build .dmg, .exe/.msi (NSIS), and .AppImage; attach to the same release

### Phase 5 - Distribution
- [ ] Homebrew Cask, Winget, Scoop (existing shared repos)
- [ ] Flathub, .deb/.rpm
- [ ] Microsoft Store (free, unpackaged Win32)
- [ ] Docs page and homepage download buttons

## Feature roadmap (what makes it best in class)

**Must have (v1):** drag and drop send, folder send without zipping, receive
streamed to disk with progress, system tray with background receive, OS
notifications, the same code/link/QR pairing as web and CLI, auto-update, dark mode.

**Differentiators:** OS context-menu "Send with Floe" (right click in Explorer or
Finder), a LAN fast path via local discovery (mDNS) for full-speed same-network
transfers, send to self across your own devices, transfer history, resume of
interrupted transfers, connection verification words (from the PAKE), and a global
hotkey with screenshot or clipboard send.

**Later:** saved contacts and devices, continuous folder sync, multi-peer send.

## Signing and distribution notes

- Windows: SignPath Foundation (free OSS OV signing), application submitted. The
  maintainer manages CLI signing separately; desktop signing is wired here.
- macOS: Apple Developer ID plus notarization ($99/yr), deferred. Until then, ship
  ad-hoc signed builds with right-click Open instructions.
- Linux: free. Flathub pins a consistent WebKitGTK runtime, ideal for a Wails app.
- Do not buy an EV certificate: since 2024 it no longer clears SmartScreen faster
  than OV.

## Dev commands

```
# Engine + CLI (from repo root, Go 1.20+ for the -C flag)
go -C cli build ./...
go -C cli test ./...

# Desktop (after Phase 1 scaffolding)
wails dev      # run the desktop app in dev mode with hot reload
wails build    # produce a native binary
```
