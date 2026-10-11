# Build assets

What `wails build` and the packaging pipeline read from this directory:

- `bin/` - build output: `floe-desktop.exe` and the NSIS installer
  `floe-desktop-amd64-installer.exe` (renamed to `floe-desktop-setup-<version>.exe`
  on the GitHub release by desktop-release.yml).
- `windows/` - Windows build inputs: `icon.ico` (regenerated from `appicon.png`
  if deleted), `info.json` (the exe's version resource: right-click the exe,
  Properties, Details), `wails.exe.manifest`, and `installer/` (the NSIS
  project).
- `msix/` - the Microsoft Store pipeline: the `AppxManifest.xml` template, the
  Store icon assets plus `gen-assets.ps1`, and `pack.ps1`, which packs the
  built exe into an UNSIGNED `.msix` for Partner Center. The Store re-signs it
  on publication; end users cannot install the unsigned package. Both the
  packaging smoke in CI's `Desktop (Wails, windows-latest)` job and
  `desktop-release.yml` run this script.
  One of these assets is also compiled into the app:
  `assets/Square44x44Logo.targetsize-96.png` is embedded by
  `desktop/toast_windows.go` (`//go:embed`) as the icon of a Windows
  notification from the installer and portable builds. Rename or delete it and
  the Windows build of `desktop/` stops compiling.
- `darwin/` - Wails' default macOS plist templates. Unused: macOS builds have
  not shipped.
- `appicon.png` / `appicon.svg` - the source icon.
