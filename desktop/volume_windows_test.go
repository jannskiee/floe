package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/jannskiee/floe/cli/engine/transfer"
)

// TestVolumeSizeOnThisDrive asks the real volume under a temporary folder:
// the drive a test runs on has a size, at least the free space DiskFree
// reports there. A path Windows cannot take is an error, never a guess.
func TestVolumeSizeOnThisDrive(t *testing.T) {
	dir := t.TempDir()
	size, err := volumeSize(dir)
	if err != nil {
		t.Fatalf("volumeSize: %v", err)
	}
	free, err := transfer.DiskFree(dir)
	if err != nil {
		t.Fatalf("DiskFree: %v", err)
	}
	if size <= 0 || size < free {
		t.Fatalf("size %d with %d free, want the drive's size", size, free)
	}
	if _, err := volumeSize("bad\x00path"); err == nil {
		t.Fatal("a path with a NUL in it answered")
	}
}

// TestVolumeSizeFollowsAJunction: the save folder can be a directory junction
// to a folder on another volume (an exFAT USB drive, say). The files land
// where the junction points, so the size must be the target's, and a junction
// whose target is gone must be an error (the drop then asks).
func TestVolumeSizeFollowsAJunction(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	link := filepath.Join(root, "Floe")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	// mklink /J needs no privilege, unlike a symbolic link.
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Skipf("no junction on this machine: %v %s", err, out)
	}
	t.Cleanup(func() { os.Remove(link) })
	want, err := volumeSize(target)
	if err != nil {
		t.Fatalf("volumeSize(target): %v", err)
	}
	if got, err := volumeSize(link); err != nil || got != want {
		t.Fatalf("through the junction: %d %v, want the target's %d", got, err, want)
	}
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	if size, err := volumeSize(link); err == nil {
		t.Fatalf("a junction whose target is gone answered %d: the size was read for the junction's own drive, not where files would land", size)
	}
}
