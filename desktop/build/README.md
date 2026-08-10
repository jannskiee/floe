# Build assets

What `wails build` and the packaging pipeline read from this directory:

- `bin/` - build output: `floe-desktop.exe` and the NSIS installer
  `floe-desktop-setup-<version>.exe`.
- `windows/` - Windows build inputs: `icon.ico` (regenerated from `appicon.png`
  if deleted), `info.json` (the exe's version resource: right-click the exe,
  Properties, Details), `wails.exe.manifest`, and `installer/` (the NSIS
  project).
- `msix/` - the Microsoft Store pipeline: the `AppxManifest.xml` template, the
  Store icon assets plus `gen-assets.ps1`, and `pack.ps1`, which packs the
  built exe into an UNSIGNED `.msix` for Partner Center. The Store re-signs it
  on publication; end users cannot install the unsigned package. Both CI's
  packaging smoke job and `desktop-release.yml` run this script.
- `darwin/` - Wails' default macOS plist templates. Unused: macOS builds have
  not shipped.
- `appicon.png` / `appicon.svg` - the source icon.
