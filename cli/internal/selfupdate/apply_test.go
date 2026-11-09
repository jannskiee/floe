package selfupdate

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const (
	applyVersion = "v1.2.3"
	oldBody      = "OLD"
	newBody      = "NEW"
)

// applyOnto is the only call of Apply in this file, so no test here can reach
// the real os.Executable: target is what it replaces.
func applyOnto(t *testing.T, target string) error {
	t.Helper()
	prev := executable
	t.Cleanup(func() { executable = prev })
	executable = func() (string, error) { return target, nil }
	return Apply(applyVersion)
}

// releaseAsset types the asset name out. Calling AssetName here would make the
// tests agree with a TrimPrefix bug in AssetName.
func releaseAsset() (name, format string) {
	if runtime.GOOS == "windows" {
		return fmt.Sprintf("floe_1.2.3_%s_%s.zip", runtime.GOOS, runtime.GOARCH), "zip"
	}
	return fmt.Sprintf("floe_1.2.3_%s_%s.tar.gz", runtime.GOOS, runtime.GOARCH), "tar.gz"
}

func targetBinary(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	name := "floe"
	if runtime.GOOS == "windows" {
		name = "floe.exe"
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(oldBody), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func sha256Of(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// releaseArchive builds a real release archive: LICENSE, README.md, then the
// binary named binaryName with body newBody. A zip on Windows, a tar.gz elsewhere.
func releaseArchive(t *testing.T, binaryName string) []byte {
	t.Helper()
	entries := []struct {
		name string
		body string
	}{
		{"LICENSE", "MIT"},
		{"README.md", "floe"},
		{binaryName, newBody},
	}
	if runtime.GOOS == "windows" {
		var buf bytes.Buffer
		zw := zip.NewWriter(&buf)
		for _, e := range entries {
			w, err := zw.Create(e.name)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := io.WriteString(w, e.body); err != nil {
				t.Fatal(err)
			}
		}
		if err := zw.Close(); err != nil {
			t.Fatal(err)
		}
		return buf.Bytes()
	}
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		hdr := &tar.Header{Name: e.name, Mode: 0o644, Size: int64(len(e.body))}
		if e.name == binaryName {
			hdr.Mode = 0o755
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(tw, e.body); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func archiveWithoutBinary(t *testing.T) []byte {
	t.Helper()
	entries := []struct {
		name string
		body string
	}{
		{"LICENSE", "MIT"},
		{"README.md", "floe"},
	}
	if runtime.GOOS == "windows" {
		var buf bytes.Buffer
		zw := zip.NewWriter(&buf)
		for _, e := range entries {
			w, err := zw.Create(e.name)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := io.WriteString(w, e.body); err != nil {
				t.Fatal(err)
			}
		}
		if err := zw.Close(); err != nil {
			t.Fatal(err)
		}
		return buf.Bytes()
	}
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		hdr := &tar.Header{Name: e.name, Mode: 0o644, Size: int64(len(e.body))}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(tw, e.body); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func binaryNameInRelease() string {
	if runtime.GOOS == "windows" {
		return "floe.exe"
	}
	return "floe"
}

// serveRelease answers checksums.txt and the asset from the maps; anything else
// is a 404. Bodies may be nil to force a 404 for that path.
func serveRelease(t *testing.T, files map[string][]byte) (asked func() []string) {
	t.Helper()
	return standInForGitHub(t, func(r *http.Request) (*http.Response, error) {
		body, ok := files[r.URL.String()]
		if !ok || body == nil {
			return &http.Response{
				StatusCode: http.StatusNotFound,
				Body:       io.NopCloser(strings.NewReader("not found")),
				Request:    r,
			}, nil
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(bytes.NewReader(body)),
			Request:    r,
		}, nil
	})
}

func checksumsURL() string {
	return fmt.Sprintf("%s/%s/checksums.txt", baseURL, applyVersion)
}

func assetURL(asset string) string {
	return fmt.Sprintf("%s/%s/%s", baseURL, applyVersion, asset)
}

func assertHolds(t *testing.T, path, want string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if string(got) != want {
		t.Fatalf("%s holds %q, want %q", path, got, want)
	}
}

func assertExecutable(t *testing.T, path string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Fatalf("%s is not executable: mode %v", path, info.Mode().Perm())
	}
}

// assertClean means nothing beside the target and no floe-update-* in os.TempDir().
func assertClean(t *testing.T, target string) {
	t.Helper()
	dir := filepath.Dir(target)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	base := filepath.Base(target)
	for _, e := range entries {
		if e.Name() != base {
			t.Errorf("unexpected leftover beside target: %s", e.Name())
		}
	}
	leftovers, err := filepath.Glob(filepath.Join(os.TempDir(), "floe-update-*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(leftovers) != 0 {
		t.Errorf("floe-update-* left in temp: %v", leftovers)
	}
}

func TestApplyInstallsACheckedRelease(t *testing.T) {
	asset, _ := releaseAsset()
	archive := releaseArchive(t, binaryNameInRelease())
	hash := sha256Of(archive)
	checksums := strings.Join([]string{
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  other.tar.gz",
		hash + "  " + asset,
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  another.zip",
		"",
	}, "\n")
	asked := serveRelease(t, map[string][]byte{
		checksumsURL():  []byte(checksums),
		assetURL(asset): archive,
	})

	target := targetBinary(t)
	if err := applyOnto(t, target); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	assertHolds(t, target, newBody)
	assertExecutable(t, target)
	want := []string{checksumsURL(), assetURL(asset)}
	if got := asked(); len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("asked %q, want exactly %q then %q", got, want[0], want[1])
	}
	assertClean(t, target)
}

func TestApplyRefusesABadRelease(t *testing.T) {
	asset, _ := releaseAsset()
	goodArchive := releaseArchive(t, binaryNameInRelease())
	goodHash := sha256Of(goodArchive)
	emptyArchive := archiveWithoutBinary(t)
	emptyHash := sha256Of(emptyArchive)
	halfArchive := goodArchive[:len(goodArchive)/2]
	halfHash := sha256Of(halfArchive)
	zeros := strings.Repeat("0", 64)
	binMissing := "floe not found in archive"
	if runtime.GOOS == "windows" {
		binMissing = "floe.exe not found in archive"
	}

	cases := []struct {
		name      string
		checksums string
		archive   []byte // nil means 404 for the asset
		errPrefix string
	}{
		{
			name:      "checksum mismatch",
			checksums: zeros + "  " + asset + "\n",
			archive:   goodArchive,
			errPrefix: "checksum mismatch for " + asset + ":",
		},
		{
			name:      "hash under another name",
			checksums: goodHash + "  other-name.tar.gz\n",
			archive:   goodArchive,
			errPrefix: "checksum not found in checksums.txt for " + asset,
		},
		{
			name:      "hash for asset.sbom.json",
			checksums: goodHash + "  " + asset + ".sbom.json\n",
			archive:   goodArchive,
			errPrefix: "checksum not found in checksums.txt for " + asset,
		},
		{
			name:      "no binary inside",
			checksums: emptyHash + "  " + asset + "\n",
			archive:   emptyArchive,
			errPrefix: "extraction failed: " + binMissing,
		},
		{
			name:      "truncated archive",
			checksums: halfHash + "  " + asset + "\n",
			archive:   halfArchive,
			errPrefix: "extraction failed:",
		},
		{
			name:      "checksums 404",
			checksums: "", // marker: serve nil body
			archive:   goodArchive,
			errPrefix: "failed to fetch checksums: HTTP 404",
		},
		{
			name:      "archive 404",
			checksums: goodHash + "  " + asset + "\n",
			archive:   nil,
			errPrefix: "download failed: HTTP 404",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			files := map[string][]byte{}
			if tc.name == "checksums 404" {
				files[checksumsURL()] = nil
			} else {
				files[checksumsURL()] = []byte(tc.checksums)
			}
			if tc.archive == nil {
				files[assetURL(asset)] = nil
			} else {
				files[assetURL(asset)] = tc.archive
			}
			serveRelease(t, files)

			target := targetBinary(t)
			err := applyOnto(t, target)
			if err == nil {
				t.Fatal("Apply succeeded; want an error")
			}
			if !strings.HasPrefix(err.Error(), tc.errPrefix) {
				t.Fatalf("error = %q, want prefix %q", err.Error(), tc.errPrefix)
			}
			assertHolds(t, target, oldBody)
			assertClean(t, target)
		})
	}
}

func TestExtractByName(t *testing.T) {
	// An archive holding floe (not floe.exe), exercised through both extractors
	// on every OS.
	tarGz := buildTarGzHolding(t, "floe", newBody)
	zipBytes := buildZipHolding(t, "floe", newBody)

	t.Run("tar.gz finds floe", func(t *testing.T) {
		dest := filepath.Join(t.TempDir(), "out")
		if err := extractFromTarGz(bytes.NewReader(tarGz), "floe", dest); err != nil {
			t.Fatalf("extractFromTarGz: %v", err)
		}
		assertHolds(t, dest, newBody)
	})
	t.Run("tar.gz refuses floe.exe", func(t *testing.T) {
		dest := filepath.Join(t.TempDir(), "out")
		err := extractFromTarGz(bytes.NewReader(tarGz), "floe.exe", dest)
		if err == nil || err.Error() != "floe.exe not found in archive" {
			t.Fatalf("error = %v, want floe.exe not found in archive", err)
		}
		if _, err := os.Stat(dest); !os.IsNotExist(err) {
			t.Fatalf("wrote a file on a miss: %v", err)
		}
	})
	t.Run("zip finds floe", func(t *testing.T) {
		archivePath := filepath.Join(t.TempDir(), "a.zip")
		if err := os.WriteFile(archivePath, zipBytes, 0o644); err != nil {
			t.Fatal(err)
		}
		dest := filepath.Join(t.TempDir(), "out")
		if err := extractFromZip(archivePath, "floe", dest); err != nil {
			t.Fatalf("extractFromZip: %v", err)
		}
		assertHolds(t, dest, newBody)
	})
	t.Run("zip refuses floe.exe", func(t *testing.T) {
		archivePath := filepath.Join(t.TempDir(), "a.zip")
		if err := os.WriteFile(archivePath, zipBytes, 0o644); err != nil {
			t.Fatal(err)
		}
		dest := filepath.Join(t.TempDir(), "out")
		err := extractFromZip(archivePath, "floe.exe", dest)
		if err == nil || err.Error() != "floe.exe not found in archive" {
			t.Fatalf("error = %v, want floe.exe not found in archive", err)
		}
		if _, err := os.Stat(dest); !os.IsNotExist(err) {
			t.Fatalf("wrote a file on a miss: %v", err)
		}
	})
}

func buildTarGzHolding(t *testing.T, name, body string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	hdr := &tar.Header{Name: name, Mode: 0o755, Size: int64(len(body))}
	if err := tw.WriteHeader(hdr); err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(tw, body); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func buildZipHolding(t *testing.T, name, body string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(w, body); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestSudoInstall(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sudoInstall is for Unix")
	}
	dir := t.TempDir()
	exe := filepath.Join(dir, "floe")
	if err := os.WriteFile(exe, []byte(oldBody), 0o755); err != nil {
		t.Fatal(err)
	}
	newBin := filepath.Join(t.TempDir(), "new")
	if err := os.WriteFile(newBin, []byte(newBody), 0o644); err != nil {
		t.Fatal(err)
	}

	sudoOK := filepath.Join(t.TempDir(), "sudo")
	if err := os.WriteFile(sudoOK, []byte("#!/bin/sh\nexec \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := sudoInstall(sudoOK, exe, newBin); err != nil {
		t.Fatalf("sudoInstall: %v", err)
	}
	assertHolds(t, exe, newBody)
	info, err := os.Stat(exe)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("mode = %v, want 0755", info.Mode().Perm())
	}
	assertClean(t, exe)

	// Restore OLD and try a failing sudo.
	if err := os.WriteFile(exe, []byte(oldBody), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(newBin, []byte(newBody), 0o644); err != nil {
		t.Fatal(err)
	}
	sudoFail := filepath.Join(t.TempDir(), "sudo")
	if err := os.WriteFile(sudoFail, []byte("#!/bin/sh\nexit 3\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	err = sudoInstall(sudoFail, exe, newBin)
	if err == nil || err.Error() != "sudo install failed: exit status 3" {
		t.Fatalf("error = %v, want sudo install failed: exit status 3", err)
	}
	assertHolds(t, exe, oldBody)
	assertClean(t, exe)
}

func TestApplyAsksSudoInAReadOnlyFolder(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sudo path is for Unix")
	}
	if os.Geteuid() == 0 {
		t.Skip("as root the install dir stays writable")
	}

	asset, _ := releaseAsset()
	archive := releaseArchive(t, binaryNameInRelease())
	hash := sha256Of(archive)
	checksums := hash + "  " + asset + "\n"
	serveRelease(t, map[string][]byte{
		checksumsURL():  []byte(checksums),
		assetURL(asset): archive,
	})

	target := targetBinary(t)
	folder := filepath.Dir(target)
	if err := os.Chmod(folder, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(folder, 0o755) })

	sudoDir := t.TempDir()
	sudoPath := filepath.Join(sudoDir, "sudo")
	script := fmt.Sprintf("#!/bin/sh\nchmod u+w %q\nexec \"$@\"\n", folder)
	if err := os.WriteFile(sudoPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", sudoDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	if err := applyOnto(t, target); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	assertHolds(t, target, newBody)
	assertClean(t, target)
}
