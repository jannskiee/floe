package selfupdate

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestCompareVersions(t *testing.T) {
	tests := []struct {
		a, b string
		want int
	}{
		{"v1.2.0", "v1.1.0", 1},
		{"v1.0.0", "v1.0.0", 0},
		{"v1.0.0", "v1.1.0", -1},
		{"v2.0.0", "v1.9.9", 1},
		{"v1.0.1", "v1.0.0", 1},
		{"v0.9.0", "v1.0.0", -1},
		{"1.2.0", "v1.2.0", 0},   // no "v" prefix
		{"v10.0.0", "v9.9.9", 1}, // double-digit major
	}
	for _, tt := range tests {
		if got := CompareVersions(tt.a, tt.b); got != tt.want {
			t.Errorf("CompareVersions(%q, %q) = %d, want %d", tt.a, tt.b, got, tt.want)
		}
	}
}

func TestAssetName(t *testing.T) {
	tests := []struct {
		goos, goarch, version string
		wantName              string
		wantFmt               string
	}{
		{"linux", "amd64", "v1.2.0", "floe_1.2.0_linux_amd64.tar.gz", "tar.gz"},
		{"linux", "arm64", "v1.2.0", "floe_1.2.0_linux_arm64.tar.gz", "tar.gz"},
		{"darwin", "amd64", "v1.2.0", "floe_1.2.0_darwin_amd64.tar.gz", "tar.gz"},
		{"darwin", "arm64", "v1.2.0", "floe_1.2.0_darwin_arm64.tar.gz", "tar.gz"},
		{"windows", "amd64", "v1.2.0", "floe_1.2.0_windows_amd64.zip", "zip"},
		{"windows", "arm64", "v1.2.0", "floe_1.2.0_windows_arm64.zip", "zip"},
		// A bare version (no leading "v") must produce the same asset name.
		{"linux", "amd64", "1.2.0", "floe_1.2.0_linux_amd64.tar.gz", "tar.gz"},
	}
	for _, tt := range tests {
		gotName, gotFmt := AssetName(tt.version, tt.goos, tt.goarch)
		if gotName != tt.wantName {
			t.Errorf("AssetName(%q, %q, %q): name = %q, want %q", tt.version, tt.goos, tt.goarch, gotName, tt.wantName)
		}
		if gotFmt != tt.wantFmt {
			t.Errorf("AssetName(%q, %q, %q): format = %q, want %q", tt.version, tt.goos, tt.goarch, gotFmt, tt.wantFmt)
		}
	}
}

func TestDetectPM(t *testing.T) {
	tests := []struct {
		path string
		want string
	}{
		{"/opt/homebrew/Cellar/floe/1.0.0/bin/floe", "homebrew"},
		{"/usr/local/Cellar/floe/1.0.0/bin/floe", "homebrew"},
		// Homebrew's default folder on an Intel Mac, where the cask's file sits
		// under a path with neither "homebrew" nor "cellar" in it.
		{"/usr/local/Caskroom/floe/1.11.0/floe", "homebrew"},
		{"/home/linuxbrew/.linuxbrew/bin/floe", "homebrew"},
		{"C:/Users/user/scoop/apps/floe/current/floe.exe", "scoop"},
		{"C:/Users/user/AppData/Local/Microsoft/WinGet/Packages/jannskiee.floe/floe.exe", "winget"},
		{"/usr/local/bin/floe", ""},
		{"/home/user/.local/bin/floe", ""},
		{"/home/user/bin/floe", ""},
		{"C:/Users/user/AppData/Local/Programs/floe/floe.exe", ""},
	}
	for _, tt := range tests {
		if got := DetectPM(tt.path); got != tt.want {
			t.Errorf("DetectPM(%q) = %q, want %q", tt.path, got, tt.want)
		}
	}
}

// TestPMForReadsTheFileTheCommandLinksTo: the package manager is read from
// the path the process was started from and from the file that path resolves
// to. On macOS os.Executable reports the command as it was run, links
// unresolved, and Homebrew on an Intel Mac puts that command at
// /usr/local/bin/floe, a link into /usr/local/Caskroom, so only the resolved
// path names Homebrew. A command that is no link, and one whose link cannot be
// read, are judged by their own path alone.
func TestPMForReadsTheFileTheCommandLinksTo(t *testing.T) {
	links := map[string]string{
		"/usr/local/bin/floe":      "/usr/local/Caskroom/floe/1.11.0/floe",
		"/home/user/.local/bin/f":  "/home/user/.local/bin/f",
		"/opt/homebrew/bin/floe":   "/nowhere/floe",
		"/usr/local/bin/floe-self": "/usr/local/lib/floe/floe",
	}
	resolve := func(p string) (string, error) {
		if to, ok := links[p]; ok {
			return to, nil
		}
		return "", os.ErrNotExist
	}
	tests := []struct {
		exe  string
		want string
	}{
		{"/usr/local/bin/floe", "homebrew"},
		{"/home/user/.local/bin/f", ""},
		// Named by the command's own path: the link is never needed.
		{"/opt/homebrew/bin/floe", "homebrew"},
		{"/usr/local/bin/floe-self", ""},
		{"/usr/local/bin/unreadable-link", ""},
	}
	for _, tt := range tests {
		if got := pmFor(tt.exe, resolve); got != tt.want {
			t.Errorf("pmFor(%q) = %q, want %q", tt.exe, got, tt.want)
		}
	}
}

// TestPMForFollowsARealLink is the same rule through filepath.EvalSymlinks,
// the resolver PMPath passes, on a link made on disk in the shape of an Intel
// Mac's Homebrew. Skipped where this account may not make a link (Windows
// without Developer Mode) and where the temp folder's own path already reads
// as package-managed.
func TestPMForFollowsARealLink(t *testing.T) {
	root := t.TempDir()
	if pm := DetectPM(root); pm != "" {
		t.Skipf("the temp folder %q reads as %s on its own", root, pm)
	}
	target := filepath.Join(root, "usr", "local", "Caskroom", "floe", "1.11.0", "floe")
	link := filepath.Join(root, "usr", "local", "bin", "floe")
	for _, p := range []string{target, link} {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(target, []byte("floe"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("cannot make a link here: %v", err)
	}
	if got := pmFor(link, filepath.EvalSymlinks); got != "homebrew" {
		t.Errorf("pmFor(%q) = %q, want homebrew: the file it links to is under Caskroom", link, got)
	}
	if got := pmFor(target, filepath.EvalSymlinks); got != "homebrew" {
		t.Errorf("pmFor(%q) = %q, want homebrew", target, got)
	}
}

func TestPMHint(t *testing.T) {
	tests := []struct {
		pm   string
		want string
	}{
		{"homebrew", "brew upgrade floe"},
		{"scoop", "scoop update floe"},
		{"winget", "winget upgrade jannskiee.floe"},
		{"", ""},
		{"unknown", ""},
	}
	for _, tt := range tests {
		if got := PMHint(tt.pm); got != tt.want {
			t.Errorf("PMHint(%q) = %q, want %q", tt.pm, got, tt.want)
		}
	}
}

func TestInstallBinaryReplacesInPlace(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "floe")
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	if err := os.WriteFile(exe, []byte("OLD BINARY"), 0o755); err != nil {
		t.Fatal(err)
	}

	// The new binary is staged in the OS temp dir, exactly like Apply does.
	newBin := filepath.Join(t.TempDir(), "floe-update")
	if err := os.WriteFile(newBin, []byte("NEW BINARY"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := installBinary(exe, newBin); err != nil {
		t.Fatalf("installBinary: %v", err)
	}

	got, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "NEW BINARY" {
		t.Errorf("installed content = %q, want %q", got, "NEW BINARY")
	}

	// The installed binary must be executable, even though the source was 0644.
	if runtime.GOOS != "windows" {
		info, err := os.Stat(exe)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0o111 == 0 {
			t.Errorf("installed binary not executable: mode %v", info.Mode().Perm())
		}
	}

	// No staging leftovers should remain in the install dir.
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() != filepath.Base(exe) {
			t.Errorf("unexpected leftover in install dir: %s", e.Name())
		}
	}
}

// TestWindowsUpdateBackupIsFloesOwnName (CLI-03): the Windows update moves the
// running image aside under a name only floe makes, and the start cleanup
// removes that name and nothing else. A person's own floe.exe.bak survives a
// start; an update still clears the .bak that earlier versions left, as it
// always did before its rename. windowsInstall runs on every OS here: it is
// renames and copies only.
func TestWindowsUpdateBackupIsFloesOwnName(t *testing.T) {
	if got, want := updateBackupPath(`C:\Tools\floe.exe`), `C:\Tools\floe.exe.floe-update-old`; got != want {
		t.Fatalf("updateBackupPath = %q, want %q", got, want)
	}

	dir := t.TempDir()
	exe := filepath.Join(dir, "floe.exe")
	write := func(p, body string) {
		t.Helper()
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// The start cleanup: its own name goes, a hand-kept .bak stays.
	write(exe, "NEW BINARY")
	write(exe+".floe-update-old", "OLD BINARY")
	write(exe+".bak", "A COPY KEPT BY HAND")
	removeUpdateBackup(exe)
	if _, err := os.Stat(exe + ".floe-update-old"); !os.IsNotExist(err) {
		t.Fatalf("the start cleanup left the update's old image (stat err %v)", err)
	}
	if got, err := os.ReadFile(exe + ".bak"); err != nil || string(got) != "A COPY KEPT BY HAND" {
		t.Fatalf("the start cleanup touched floe.exe.bak: %q, %v", got, err)
	}

	// The update: a leftover of either name is cleared, the new binary is in
	// place, and nothing else is left (this process does not run from exe,
	// so the old image's delete succeeds).
	write(exe+".floe-update-old", "AN EARLIER OLD BINARY")
	newBin := filepath.Join(t.TempDir(), "floe-update")
	write(newBin, "NEWER BINARY")
	if err := windowsInstall(exe, newBin); err != nil {
		t.Fatalf("windowsInstall: %v", err)
	}
	if got, err := os.ReadFile(exe); err != nil || string(got) != "NEWER BINARY" {
		t.Fatalf("installed %q, %v", got, err)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() != "floe.exe" {
			t.Errorf("unexpected leftover beside floe.exe: %s", e.Name())
		}
	}
}

func TestCopyFileSetsMode(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	dst := filepath.Join(dir, "dst")
	if err := os.WriteFile(src, []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := copyFile(src, dst, 0o755); err != nil {
		t.Fatalf("copyFile: %v", err)
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "data" {
		t.Errorf("content = %q, want %q", got, "data")
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(dst)
		if info.Mode().Perm() != 0o755 {
			t.Errorf("mode = %v, want 0755", info.Mode().Perm())
		}
	}
}

// A future checked_at must be a miss. Without the guard time.Since is negative,
// the "> cacheTTL" test is false, and the entry never expires: the update check
// stays off until wall time catches up to whatever was written. The desktop's
// twin in desktop/updatecheck.go has always had this.
func TestFromCacheRejectsAFutureTimestamp(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	if runtime.GOOS == "windows" {
		t.Setenv("AppData", dir)
	}
	p := cacheFilePath()
	if p == "" {
		t.Skip("no user config dir on this machine")
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	write := func(at time.Time) {
		b, err := json.Marshal(cacheEntry{CheckedAt: at, Latest: "v9.9.9"})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		if err := os.WriteFile(p, b, 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}

	write(time.Now().Add(-time.Minute))
	if got, ok := fromCache(); !ok || got != "v9.9.9" {
		t.Fatalf("a fresh entry should hit: got %q ok=%v", got, ok)
	}

	write(time.Now().Add(72 * time.Hour))
	if _, ok := fromCache(); ok {
		t.Fatal("a future checked_at was treated as a hit; the update check would stay pinned off")
	}
}

// TestChecksumMismatchKeepsItsLines (FU-43 review 2 M3): the mismatch is a
// multi-line error Floe writes itself, so it carries the OwnLines mark the
// CLI's error printer needs to print it as lines rather than on one.
func TestChecksumMismatchKeepsItsLines(t *testing.T) {
	file := filepath.Join(t.TempDir(), "floe.zip")
	if err := os.WriteFile(file, []byte("not the release"), 0o644); err != nil {
		t.Fatal(err)
	}
	err := verifySHA256(file, "floe.zip", "0000000000000000000000000000000000000000000000000000000000000000  floe.zip\n")
	if err == nil {
		t.Fatal("verifySHA256 accepted a file whose hash is not listed")
	}
	if _, ok := err.(interface{ OwnLines() }); !ok {
		t.Errorf("the checksum mismatch does not mark its lines as Floe's own: %T %q", err, err)
	}
	if n := strings.Count(err.Error(), "\n"); n != 2 {
		t.Errorf("the checksum mismatch has %d newlines, want 2: %q", n, err)
	}
}
