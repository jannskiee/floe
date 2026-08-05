package main

import (
	"os"
	"path/filepath"
	"testing"
)

// wantArgs asserts an *exec.Cmd's Args (the command as constructed, before any
// PATH resolution) equal the expected tokens.
func wantArgs(t *testing.T, got []string, want ...string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("args = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("args = %v, want %v", got, want)
		}
	}
}

// TestRevealCmd pins the per-platform reveal-and-select command. The Windows
// form is one joined "/select,<path>" arg (two separate args often fails to
// select), and Linux opens the folder (dir) since it has no portable file-select.
func TestRevealCmd(t *testing.T) {
	dir := `C:\Users\me\Downloads`
	path := `C:\Users\me\Downloads\report.pdf`
	wantArgs(t, revealCmd("windows", dir, path).Args, "explorer", "/select,"+path)
	wantArgs(t, revealCmd("darwin", dir, path).Args, "open", "-R", path)
	wantArgs(t, revealCmd("linux", dir, path).Args, "xdg-open", dir)
}

// TestOpenCmd pins the per-platform open-with-default-app command.
func TestOpenCmd(t *testing.T) {
	path := `C:\Users\me\Downloads\report.pdf`
	wantArgs(t, openCmd("windows", path).Args, "rundll32", "url.dll,FileProtocolHandler", path)
	wantArgs(t, openCmd("darwin", path).Args, "open", path)
	wantArgs(t, openCmd("linux", path).Args, "xdg-open", path)
}

func TestFileExists(t *testing.T) {
	dir := t.TempDir()
	if fileExists(dir) {
		t.Error("fileExists(dir) = true, want false (a directory is not a regular file)")
	}
	f := filepath.Join(dir, "x.txt")
	if err := os.WriteFile(f, []byte("hi"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !fileExists(f) {
		t.Error("fileExists(existing file) = false, want true")
	}
	if fileExists(filepath.Join(dir, "nope.txt")) {
		t.Error("fileExists(missing) = true, want false")
	}
}

// TestSafeLeaf proves the reveal/open path-traversal guard: any peer-supplied
// name reduces to a single component that stays inside the target directory, or
// is rejected so the caller falls back to opening the folder. safeLeaf normalizes
// backslashes itself, so these Windows-style payloads assert deterministically on
// any host OS.
func TestSafeLeaf(t *testing.T) {
	dir := `C:\Users\me\Downloads`
	for _, tc := range []struct{ name, leaf string }{
		{`report.pdf`, "report.pdf"},
		{`..\..\..\Windows\System32\calc.exe`, "calc.exe"},
		{`../../../etc/passwd`, "passwd"},
		{`\\attacker\share\evil.exe`, "evil.exe"},
		{`C:\Windows\System32\cmd.exe`, "cmd.exe"},
	} {
		leaf, ok := safeLeaf(tc.name)
		if !ok || leaf != tc.leaf {
			t.Errorf("safeLeaf(%q) = (%q, %v), want (%q, true)", tc.name, leaf, ok, tc.leaf)
		}
		// Containment: the leaf must be a direct child of dir (never escapes).
		if got := filepath.Dir(filepath.Join(dir, leaf)); got != filepath.Clean(dir) {
			t.Errorf("safeLeaf(%q) escaped: parent = %q, want %q", tc.name, got, filepath.Clean(dir))
		}
	}
	for _, bad := range []string{`..`, `.`, ``} {
		if leaf, ok := safeLeaf(bad); ok {
			t.Errorf("safeLeaf(%q) = (%q, true), want ok=false", bad, leaf)
		}
	}
}
