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
4. **Monorepo.** Browser, server, CLI, and desktop stay in one repo. The desktop
   releases on its own `desktop-vX.Y.Z` tag series, separate from the CLI's
   `vX.Y.Z` tags, because release.yml fires GoReleaser on any `v*` tag and a
   shared tag would republish the CLI on every desktop release. The desktop
   needs native OS runners (macOS, Windows, Linux) because Wails cannot cross
   compile, unlike the pure Go CLI.
5. **Protocol version source of truth** is `cli/engine/transfer/protocol.go`,
   mirrored once in `client/lib/transfer/protocol.ts`.

## Repo layout

```
cli/
  cmd/floe/            CLI binary (unchanged behavior)
  engine/              shared transfer engine (public)
    transfer/          protocol, sender, receiver, format  (ProtocolVersion here)
    peer/              Pion WebRTC setup
    signaling/         WebSocket signaling client
    ice/               STUN/TURN credential fetch
    code/              short room-code register and resolve
    serverurl/         normalizes user-supplied server URLs
    verify/            short authentication string from DTLS fingerprints
  internal/
    selfupdate/        CLI-only self updater (stays private)
desktop/               Wails app: imports cli/engine/...
  frontend/            web UI (shared design with client/)
  app.go               Go methods bound to the UI
  main.go              Wails bootstrap
go.work                ties cli + desktop for local dev
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
- [x] Full app builds: `wails build` produces a 16.5 MB exe (`desktop.exe` then,
      renamed `floe-desktop.exe` for release), engine linked
- [x] Proved interop: desktop received files sent from floe.one (browser) AND the `floe` CLI

### Phase 2 - Real app  [IN PROGRESS]
- [x] Send from desktop: native file picker (`SelectFiles`) + code/link via the engine sender, reported through Wails events (`send:code/status/done/error`)
- [x] Basic Send / Receive two-mode UI
- [x] Live progress bar (percent + bytes) via an engine progress callback (`SendFilesWithProgress`/`ReceiveFilesWithProgress`) plus throttled `send:progress`/`recv:progress` Wails events
- [x] Speed and ETA readout on the progress bar
- [x] Drag and drop files onto the window to send
- [x] Polished UI matching the web app's design: Tailwind v4 (`@tailwindcss/vite`, Vite 3->6 bump)
      + Geist fonts + lucide-react; dark zinc theme, elevated card, segmented tabs, custom toggle,
      dashed drop zone, mono room code + copy-link, polished progress/status (the verify
      row was later removed, see 3a), and a
      QR panel behind a Show QR toggle (react-qr-code; shipped, the earlier "deferred" note
      was stale). No Share button on Windows: WebView2 does not expose `navigator.share`,
      and the button is feature-gated on it.
- [x] Folder sends, a "Browse..." save-folder picker, and "Show in folder" after receive
- [x] OS notifications on transfer complete / failure (native Wails; auto toast AppUserModelID on Windows)
- [x] Self-hosting: a Server section in Settings (server address plus an optional web address for share
      links) persisted to `os.UserConfigDir()/floe/desktop.json`, with a Test button that probes
      `/health`, `/ws` and `/api/turn-credentials` from Go. Leave both blank to use Floe's own servers.
      The WebView cannot probe directly: `index.html` sets `connect-src 'self'`.
- [ ] System tray / minimize-to-tray (NOT in Wails v2 - `onhold`, deferred to the v3 migration). Transfers already keep running while the window is minimized.
- [ ] Dark mode toggle (the app already ships dark by default)
- [x] Update notice: GitHub builds check the releases list once a day and show a
      dismissible notice (notice only, nothing installs; Store builds never check)
- [ ] App auto-update (Sparkle on macOS, WinSparkle on Windows)

### Phase 3 - Security keystone (ecosystem wide)  [IN PROGRESS]

Why: WebRTC encrypts the data channel with DTLS, but the fingerprints are
exchanged through the signaling server, so a malicious/compromised server could
swap them and man-in-the-middle the "peer to peer" link (RFC 8827). The fix is to
verify the connection independently of the server.

**3a - Connection verification code  [MECHANISM DONE; UI REMOVED 2026-07-04]**
- [x] `engine/verify` derives a short code from both DTLS fingerprints
      (ZRTP / Signal "safety number" model); unit-tested (order-independent,
      case-insensitive, and a swapped fingerprint changes the code). RETAINED.
- [x] `engine/peer` exposes `Fingerprints()` parsed from the negotiated SDPs. RETAINED.
- [~] The user-facing verify code was REMOVED from all three UIs (CLI print,
      browser `verifyCode` block, desktop `VerifyRow`) because manual 8-digit
      comparison is friction almost no one uses. Removed 2026-07-04, restored
      briefly on 2026-08-14 (built, audited across all surface pairings, and
      live on floe.one for a few hours), then removed again the same day
      before the 0.2.4 / v1.10.1 tags, by the same friction call.
      `engine/verify` + `verify.ts` stay (tested, zero cost). PAKE (3b) is the
      intended replacement: it does the same MITM check automatically, so the
      human compare never comes back.

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
- [~] Shorten TURN credential TTL (24h -> 2h; REVERTED to 24h 2026-07-31: senders
      fetch ICE before an unbounded share-link wait and nothing refreshes, so the
      credential must outlive the wait, not the transfer)
- [~] "Hide my IP" mode: engine (`peer.WithRelayOnly()` -> `iceTransportPolicy: 'relay'`) and
      desktop (checkbox) shipped. The browser sender toggle did NOT: nothing in `client/`
      sets `iceTransportPolicy`, and a grep for `hideIP` there returns nothing, so the half
      this line used to claim was lost. The browser's only relay control is "Network relay
      fallback", which is the opposite switch (off = direct only). Documented as an
      asymmetry in `docs/how-it-works/relay-connection.mdx` rather than papered over.
      Follow-up: ship the browser toggle, sender and receiver.

**Hardening audited 2026-07-04 (already solid, no change needed):**
- [x] Receiver path-traversal: `transfer.safeJoin` strips volume names + `..`/`.`/empty
      segments and falls back to `received_file`; `TestSafeJoin` covers `../../etc/passwd`,
      `/etc/passwd`, `C:\...`, UNC `\\host\share\...`, dot-segments, empty. All pass.

**Character sanitizing (added 2026-08-19, the traversal audit above missed it):**
- [x] Traversal was solid, but `safeJoin` did no character filtering, so a name that is
      ordinary on Linux could not be represented on Windows. Measured on Windows 11 /
      go1.26.3: `backup:2026-08-19.log` wrote its payload to an NTFS alternate data stream
      and left a visible 0-byte file, `NUL` wrote to the null device and left nothing, and
      `what?.txt` could not be created at all, which aborted the rest of the batch. In every
      case `Write` returned the full count, so the receiver's byte-count integrity guard
      passed and the transfer reported success.
- [x] `evil.exe ` (trailing space) was the security half: the bytes landed on a real
      `evil.exe`, but `applyMOTW` then wrote `evil.exe :Zone.Identifier`, where the space is
      interior and survives, so the saved file carried no Mark of the Web and Windows applied
      neither SmartScreen nor Office Protected View. A sender chose that by picking a name.
- [x] Fixed by `sanitizeComponent(name, goos)`, called per component inside `safeJoin`'s
      existing loop and before its `..`/`.`/empty filter. Controls and Unicode bidi overrides
      go on every platform; the Win32 reserved characters, trailing dots and spaces, and
      device names are Windows-only, so Linux and macOS keep byte-exact names.
      `TestSanitizeComponent` pins every rule on all three target values, and
      `sanitize_windows_test.go` proves the on-disk result including the zone tag.
      Note the device-name rule matches the WHOLE component: `CON.txt` and `NUL.txt` create
      ordinary files on Windows 11, and only bare `NUL` swallows data, so the widespread
      stem-based rule would rename names that demonstrably work.
- [x] Client CVEs: overrides live in `client/pnpm-workspace.yaml`; `corepack pnpm audit`
      (prod + full) reports "No known vulnerabilities found."

**Robustness gap (found 2026-07-04)  [RESOLVED 2026-07]:** desktop `runSend` /
`ReceiveByCode` used to block indefinitely on peer-connect and WebRTC setup with no
timeout and no cancel. Fixed since: `CancelTransfer` (app.go) closes the signaling and
peer connections to unblock both flows, and role selection carries a 20s timeout on the
send and receive paths. The only remaining unbounded wait is the sender waiting for a
receiver, which is deliberate (share a link and wait) and cancellable.

### Phase 4 - Release pipeline
- [x] Release workflow: a plain `desktop-release.yml` on `desktop-v*` tags
      (Windows-only for the beta; GoReleaser adds nothing for a Wails NSIS
      build, and the native-runner matrix waits for the macOS/Linux era)
- [ ] Code signing for the GitHub builds (no current provider: SignPath Foundation
      declined; the Store MSIX is already re-signed by Microsoft)
- [ ] macOS notarization (deferred until the Apple Developer account is funded)
- [~] Installers: the NSIS .exe and portable zip ship on every `desktop-v*` tag;
      .dmg and .AppImage wait for the macOS/Linux era

### Phase 5 - Distribution
- [~] Winget already resolves the Store listing (`winget install --id 9NBQ8ZQ1065L
      --source msstore`); a community winget-pkgs manifest, Homebrew Cask, and
      Scoop wait for signed builds and their platforms
- [ ] Flathub, .deb/.rpm
- [x] Microsoft Store as MSIX, the primary Windows channel (see the Store plan
      below; the old "unpackaged Win32" idea was wrong: the EXE submission path
      requires a purchased certificate and delivers no updates, while only MSIX
      is re-signed free by Microsoft)
- [x] Homepage download buttons and the /download page (#235), and a five-page "Desktop"
      docs group: installation, sending, receiving, settings, keyboard-shortcuts

## Release history

Current release: `desktop-v0.2.7` (Microsoft Store 9NBQ8ZQ1065L + GitHub
pre-release), shipped 2026-08-19. Paired with CLI `v1.10.4`, because the data
channel fix they both carry is receiver-side and only protects a transfer once
the RECEIVING peer has it.

The list below is the verified order the first public release (0.1.0 beta)
actually followed. Steps 1-3 shipped the GitHub beta; the plan then pivoted
to the Microsoft Store as the primary Windows channel (see the Store plan
below), which replaced the old steps 4-8.

- [x] 1. Pre-tag fixes: one exe name (`floe-desktop`), product info block in
      wails.json, per-user NSIS install (no UAC prompt), uninstaller deletes the
      context-menu HKCU key, pinned WebView2 profile path (2026-08-01, verified
      by a live install/uninstall round-trip plus profile adoption)
- [x] 2. Desktop release workflow: fires on `desktop-v*` tags only, installs NSIS
      on the runner, injects the version via ldflags, publishes with
      `--prerelease` and `make_latest: false`, both now unconditional (the
      back-compat job, install scripts, and `floe update` all resolve "latest",
      and prereleases are structurally excluded from that endpoint).
      (2026-08-01, rehearsed end to end with a throwaway desktop-v0.0.0 tag)
- [x] 3. Tag `desktop-v0.1.0` with three assets: `floe-desktop-setup-0.1.0.exe`,
      `floe-desktop-0.1.0-windows-amd64.zip`, `SHA256SUMS.txt` (RELEASED
      2026-08-01; checksums, install round-trip, and a real CLI-to-desktop
      transfer verified on the shipped binary)

## Microsoft Store plan (the primary Windows channel)

Partner Center product "Floe Desktop", Store ID 9NBQ8ZQ1065L, identity
`JanCarloParedes.FloeDesktop` / `CN=5D497A40-D927-4850-8A83-E21F677E80E3`.
Registration was free; the Philippines is eligible for an individual account.
The Store re-signs MSIX with a Microsoft certificate, which is the only
zero-cost route to a warning-free install (no purchased certificate removes
the SmartScreen warning). GitHub releases continue in parallel, permanently:
the exe/zip serve Store-blocked machines and are the hotfix/rollback path
(LocalSend's Store ban is the cautionary precedent).

Versioning: the MSIX Identity Version's first octet cannot be 0 and the fourth
is reserved, so `pack.ps1` derives it mechanically as (major+1).minor.patch.0
(0.2.0 -> 1.2.0.0, 1.0.0 -> 2.0.0.0). The product's own 0.x string stays in
wails.json, the exe version resource, and all marketing. At tag time, bump
wails.json's `productVersion` and the concrete version examples in
docs/desktop/installation.mdx and docs/desktop/settings.mdx; the release workflow
rewrites wails.json only in the runner's working tree, so the committed value
goes stale otherwise. Bump `DESKTOP_VERSION` and `DESKTOP_RELEASE_DATE` in
client/lib/desktopRelease.ts in a follow-up only AFTER the release assets are
published: /download derives its links from them, and bumping early points the
page at assets that do not exist yet (0.2.2 and 0.2.3 both shipped this way).

Packaged-build behavior (verified empirically 2026-08-02 on a loose-layout
package of this app): the app's HKCU registry writes are virtualized into the
package's private hive (Explorer never sees them) while its file writes reach
the real `%APPDATA%\floe` (so the CLI-shared config and settings survive), and
the single-instance mutex crosses the package boundary (an NSIS build launched
alongside the Store build focuses it instead of starting). The "Send with
Floe" Explorer toggle is therefore hidden when packaged (`packaged_windows.go`
gates it, fail-open to unpackaged); everything else runs unchanged from one
binary.

- [x] a. Packaged detection + context-menu gating; MSIX manifest template,
      assets, and `desktop/build/msix/pack.ps1`; workflow packs an UNSIGNED
      .msix into a CI artifact (its only consumer is Partner Center; end users
      cannot install unsigned exe-activation packages)
- [x] b. Tag `desktop-v0.2.0`: GitHub release + MSIX artifact from one tag
      (released 2026-08-02; all three assets verified live, and the
      FloeDesktop_1.2.0.0_x64.msix artifact validated in Partner Center)
- [x] c. Partner Center submission, PRIVATE audience first (public->private is
      permanently forbidden): upload the .msix, category Utilities & tools >
      File managers, age ratings, privacy URL https://www.floe.one/privacy,
      support URL = GitHub issues, screenshots at 1366x768 or larger, and
      certification notes that explain testing with floe.one in a browser as
      the second peer (the desktop receive field accepts share links)
      (submitted 2026-08-02 to the private audience, in certification; every
      section re-verified against the saved state before submit)
- [x] d. Private beta, then promoted to PUBLIC. The listing is live: the detail
      URL answers 200, and winget resolves it
      (`winget install --id 9NBQ8ZQ1065L --source msstore`)
- [x] e. floe.one /download leads with the Store badge (aeed0b4)
- [ ] f. Each release after: false-positive form + VirusTotal link for the
      GitHub exe, never UPX-pack
- [ ] g. Each release after: write the changelog entry BEFORE tagging. Add it
      under `Unreleased` in `docs/changelog.mdx`, merge, then relabel it to
      `desktop-vX.Y.Z` with the date at tag time, the way the CLI already does
      (see commit b5bc70e). The generated GitHub release body is boilerplate and
      carries no account of what changed, and /download's "Release notes" link
      points at the docs changelog, so skipping this leaves that link empty.
      Tag the entry `["Desktop"]`; the full contract for labels, dates and tag
      values is the MDX comment at the top of `docs/changelog.mdx`.
      Then paste a plain-text condensation into Partner Center's "What's new in
      this version" (optional, 1500 characters, no markdown). A release with
      nothing a user can see gets no entry, which is the point of writing it by
      hand. Judge that by what reaches a user, not by whether code changed:
      `desktop-v0.2.1` did move the Store tile colour, so it earned the short
      entry it now has, whereas a release that is only CI or build plumbing
      earns nothing.
- [ ] h. Each release after: once the GitHub release is published, launch the
      PREVIOUS build and confirm the update notice fires and names the new
      version (the notice shipped in 0.2.3; the first release after it is the
      first time that code runs against reality).

## Feature roadmap (what makes it best in class)

**Must have (v1):** drag and drop send, folder send without zipping, receive
streamed to disk with progress, system tray with background receive, OS
notifications, pairing that interoperates with every surface (the web sends
link+QR, the CLI code+link, the desktop all three), auto-update, dark mode.

**Differentiators:** OS context-menu "Send with Floe" (shipped on Windows; the
Finder half waits for macOS), a LAN fast path via local discovery (mDNS) for
full-speed same-network transfers, send to self across your own devices, transfer
history (shipped in 0.1.0), resume of interrupted transfers, connection
verification words (from the PAKE), and a global hotkey with screenshot or
clipboard send (clipboard paste-to-send shipped in 0.1.0; the global hotkey
remains).

**Later:** saved contacts and devices, continuous folder sync, multi-peer send.

## Signing and distribution notes

- Windows: no free OSS signing route has accepted the project (SignPath Foundation
  declined). The Store MSIX is re-signed by Microsoft, which is the warning-free
  channel; GitHub builds ship unsigned, and paid OV signing (for example Certum)
  stays an option if the GitHub channel ever grows.
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
