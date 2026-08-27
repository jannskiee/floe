# Tags and the workflows they fire

Read from the workflow files on `main` on 2026-08-28. When a workflow changes, reread it; this page describes, it does not decide.

| Trigger             | Workflow                                | Result                                                                                                  |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `v*` push           | `.github/workflows/release.yml`         | CLI release, marked Latest, plus package manager manifests                                              |
| `v*` push           | `.github/workflows/images.yml`          | `ghcr.io/jannskiee/floe-server` and `floe-client`, tagged `X.Y.Z`, `X.Y`, `latest`                      |
| `workflow_dispatch` | `.github/workflows/images.yml`          | Rebuilds and republishes the branch tags (`main`, `sha-*`) for the ref it runs on; `latest` never moves |
| `desktop-v*` push   | `.github/workflows/desktop-release.yml` | Desktop pre-release (exe, zip, `SHA256SUMS.txt`) and the MSIX artifact                                  |
| `workflow_dispatch` | `.github/workflows/desktop-release.yml` | Dry run: same build and checks, MSIX artifact still uploaded, nothing published                         |

## `v*` and release.yml

- GoReleaser is pinned to an exact `v2.17.1` (a range would resolve through a non-GitHub host inside the step that carries `TAP_GITHUB_TOKEN`); Dependabot does not bump action inputs, so raise it by hand when a release needs a newer one.
- `.goreleaser.yml` builds linux, darwin and windows for amd64 and arm64: six archives named `floe_X.Y.Z_<os>_<arch>` (zip on windows, tar.gz elsewhere) plus `checksums.txt`.
- `main.version` is `{{ .Version }}`, the tag WITHOUT the leading `v`, so a `v1.10.5` binary prints `floe 1.10.5`.
- The release is the repository's Latest. `/releases/latest` must keep resolving to a CLI release: the install scripts, `floe update` and the back-compat CI job depend on it, which is why the desktop series is a pre-release.
- The same run publishes the Homebrew cask (`jannskiee/homebrew-tap`), the Scoop manifest (`jannskiee/scoop-bucket`) and a PR to `microsoft/winget-pkgs` from the `jannskiee/winget-pkgs` fork, all through `TAP_GITHUB_TOKEN`.
- The `release-tags` ruleset forbids deletion, update and non-fast-forward on `refs/tags/v*`. A pushed `v*` tag is permanent, so confirm the push with the user first; a failed run is rerun in place with `gh run rerun <id> --failed`.

## `v*` and images.yml

- Runs on `v*` tags and on pushes to `main` that touch `client/`, `server/`, the workflow, or `.github/scripts/*.sh`, plus `workflow_dispatch`. Path filters are not evaluated for tag pushes, so a tag always publishes.
- Tags: `type=semver` gives `1.10.5` and `1.10`; the default `latest=auto` flavor moves `latest` only on a semver tag, never on a branch push or a dispatch; branch pushes and dispatches get `main` and `sha-<short>`.
- Four native legs (two images, amd64 and arm64) each push by digest and smoke-test before a single tag moves; both images publish together or not at all.

## `desktop-v*` and desktop-release.yml

- `windows-latest`. Frontend `npm ci`, `npm test`, `npm run build`, then `go test ./...` in `desktop/`, then `wails build -s -nsis`.
- The tag must be strictly numeric `desktop-vX.Y.Z` (NSIS `VIProductVersion` rejects suffixes) and the version is injected VERBATIM: `-X main.version=desktop-v0.2.8`.
- `desktop/wails.json` is stamped from the tag in the runner's working tree, never committed, so the committed `productVersion` only feeds the dispatch path. Bump it anyway so the tree matches what shipped.
- Assets: `floe-desktop-setup-$V.exe` (NSIS installer), `floe-desktop-$V-windows-amd64.zip` (exe plus LICENSE), `SHA256SUMS.txt` (LF endings on purpose, so `sha256sum -c` works). Published with `gh release create --verify-tag --prerelease --latest=false`; both flags are unconditional.
- The release body is boilerplate; /download's "Release notes" link points at the docs changelog instead.
- The MSIX is a workflow ARTIFACT, `floe-desktop-msix-<X.Y.Z>-run<run_number>`, built into `dist-msix/` so the release glob never attaches it. The run id comes from `gh run list --workflow desktop-release.yml`; fetch with `gh run download <id> -n <artifact-name>`.
- Publishing is the last step, so a failed run leaves no release. No ruleset protects `desktop-v*`: delete the tag and re-cut the same number. Once the Store has accepted a version, a lower Identity version is refused, so a shipped desktop number is never reused.

## `workflow_dispatch` on desktop-release.yml

Same steps, version read from `desktop/wails.json`, in-app version string `dev`, nothing published. The MSIX artifact (`floe-desktop-msix-<X.Y.Z>-run<run_number>`) still uploads, and the exe and zip land in `desktop-dryrun-run<run_number>`.

## Consumers of `DESKTOP_VERSION`

`client/lib/desktopRelease.ts` derives every desktop URL from it. Readers: `client/app/download/page.tsx` (/download, which also shows `DESKTOP_RELEASE_DATE`), `client/components/landing/DesktopSection.tsx` and `client/components/landing/AppWindow.tsx` (homepage), `client/lib/desktopRelease.test.ts` (shape, no future date, never `/releases/latest`), and the `Check desktop release assets` step in `.github/workflows/ci.yml`, which asks GitHub whether `desktop-v$DESKTOP_VERSION` carries all three assets before a bump can merge.

## Package managers

GoReleaser opens the winget-pkgs PR. A red `Validation-Installation-Error` there is usually an arm64 host timeout: verify the package, then close and reopen the PR (memory `project_winget_arm64_validation_flake`).
