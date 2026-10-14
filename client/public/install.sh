#!/usr/bin/env sh
# Floe CLI installer for macOS and Linux
# Usage: curl -fsSL https://floe.one/install.sh | sh
#        curl -fsSL https://floe.one/install.sh | FLOE_VERSION=vX.Y.Z sh
# Re-running upgrades an existing install in place.

set -e

REPO="jannskiee/floe"
BINARY="floe"

# Detect OS
OS="$(uname -s)"
case "${OS}" in
  Linux*)  GOOS="linux"  ;;
  Darwin*) GOOS="darwin" ;;
  *)
    echo "Unsupported OS: ${OS}" >&2
    echo "Download manually from https://github.com/${REPO}/releases" >&2
    exit 1
    ;;
esac

# Detect architecture
ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64|amd64)  GOARCH="amd64" ;;
  arm64|aarch64) GOARCH="arm64" ;;
  *)
    # Releases are built for these two only (.goreleaser.yml), so there is
    # nothing to download for any other processor: point at a build instead.
    echo "Unsupported architecture: ${ARCH}" >&2
    echo "Floe releases are built for 64-bit Intel and ARM only. With Go 1.26 or later, build it yourself:" >&2
    echo "  go install github.com/jannskiee/floe/cli/cmd/floe@latest" >&2
    echo "Or build from source: https://www.floe.one/docs/cli/installation#build-from-source" >&2
    exit 1
    ;;
esac

# Resolve version
if [ -z "${FLOE_VERSION}" ]; then
  printf "Fetching latest version... "
  FLOE_VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' | cut -d'"' -f4)"
  echo "${FLOE_VERSION}"
fi

if [ -z "${FLOE_VERSION}" ]; then
  echo "Could not determine latest version." >&2
  echo "Set FLOE_VERSION=vX.Y.Z to install a specific version, e.g.:" >&2
  echo "  curl -fsSL https://floe.one/install.sh | FLOE_VERSION=vX.Y.Z sh" >&2
  exit 1
fi

# The release tag carries a leading "v" (e.g. v1.5.2), but GoReleaser strips it
# from the archive name ({{ .Version }} -> 1.5.2). Normalize both forms so the
# download path uses the tag and the filename uses the bare version number.
case "${FLOE_VERSION}" in
  v*) TAG="${FLOE_VERSION}"; VERSION_NUM="${FLOE_VERSION#v}" ;;
  *)  TAG="v${FLOE_VERSION}"; VERSION_NUM="${FLOE_VERSION}" ;;
esac

ARCHIVE="floe_${VERSION_NUM}_${GOOS}_${GOARCH}.tar.gz"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${ARCHIVE}"
CHECKSUMS_URL="https://github.com/${REPO}/releases/download/${TAG}/checksums.txt"

# Work in a temp directory; clean up on exit
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "Downloading floe ${FLOE_VERSION} (${GOOS}/${GOARCH})..."
curl -fsSL "${DOWNLOAD_URL}" -o "${TMP_DIR}/${ARCHIVE}"
curl -fsSL "${CHECKSUMS_URL}" -o "${TMP_DIR}/checksums.txt"

# Verify SHA-256 checksum
EXPECTED="$(grep " ${ARCHIVE}" "${TMP_DIR}/checksums.txt" | awk '{print $1}')"
if [ -n "${EXPECTED}" ]; then
  HASH_COMPARED=1
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "${TMP_DIR}/${ARCHIVE}" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "${TMP_DIR}/${ARCHIVE}" | awk '{print $1}')"
  else
    echo "Warning: no sha256 tool found, skipping checksum verification." >&2
    ACTUAL="${EXPECTED}"
    HASH_COMPARED=0
  fi
  if [ "${ACTUAL}" != "${EXPECTED}" ]; then
    echo "Checksum verification failed!" >&2
    echo "  Expected: ${EXPECTED}" >&2
    echo "  Got:      ${ACTUAL}" >&2
    exit 1
  fi
  if [ "${HASH_COMPARED}" = 1 ]; then
    echo "Checksum verified."
  fi
else
  echo "Warning: checksum not found for ${ARCHIVE}, skipping verification." >&2
fi

# Extract binary from archive
tar xzf "${TMP_DIR}/${ARCHIVE}" -C "${TMP_DIR}"

if [ ! -f "${TMP_DIR}/${BINARY}" ]; then
  echo "Error: binary not found after extraction." >&2
  exit 1
fi

chmod +x "${TMP_DIR}/${BINARY}"

# Determine install directory. /usr/local/bin first, created when it is
# missing (some fresh macOS installs have none), with sudo when this user
# cannot write there. A sudo that cannot be used (this user is not allowed, or
# there is no terminal to ask for the password on) falls back to ~/.local/bin
# instead of stopping with nothing installed. Inside an if, a failed command
# does not end the script under set -e.
INSTALL_DIR="/usr/local/bin"
LOCAL_BIN="${HOME}/.local/bin"
INSTALLED=""
if { [ -d "${INSTALL_DIR}" ] || mkdir -p "${INSTALL_DIR}" 2>/dev/null; } && [ -w "${INSTALL_DIR}" ]; then
  mv "${TMP_DIR}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
  INSTALLED=1
elif command -v sudo >/dev/null 2>&1; then
  echo "Installing to ${INSTALL_DIR} (requires sudo)..."
  if sudo mkdir -p "${INSTALL_DIR}" && sudo mv "${TMP_DIR}/${BINARY}" "${INSTALL_DIR}/${BINARY}"; then
    INSTALLED=1
  else
    echo "Could not install with sudo, so installing to ${LOCAL_BIN} instead." >&2
  fi
fi

if [ -n "${INSTALLED}" ]; then
  echo "Installed floe ${FLOE_VERSION} to ${INSTALL_DIR}/${BINARY}"
else
  # Fall back to user-local bin
  mkdir -p "${LOCAL_BIN}"
  mv "${TMP_DIR}/${BINARY}" "${LOCAL_BIN}/${BINARY}"
  echo "Installed floe ${FLOE_VERSION} to ${LOCAL_BIN}/${BINARY}"
  # An earlier install the sudo above could not replace stays where it was,
  # and may come first on PATH. Said, never removed: deleting it needs the
  # same rights this run did not have.
  if [ -e "${INSTALL_DIR}/${BINARY}" ]; then
    echo "Note: an earlier floe is still at ${INSTALL_DIR}/${BINARY} and may run instead of this one. Remove it with: sudo rm ${INSTALL_DIR}/${BINARY}"
  fi
  case ":${PATH}:" in
    *":${LOCAL_BIN}:"*) ;;
    *)
      # The file the user's login shell reads. zsh, the macOS default, never
      # reads ~/.profile, and login bash skips it when ~/.bash_profile exists.
      case "${SHELL##*/}" in
        zsh) PROFILE_FILE=".zprofile" ;;
        bash)
          if [ -f "${HOME}/.bash_profile" ]; then
            PROFILE_FILE=".bash_profile"
          else
            PROFILE_FILE=".profile"
          fi
          ;;
        *) PROFILE_FILE=".profile" ;;
      esac
      echo ""
      echo "Note: ${LOCAL_BIN} is not in your PATH. Add it by running:"
      echo "  echo 'export PATH=\"\${HOME}/.local/bin:\${PATH}\"' >> ~/${PROFILE_FILE}"
      echo "Then reload your shell or open a new terminal."
      ;;
  esac
fi

echo ""
echo "Run 'floe version' to verify the installation."
