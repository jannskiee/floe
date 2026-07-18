#!/usr/bin/env sh
# Floe CLI installer for macOS and Linux
# Usage: curl -fsSL https://floe.one/install.sh | sh
#        curl -fsSL https://floe.one/install.sh | FLOE_VERSION=v1.2.0 sh
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
    echo "Unsupported architecture: ${ARCH}" >&2
    echo "Download manually from https://github.com/${REPO}/releases" >&2
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
  echo "  curl -fsSL https://floe.one/install.sh | FLOE_VERSION=v1.0.0 sh" >&2
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
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL="$(sha256sum "${TMP_DIR}/${ARCHIVE}" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "${TMP_DIR}/${ARCHIVE}" | awk '{print $1}')"
  else
    echo "Warning: no sha256 tool found, skipping checksum verification." >&2
    ACTUAL="${EXPECTED}"
  fi
  if [ "${ACTUAL}" != "${EXPECTED}" ]; then
    echo "Checksum verification failed!" >&2
    echo "  Expected: ${EXPECTED}" >&2
    echo "  Got:      ${ACTUAL}" >&2
    exit 1
  fi
  echo "Checksum verified."
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

# Determine install directory
INSTALL_DIR="/usr/local/bin"
if [ -w "${INSTALL_DIR}" ]; then
  mv "${TMP_DIR}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
  echo "Installed floe ${FLOE_VERSION} to ${INSTALL_DIR}/${BINARY}"
elif command -v sudo >/dev/null 2>&1; then
  echo "Installing to ${INSTALL_DIR} (requires sudo)..."
  sudo mv "${TMP_DIR}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
  echo "Installed floe ${FLOE_VERSION} to ${INSTALL_DIR}/${BINARY}"
else
  # Fall back to user-local bin
  LOCAL_BIN="${HOME}/.local/bin"
  mkdir -p "${LOCAL_BIN}"
  mv "${TMP_DIR}/${BINARY}" "${LOCAL_BIN}/${BINARY}"
  echo "Installed floe ${FLOE_VERSION} to ${LOCAL_BIN}/${BINARY}"
  case ":${PATH}:" in
    *":${LOCAL_BIN}:"*) ;;
    *)
      echo ""
      echo "Note: ${LOCAL_BIN} is not in your PATH. Add it by running:"
      echo "  echo 'export PATH=\"\${HOME}/.local/bin:\${PATH}\"' >> ~/.profile"
      echo "Then reload your shell or open a new terminal."
      ;;
  esac
fi

echo ""
echo "Run 'floe version' to verify the installation."
