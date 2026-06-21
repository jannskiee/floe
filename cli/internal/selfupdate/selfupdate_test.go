package selfupdate

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
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
		{"1.2.0", "v1.2.0", 0},  // no "v" prefix
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
