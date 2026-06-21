// Package selfupdate provides version-check and binary self-replacement for the
// floe CLI. All operations use only the Go standard library.
package selfupdate

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	apiURL   = "https://api.github.com/repos/jannskiee/floe/releases/latest"
	baseURL  = "https://github.com/jannskiee/floe/releases/download"
	cacheTTL = 24 * time.Hour
)

// LatestVersion fetches the latest release tag from GitHub (e.g. "v1.2.0").
func LatestVersion() (string, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequest("GET", apiURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GitHub API returned %d", resp.StatusCode)
	}

	var rel struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return "", err
	}
	if rel.TagName == "" {
		return "", fmt.Errorf("no tag_name in GitHub API response")
	}
	return rel.TagName, nil
}

// CheckAvailable returns the latest version tag if it is newer than current,
// or "" if current is already up-to-date or the check could not complete.
// Results are cached in ~/.config/floe/update-check.json for 24 hours.
// Always returns "" when current == "dev" or FLOE_NO_UPDATE_CHECK=1.
func CheckAvailable(current string) string {
	if current == "dev" || os.Getenv("FLOE_NO_UPDATE_CHECK") == "1" {
		return ""
	}

	if cached, ok := fromCache(); ok {
		if CompareVersions(cached, current) > 0 {
			return cached
		}
		return ""
	}

	ch := make(chan string, 1)
	go func() {
		if v, err := LatestVersion(); err == nil {
			writeCache(v)
			ch <- v
		}
	}()

	select {
	case latest := <-ch:
		if CompareVersions(latest, current) > 0 {
			return latest
		}
	case <-time.After(1 * time.Second):
	}
	return ""
}

// CompareVersions returns 1 if a > b, -1 if a < b, 0 if equal.
// Accepts "vX.Y.Z" or "X.Y.Z" format.
func CompareVersions(a, b string) int {
	a = strings.TrimPrefix(a, "v")
	b = strings.TrimPrefix(b, "v")
	pa := strings.SplitN(a, ".", 3)
	pb := strings.SplitN(b, ".", 3)
	for i := range 3 {
		na, nb := 0, 0
		if i < len(pa) {
			na, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			nb, _ = strconv.Atoi(pb[i])
		}
		if na != nb {
			if na > nb {
				return 1
			}
			return -1
		}
	}
	return 0
}

// DetectPM returns the name of the package manager that owns the binary at
// exePath ("homebrew", "scoop", "winget"), or "" if not managed by a known PM.
// Exported so it can be unit-tested with arbitrary paths.
func DetectPM(exePath string) string {
	p := filepath.ToSlash(strings.ToLower(exePath))
	switch {
	case strings.Contains(p, "homebrew") || strings.Contains(p, "cellar") || strings.Contains(p, "linuxbrew"):
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
	return DetectPM(exe)
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

// AssetName returns (archive filename, format string) for the given platform.
// Exported for testing; callers within this package use assetName().
func AssetName(version, goos, goarch string) (string, string) {
	// Release tags carry a leading "v" (e.g. v1.2.0), but GoReleaser strips it
	// from the archive name (floe_1.2.0_...). Match the published asset name.
	v := strings.TrimPrefix(version, "v")
	if goos == "windows" {
		return fmt.Sprintf("floe_%s_%s_%s.zip", v, goos, goarch), "zip"
	}
	return fmt.Sprintf("floe_%s_%s_%s.tar.gz", v, goos, goarch), "tar.gz"
}

func assetName(version string) (string, string) {
	return AssetName(version, runtime.GOOS, runtime.GOARCH)
}

// Apply downloads, verifies the SHA-256 checksum, and replaces the running
// binary with the given version. The new binary is extracted into a writable
// temp dir, then installed in place: directly when the install dir is writable,
// or via sudo when it is root-owned (e.g. /usr/local/bin).
func Apply(version string) error {
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

// --- cache ---

type cacheEntry struct {
	CheckedAt time.Time `json:"checked_at"`
	Latest    string    `json:"latest"`
}

func cacheFilePath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "floe", "update-check.json")
}

func fromCache() (string, bool) {
	p := cacheFilePath()
	if p == "" {
		return "", false
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return "", false
	}
	var c cacheEntry
	if err := json.Unmarshal(data, &c); err != nil {
		return "", false
	}
	if time.Since(c.CheckedAt) > cacheTTL {
		return "", false
	}
	return c.Latest, true
}

func writeCache(latest string) {
	p := cacheFilePath()
	if p == "" {
		return
	}
	_ = os.MkdirAll(filepath.Dir(p), 0755)
	data, _ := json.Marshal(cacheEntry{CheckedAt: time.Now(), Latest: latest})
	_ = os.WriteFile(p, data, 0644)
}

// --- download & verify ---

func fetchText(url string) (string, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d fetching %s", resp.StatusCode, url)
	}
	b, err := io.ReadAll(resp.Body)
	return string(b), err
}

func downloadTemp(url string) (string, error) {
	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d fetching %s", resp.StatusCode, url)
	}

	f, err := os.CreateTemp("", "floe-update-*")
	if err != nil {
		return "", err
	}
	defer f.Close()

	if _, err := io.Copy(f, resp.Body); err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

func verifySHA256(filePath, assetFilename, checksums string) error {
	f, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	got := hex.EncodeToString(h.Sum(nil))

	for line := range strings.SplitSeq(checksums, "\n") {
		parts := strings.Fields(line)
		if len(parts) == 2 && parts[1] == assetFilename {
			if parts[0] == got {
				return nil
			}
			return fmt.Errorf("checksum mismatch for %s:\n  expected %s\n  got      %s", assetFilename, parts[0], got)
		}
	}
	return fmt.Errorf("checksum not found in checksums.txt for %s", assetFilename)
}

// --- extraction ---

func extractBinary(archivePath, format, destPath string) error {
	binaryName := "floe"
	if runtime.GOOS == "windows" {
		binaryName = "floe.exe"
	}

	switch format {
	case "tar.gz":
		f, err := os.Open(archivePath)
		if err != nil {
			return err
		}
		defer f.Close()
		return extractFromTarGz(f, binaryName, destPath)
	case "zip":
		return extractFromZip(archivePath, binaryName, destPath)
	default:
		return fmt.Errorf("unknown archive format: %s", format)
	}
}

func extractFromTarGz(r io.Reader, binaryName, destPath string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if filepath.Base(hdr.Name) == binaryName {
			return writeFile(tr, destPath)
		}
	}
	return fmt.Errorf("%s not found in archive", binaryName)
}

func extractFromZip(archivePath, binaryName, destPath string) error {
	r, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer r.Close()

	for _, f := range r.File {
		if filepath.Base(f.Name) == binaryName {
			rc, err := f.Open()
			if err != nil {
				return err
			}
			defer rc.Close()
			return writeFile(rc, destPath)
		}
	}
	return fmt.Errorf("%s not found in archive", binaryName)
}

func writeFile(r io.Reader, destPath string) error {
	out, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, r)
	closeErr := out.Close()
	if copyErr != nil {
		os.Remove(destPath)
		return copyErr
	}
	return closeErr
}

// --- binary installation ---

// installBinary places newBinary at exe, replacing the running executable.
// It works for user-owned install dirs (e.g. ~/.local/bin) without elevation,
// and falls back to sudo when the install dir is root-owned (e.g. /usr/local/bin).
func installBinary(exe, newBinary string) error {
	if runtime.GOOS == "windows" {
		return windowsInstall(exe, newBinary)
	}

	// Fast path: install without elevation. Works when the install dir is
	// writable by the current user.
	err := unixInstall(exe, newBinary)
	if err == nil {
		return nil
	}
	if !errors.Is(err, fs.ErrPermission) {
		return err
	}

	// The install dir is not writable, typically /usr/local/bin owned by root.
	dir := filepath.Dir(exe)
	if os.Geteuid() == 0 {
		return fmt.Errorf("permission denied writing to %s", dir)
	}
	sudo, lookErr := exec.LookPath("sudo")
	if lookErr != nil {
		return fmt.Errorf("%s is not writable and sudo is not available; "+
			"re-run as root, or reinstall with the install script", dir)
	}
	return sudoInstall(sudo, exe, newBinary)
}

// unixInstall stages a copy of newBinary alongside exe and atomically renames it
// into place. Renaming (rather than writing over exe) is required because a
// running executable cannot be opened for writing on Linux (ETXTBSY), and it
// makes the swap atomic. Staging in the same directory also keeps the rename on
// one filesystem. Returns an fs.ErrPermission error when the install dir is not
// writable, which the caller uses to decide whether to elevate.
func unixInstall(exe, newBinary string) error {
	staged, err := os.CreateTemp(filepath.Dir(exe), ".floe-update-*")
	if err != nil {
		return err
	}
	stagedPath := staged.Name()
	_ = staged.Close()
	defer os.Remove(stagedPath)

	if err := copyFile(newBinary, stagedPath, 0o755); err != nil {
		return err
	}
	return os.Rename(stagedPath, exe)
}

// sudoInstall completes the swap with elevated privileges. The download and
// extraction already ran as the normal user; only the final move needs root.
// It copies to a sibling (a new file, so the running binary is never opened for
// writing -> no ETXTBSY), fixes the mode, then atomically renames it over exe,
// all in a single sudo invocation (one password prompt).
func sudoInstall(sudo, exe, newBinary string) error {
	fmt.Printf("  %s is not writable; requesting sudo to install the update...\n", filepath.Dir(exe))
	const script = `cp "$1" "$2.new" && chmod 0755 "$2.new" && mv -f "$2.new" "$2"`
	cmd := exec.Command(sudo, "sh", "-c", script, "sh", newBinary, exe)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("sudo install failed: %w", err)
	}
	return nil
}

// windowsInstall stages the new binary next to exe (avoiding cross-volume
// renames), renames the running exe out of the way, then moves the new one in.
// Windows disallows overwriting a running .exe but allows renaming it.
func windowsInstall(exe, newBinary string) error {
	staged := exe + ".new"
	_ = os.Remove(staged)
	if err := copyFile(newBinary, staged, 0o755); err != nil {
		return err
	}
	bak := exe + ".bak"
	_ = os.Remove(bak)
	if err := os.Rename(exe, bak); err != nil {
		_ = os.Remove(staged)
		return fmt.Errorf("cannot rename current binary: %w", err)
	}
	if err := os.Rename(staged, exe); err != nil {
		_ = os.Rename(bak, exe) // attempt restore
		_ = os.Remove(staged)
		return fmt.Errorf("cannot install new binary: %w", err)
	}
	_ = os.Remove(bak)
	return nil
}

// copyFile copies src to dst, creating or truncating dst with the given mode.
func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	// Ensure the mode sticks even if umask trimmed it at create time.
	return os.Chmod(dst, mode)
}
