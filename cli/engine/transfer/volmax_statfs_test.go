//go:build linux || darwin

package transfer

// The largest file a macOS or Linux volume holds, asked through the
// statfsName seam so a test can stand in a FAT volume. The build constraint
// above keeps this file to the two systems that answer through statfs.

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// stubStatfs makes statfsName answer as statfs does: fsName(p) for a path
// that exists, and ENOENT for one that does not.
func stubStatfs(t *testing.T, fsName func(p string) string) {
	t.Helper()
	orig := statfsName
	t.Cleanup(func() { statfsName = orig })
	statfsName = func(p string) (string, error) {
		if _, err := os.Stat(p); errors.Is(err, fs.ErrNotExist) {
			return "", syscall.ENOENT
		}
		return fsName(p), nil
	}
}

// TestVolumeMaxFileSizeAsksTheNearestFolderThatExists: the receive asks
// before it makes the save folder (floe receive -o /Volumes/USB/new), so a
// folder not made yet answers for the nearest folder above it that exists,
// here a FAT stick, and a folder that exists answers for itself. A file
// system that is not FAT has no known limit.
func TestVolumeMaxFileSizeAsksTheNearestFolderThatExists(t *testing.T) {
	stick := t.TempDir()
	onStick, err := os.Stat(stick)
	if err != nil {
		t.Fatal(err)
	}
	stubStatfs(t, func(p string) string {
		if fi, err := os.Stat(p); err == nil && os.SameFile(fi, onStick) {
			return "msdos"
		}
		return "apfs"
	})
	for _, dir := range []string{stick, filepath.Join(stick, "not made yet", "deeper")} {
		if got, err := volumeMaxFileSize(dir); err != nil || got != fat32MaxFileSize {
			t.Errorf("volumeMaxFileSize(%s) = %d, %v; want %d and no error, the FAT stick's limit", dir, got, err, fat32MaxFileSize)
		}
	}
	stubStatfs(t, func(string) string { return "apfs" })
	if got, err := volumeMaxFileSize(stick); err != nil || got != 0 {
		t.Errorf("volumeMaxFileSize(%s) on APFS = %d, %v; want 0 and no error", stick, got, err)
	}
}

// TestVolumeMaxFileSizeOfARealFATFolder (opt-in): with FLOE_TEST_FAT_DIR set
// to an existing folder on a FAT or FAT32 volume, the real statfs answers
// FAT32's limit for that folder and for a folder under it not made yet.
// Nothing is written on that volume.
func TestVolumeMaxFileSizeOfARealFATFolder(t *testing.T) {
	fat := os.Getenv("FLOE_TEST_FAT_DIR")
	if fat == "" {
		t.Skip("set FLOE_TEST_FAT_DIR to an existing folder on a FAT or FAT32 volume")
	}
	for _, dir := range []string{fat, filepath.Join(fat, "not made yet", "deeper")} {
		if got, err := volumeMaxFileSize(dir); err != nil || got != fat32MaxFileSize {
			t.Errorf("volumeMaxFileSize(%s) = %d, %v; want %d, the FAT folder's limit", dir, got, err, fat32MaxFileSize)
		}
	}
}
