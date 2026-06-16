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
	"fmt"
	"io"
	"net/http"
	"os"
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
	if goos == "windows" {
		return fmt.Sprintf("floe_%s_%s_%s.zip", version, goos, goarch), "zip"
	}
	return fmt.Sprintf("floe_%s_%s_%s.tar.gz", version, goos, goarch), "tar.gz"
}

func assetName(version string) (string, string) {
	return AssetName(version, runtime.GOOS, runtime.GOARCH)
}

// Apply downloads, verifies the SHA-256 checksum, and replaces the running
// binary with the given version. On Windows the running executable is renamed
// out of the way before the new binary is moved into place.
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

	binaryTmp := exe + ".update"
	if err := extractBinary(archiveTmp, format, binaryTmp); err != nil {
		return fmt.Errorf("extraction failed: %w", err)
	}
	defer os.Remove(binaryTmp)

	return replaceBinary(exe, binaryTmp)
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

// --- binary replacement ---

func replaceBinary(exe, newBinary string) error {
	if runtime.GOOS == "windows" {
		// Windows disallows overwriting a running .exe but allows renaming it.
		// Rename the old binary out of the way, then rename the new one into place.
		bak := exe + ".bak"
		_ = os.Remove(bak)
		if err := os.Rename(exe, bak); err != nil {
			return fmt.Errorf("cannot rename current binary: %w", err)
		}
		if err := os.Rename(newBinary, exe); err != nil {
			_ = os.Rename(bak, exe) // attempt restore
			return fmt.Errorf("cannot install new binary: %w", err)
		}
		_ = os.Remove(bak)
		return nil
	}
	return os.Rename(newBinary, exe)
}
