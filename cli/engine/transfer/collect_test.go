package transfer

import (
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// symlinkOrSkip makes a link, or skips where the account may not (Windows
// without Developer Mode); CI's Linux and macOS runners always may.
func symlinkOrSkip(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("cannot make a symbolic link here: %v", err)
	}
}

// TestCollectFilesSizesALinkedFileByItsTarget: filepath.Walk reports a link
// inside a folder by Lstat, whose size is the link's own, while the send opens
// the link and reads its target. The announced size has to be the target's,
// or the send stops partway as a file that changed while it was being sent.
func TestCollectFilesSizesALinkedFileByItsTarget(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(t.TempDir(), "outside.bin")
	if err := os.WriteFile(target, make([]byte, 4096), 0o644); err != nil {
		t.Fatal(err)
	}
	folder := filepath.Join(dir, "album")
	if err := os.Mkdir(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	symlinkOrSkip(t, target, filepath.Join(folder, "linked.bin"))

	entries, err := collectFiles([]string{folder})
	if err != nil {
		t.Fatal(err)
	}
	sizes := map[string]int64{}
	for _, e := range entries {
		sizes[e.displayName] = e.size
	}
	if sizes["album/a.txt"] != 5 || sizes["album/linked.bin"] != 4096 {
		t.Fatalf("sizes %v, want album/a.txt 5 and album/linked.bin 4096 (the target's size)", sizes)
	}
}

// TestCollectFilesRefusesALinkItCannotSend: a link to a folder (Walk does not
// follow it, and reading it as a file fails after the receiver has accepted)
// and a link that points nowhere both end the send before it connects.
func TestCollectFilesRefusesALinkItCannotSend(t *testing.T) {
	for _, c := range []struct {
		name, want string
		target     func(t *testing.T) string
	}{
		{"a link to a folder", "is a link to a folder", func(t *testing.T) string { return t.TempDir() }},
		{"a link that points nowhere", "cannot read", func(t *testing.T) string { return filepath.Join(t.TempDir(), "gone") }},
	} {
		t.Run(c.name, func(t *testing.T) {
			folder := filepath.Join(t.TempDir(), "album")
			if err := os.Mkdir(folder, 0o755); err != nil {
				t.Fatal(err)
			}
			symlinkOrSkip(t, c.target(t), filepath.Join(folder, "link"))
			_, err := collectFiles([]string{folder})
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("collectFiles = %v, want an error containing %q", err, c.want)
			}
		})
	}
}

// TestCollectFilesWalksATopLevelLinkToAFolder: a path argument that is itself
// a link to a folder is the folder the person meant to send. It is walked,
// and its files keep the link's name as their folder.
func TestCollectFilesWalksATopLevelLinkToAFolder(t *testing.T) {
	real := t.TempDir()
	if err := os.WriteFile(filepath.Join(real, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "album")
	symlinkOrSkip(t, real, link)
	entries, err := collectFiles([]string{link})
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].displayName != "album/a.txt" || entries[0].size != 5 {
		t.Fatalf("entries %+v, want one album/a.txt of 5 bytes", entries)
	}
}

// TestCollectFilesRefusesAJunctionToAFolder: Go reports a Windows junction by
// Lstat as ModeIrregular, not ModeSymlink, so a check for links alone let a
// junction inside a sent folder through as an empty file. A junction needs no
// privilege to make, so this runs on every Windows machine.
func TestCollectFilesRefusesAJunctionToAFolder(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("junctions are a Windows file system feature")
	}
	folder := filepath.Join(t.TempDir(), "album")
	if err := os.Mkdir(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", filepath.Join(folder, "linked"), t.TempDir()).CombinedOutput(); err != nil {
		t.Skipf("cannot make a junction here: %v %s", err, out)
	}
	_, err := collectFiles([]string{folder})
	if err == nil || !strings.Contains(err.Error(), "is a link to a folder") {
		t.Fatalf("collectFiles = %v, want the link-to-a-folder refusal", err)
	}
}

// TestCollectFilesNamesFilesAsBefore: the names do not depend on how the
// folder was walked. A trailing separator still names the files without the
// folder, as it always has.
func TestCollectFilesNamesFilesAsBefore(t *testing.T) {
	dir := t.TempDir()
	folder := filepath.Join(dir, "album")
	if err := os.MkdirAll(filepath.Join(folder, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "sub", "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	for in, want := range map[string]string{
		folder:                            "album/sub/a.txt",
		folder + string(os.PathSeparator): "sub/a.txt",
	} {
		entries, err := collectFiles([]string{in})
		if err != nil || len(entries) != 1 || entries[0].displayName != want {
			t.Errorf("collectFiles(%q) = %+v, %v; want one %q", in, entries, err, want)
		}
	}
}

// TestCollectFilesLeavesOutPipesSocketsAndDevices: refused when named, skipped inside a folder.
func TestCollectFilesLeavesOutPipesSocketsAndDevices(t *testing.T) {
	refused := func(t *testing.T, p string) {
		t.Helper()
		want := "cannot send " + p + ": it is a pipe, a socket or a device, not a file"
		if _, err := collectFiles([]string{p}); err == nil || err.Error() != want {
			t.Errorf("collectFiles(%q) = %v, want %q", p, err, want)
		}
	}
	t.Run("a device", func(t *testing.T) { refused(t, os.DevNull) }) // NUL on Windows
	t.Run("a pipe and a socket", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("Linux and macOS only")
		}
		dir, err := os.MkdirTemp("", "floe") // short: macOS caps a socket path at 104 bytes
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.RemoveAll(dir) })
		album := filepath.Join(dir, "album")
		if err := os.Mkdir(album, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(album, "a.txt"), []byte("hello"), 0o644); err != nil {
			t.Fatal(err)
		}
		pipe, sock := filepath.Join(album, "pipe"), filepath.Join(album, "sock")
		if out, err := exec.Command("mkfifo", pipe).CombinedOutput(); err != nil {
			t.Skipf("no named pipe here: %v %s", err, out)
		}
		l, err := net.Listen("unix", sock)
		if err != nil {
			t.Skipf("no Unix socket here: %v", err)
		}
		defer l.Close()
		symlinkOrSkip(t, os.DevNull, filepath.Join(album, "null"))
		refused(t, pipe)
		refused(t, sock)
		entries, err := collectFiles([]string{album})
		var names []string
		for _, e := range entries {
			names = append(names, e.displayName)
		}
		if err != nil || strings.Join(names, "|") != "album/a.txt" {
			t.Errorf("collectFiles(album) = %q, %v; want album/a.txt alone", names, err)
		}
	})
}
