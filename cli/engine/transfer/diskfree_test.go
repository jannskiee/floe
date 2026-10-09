package transfer

// The volume's largest file through the ways a save folder can be reached: a
// folder not made yet, a subst drive letter, and (opt-in) a subst drive and a
// junction to a folder on a FAT volume (FU-36). The subst and junction tests
// run on Windows only and skip elsewhere, so this file needs no GOOS suffix.

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// substDrive maps a free drive letter to dir with subst and returns it as
// "X:". Letters are tried from Z down, so one another process holds is
// skipped. The mapping is removed in Cleanup, which runs before t.TempDir's
// own cleanup and whether the test passed or not.
func substDrive(t *testing.T, dir string) string {
	t.Helper()
	for c := 'Z'; c >= 'D'; c-- {
		drive := string(c) + ":"
		if _, err := os.Stat(drive + `\`); err == nil {
			continue
		}
		if err := exec.Command("subst", drive, dir).Run(); err != nil {
			continue
		}
		t.Cleanup(func() {
			if out, err := exec.Command("subst", drive, "/D").CombinedOutput(); err != nil {
				t.Errorf("subst %s /D: %v %s", drive, err, out)
			}
		})
		return drive
	}
	t.Skip("no drive letter could be mapped with subst")
	return ""
}

// TestVolumeMaxFileSizeOfAFolderNotMadeYet: the receive asks before it makes
// the output folder (a request link's save folder may not exist yet at the
// first metadata), so a folder not made yet answers for the nearest folder
// above it that exists, with no error.
func TestVolumeMaxFileSizeOfAFolderNotMadeYet(t *testing.T) {
	base := t.TempDir()
	want, err := volumeMaxFileSize(base)
	if err != nil {
		t.Fatalf("volumeMaxFileSize(%s): %v", base, err)
	}
	dir := filepath.Join(base, "not made yet", "deeper")
	if got, err := volumeMaxFileSize(dir); err != nil || got != want {
		t.Fatalf("volumeMaxFileSize(%s) = %d, %v; want %d and no error, the answer for %s", dir, got, err, want, base)
	}
}

// TestVolumeMaxFileSizeOnASubstDrive (FU-36): a save folder can sit on a drive
// letter that subst maps to a folder. GetVolumePathName fails there with
// ERROR_INVALID_PARAMETER (measured 2026-10-01), so asking by the path's root
// left the limit unknown, and a FAT32 folder behind the letter never refused a
// file past 4 GiB up front: the file failed mid-write. Asked through a handle,
// the letter answers for the folder it maps, and so does a folder on it that
// is not made yet.
func TestVolumeMaxFileSizeOnASubstDrive(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("subst is a Windows drive mapping")
	}
	target := t.TempDir()
	want, err := volumeMaxFileSize(target)
	if err != nil {
		t.Fatalf("volumeMaxFileSize(%s): %v", target, err)
	}
	drive := substDrive(t, target)
	for _, dir := range []string{drive + `\`, filepath.Join(drive+`\`, "not made yet", "deeper")} {
		if got, err := volumeMaxFileSize(dir); err != nil || got != want {
			t.Errorf("volumeMaxFileSize(%s) = %d, %v; want %d and no error, the answer for %s", dir, got, err, want, target)
		}
	}
}

// TestVolumeMaxFileSizeThroughTheWaysToAFATFolder (FU-36, opt-in): with
// FLOE_TEST_FAT_DIR set to an existing folder on a FAT or FAT32 volume (Google
// Drive for desktop's drive reports FAT32), a subst drive mapped to it, a
// folder on that drive not made yet, and a junction to it each answer FAT32's
// limit. By the path's root the subst drive answered nothing; the junction
// answered FAT32 either way, so it pins that the handle follows the link.
// Nothing is written on that volume: the test maps a drive letter and makes
// one junction on the temp volume, and removes both, the junction by name and
// never recursively.
func TestVolumeMaxFileSizeThroughTheWaysToAFATFolder(t *testing.T) {
	fat := os.Getenv("FLOE_TEST_FAT_DIR")
	if runtime.GOOS != "windows" || fat == "" {
		t.Skip("set FLOE_TEST_FAT_DIR to an existing folder on a FAT or FAT32 volume (Windows)")
	}
	if got, err := volumeMaxFileSize(fat); err != nil || got != fat32MaxFileSize {
		t.Fatalf("FLOE_TEST_FAT_DIR %s answered %d, %v: not a folder on a FAT volume", fat, got, err)
	}
	drive := substDrive(t, fat)
	// The junction gets its own folder, removed by name: no RemoveAll ever
	// runs over a link to a folder this test does not own.
	holder, err := os.MkdirTemp("", "floe-fu36-")
	if err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(holder, "Floe requests")
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, fat).CombinedOutput(); err != nil {
		_ = os.Remove(holder)
		t.Fatalf("mklink /J %s %s: %v %s", link, fat, err, out)
	}
	t.Cleanup(func() {
		if err := os.Remove(link); err != nil {
			t.Errorf("remove the junction %s: %v", link, err)
			return
		}
		if err := os.Remove(holder); err != nil {
			t.Errorf("remove %s: %v", holder, err)
		}
	})
	for _, dir := range []string{drive + `\`, filepath.Join(drive+`\`, "not made yet"), link} {
		if got, err := volumeMaxFileSize(dir); err != nil || got != fat32MaxFileSize {
			t.Errorf("volumeMaxFileSize(%s) = %d, %v; want %d, the FAT folder's limit", dir, got, err, fat32MaxFileSize)
		}
	}
}

// TestVolumeNamedStreamsOfAFolderNotMadeYet: like the largest-file question,
// the named-streams question is asked before the drop folder exists, so a
// folder not made yet answers for the nearest folder above it that does.
func TestVolumeNamedStreamsOfAFolderNotMadeYet(t *testing.T) {
	base := t.TempDir()
	want, err := volumeNamedStreams(base)
	if err != nil {
		t.Fatalf("volumeNamedStreams(%s): %v", base, err)
	}
	dir := filepath.Join(base, "not made yet", "deeper")
	if got, err := volumeNamedStreams(dir); err != nil || got != want {
		t.Fatalf("volumeNamedStreams(%s) = %v, %v; want %v and no error, the answer for %s", dir, got, err, want, base)
	}
	if got, err := VolumeNamedStreams(dir); err != nil || got != want {
		t.Fatalf("VolumeNamedStreams(%s) = %v, %v; the exported question must be the same one", dir, got, err)
	}
}

// TestVolumeNamedStreamsAgreesWithTheMarkWrite (S-7): the answer is what the
// Windows downloaded-file mark needs, so on the volume this test runs on it
// must agree with whether the Zone.Identifier stream can really be written.
// Windows volumes differ (NTFS and ReFS carry named streams, FAT32, exFAT and
// many network shares do not), which is why the flag is asked of the volume
// and not assumed from the OS. Off Windows no mark is ever written, so the
// answer is no there.
func TestVolumeNamedStreamsAgreesWithTheMarkWrite(t *testing.T) {
	dir := t.TempDir()
	got, err := volumeNamedStreams(dir)
	if err != nil {
		t.Fatalf("volumeNamedStreams(%s): %v", dir, err)
	}
	if runtime.GOOS != "windows" {
		if got {
			t.Fatal("a platform that writes no mark reports a volume that carries one")
		}
		return
	}
	file := filepath.Join(dir, "probe.bin")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	wrote := applyMOTW(file) == nil
	if got != wrote {
		t.Fatalf("volumeNamedStreams = %v but writing the Zone.Identifier stream here %v", got, map[bool]string{true: "worked", false: "failed"}[wrote])
	}
}

// TestVolumeNamedStreamsOfAFATFolder (opt-in): with FLOE_TEST_FAT_DIR set to
// an existing folder on a FAT or FAT32 volume, the answer is no and not an
// error, which is the case the Done view's not-scanned line exists for.
func TestVolumeNamedStreamsOfAFATFolder(t *testing.T) {
	fat := os.Getenv("FLOE_TEST_FAT_DIR")
	if runtime.GOOS != "windows" || fat == "" {
		t.Skip("set FLOE_TEST_FAT_DIR to an existing folder on a FAT or FAT32 volume (Windows)")
	}
	if got, err := volumeNamedStreams(fat); err != nil || got {
		t.Fatalf("volumeNamedStreams(%s) = %v, %v; want false and no error on a FAT volume", fat, got, err)
	}
}
