package selfupdate

// Fetching a release asset and turning it into a binary on disk: naming,
// download, checksum verification and archive extraction.

import (
	"archive/tar"
	"archive/zip"
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
	"time"
)

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
