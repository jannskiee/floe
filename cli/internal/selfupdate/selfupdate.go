// Package selfupdate provides version-check and binary self-replacement for the
// floe CLI. All operations use only the Go standard library.
package selfupdate

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	apiURL   = "https://api.github.com/repos/jannskiee/floe/releases/latest"
	baseURL  = "https://github.com/jannskiee/floe/releases/download"
	cacheTTL = 24 * time.Hour
)

// DetectPM returns the name of the package manager that owns the binary at
// exePath ("homebrew", "scoop", "winget"), or "" if not managed by a known PM.
// Exported so it can be unit-tested with arbitrary paths.
func DetectPM(exePath string) string {
	p := filepath.ToSlash(strings.ToLower(exePath))
	switch {
	// "caskroom" is Homebrew's default folder on an Intel Mac, /usr/local,
	// where a cask's file sits under /usr/local/Caskroom and no other word
	// here appears in its path.
	case strings.Contains(p, "homebrew") || strings.Contains(p, "cellar") || strings.Contains(p, "caskroom") || strings.Contains(p, "linuxbrew"):
		return "homebrew"
	case strings.Contains(p, "scoop"):
		return "scoop"
	case strings.Contains(p, "winget"):
		return "winget"
	}
	return ""
}

// PMPath returns the detected package manager for the currently running binary,
// or "" when not managed by a known package manager.
func PMPath() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return pmFor(exe, filepath.EvalSymlinks)
}

// pmFor is DetectPM for the path the process was started from and, when that
// names no package manager, for the file the path resolves to, which is the
// file Apply replaces. os.Executable resolves no link on macOS: it reports the
// command as it was run, and Homebrew on an Intel Mac puts that command at
// /usr/local/bin/floe, a link into /usr/local/Caskroom, so only the resolved
// path names Homebrew there. resolve is filepath.EvalSymlinks, a parameter so
// a test needs no link on disk; a path it cannot resolve is judged by the
// command's own path alone.
func pmFor(exe string, resolve func(string) (string, error)) string {
	if pm := DetectPM(exe); pm != "" {
		return pm
	}
	resolved, err := resolve(exe)
	if err != nil {
		return ""
	}
	return DetectPM(resolved)
}

// PMHint returns the upgrade command for the given PM name.
func PMHint(pm string) string {
	switch pm {
	case "homebrew":
		return "brew upgrade floe"
	case "scoop":
		return "scoop update floe"
	case "winget":
		return "winget upgrade jannskiee.floe"
	}
	return ""
}

// Apply downloads, verifies the SHA-256 checksum, and replaces the running
// binary with the given version. The new binary is extracted into a writable
// temp dir, then installed in place: directly when the install dir is writable,
// or via sudo when it is root-owned (e.g. /usr/local/bin). A version that is not
// a plain vX.Y.Z is refused with ErrUnexpectedTag before it can reach a URL.
func Apply(version string) error {
	if !IsReleaseTag(version) {
		return ErrUnexpectedTag
	}
	asset, format := assetName(version)
	assetURL := fmt.Sprintf("%s/%s/%s", baseURL, version, asset)
	checksumsURL := fmt.Sprintf("%s/%s/checksums.txt", baseURL, version)

	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot locate current executable: %w", err)
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return fmt.Errorf("cannot resolve executable path: %w", err)
	}

	checksums, err := fetchText(checksumsURL)
	if err != nil {
		return fmt.Errorf("failed to fetch checksums: %w", err)
	}

	archiveTmp, err := downloadTemp(assetURL)
	if err != nil {
		return fmt.Errorf("download failed: %w", err)
	}
	defer os.Remove(archiveTmp)

	if err := verifySHA256(archiveTmp, asset, checksums); err != nil {
		return err
	}

	// Extract the new binary into the OS temp dir, which is always writable.
	// The install dir itself may be root-owned (e.g. /usr/local/bin), so staging
	// there directly would fail with "permission denied".
	binaryTmp, err := os.CreateTemp("", "floe-update-*")
	if err != nil {
		return fmt.Errorf("cannot create temp file: %w", err)
	}
	binaryTmpPath := binaryTmp.Name()
	_ = binaryTmp.Close()
	defer os.Remove(binaryTmpPath)

	if err := extractBinary(archiveTmp, format, binaryTmpPath); err != nil {
		return fmt.Errorf("extraction failed: %w", err)
	}

	return installBinary(exe, binaryTmpPath)
}
