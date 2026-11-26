package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
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

// TestOpenCmd pins the open-with-default-app command off Windows, where a
// process opens the file. Windows asks the shell itself (shellOpen).
func TestOpenCmd(t *testing.T) {
	path := `/Users/me/Downloads/report.pdf`
	wantArgs(t, openCmd("darwin", path).Args, "open", path)
	wantArgs(t, openCmd("linux", path).Args, "xdg-open", path)
}

// TestOpenFileHandsWindowsTheWholePath (A3-B8): rundll32's FileProtocolHandler
// read its argument as a URL, so a received file whose name holds # or %
// could open the wrong thing or nothing. On Windows OpenFile hands the shell
// the joined path as one string, every character kept, and opens no process
// of its own. The seam records the call instead of opening anything.
func TestOpenFileHandsWindowsTheWholePath(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("the shell open is Windows only")
	}
	dir := t.TempDir()
	var got []string
	prev := shellOpenFn
	shellOpenFn = func(p string) error { got = append(got, p); return nil }
	t.Cleanup(func() { shellOpenFn = prev })
	a := &App{}
	for _, name := range []string{"report #2.pdf", "50% off.txt", "a%20b#c.txt", "plain.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		got = nil
		if err := a.OpenFile(dir, name); err != nil {
			t.Fatalf("OpenFile(%q): %v", name, err)
		}
		if want := filepath.Join(dir, name); len(got) != 1 || got[0] != want {
			t.Fatalf("OpenFile(%q) asked the shell for %q, want exactly %q", name, got, want)
		}
	}
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

// TestDefaultReceiveDirFollowsAMovedDownloadsFolder: a blank Save to goes to
// the Downloads folder Windows names, wherever it is. A missing, relative or
// empty answer keeps today's rule: the home folder's Downloads, else home.
func TestDefaultReceiveDirFollowsAMovedDownloadsFolder(t *testing.T) {
	home, moved := t.TempDir(), filepath.Join(t.TempDir(), "Downloads") // moved stands in for a Downloads on another drive
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)
	if err := os.Mkdir(moved, 0o700); err != nil {
		t.Fatal(err)
	}
	prev := knownDownloadsFn
	t.Cleanup(func() { knownDownloadsFn = prev })
	at := func(named string) string {
		knownDownloadsFn = func() string { return named }
		return defaultReceiveDir()
	}

	if got := at(moved); got != moved {
		t.Fatalf("defaultReceiveDir = %q, want the Downloads folder Windows names, %q", got, moved)
	}
	for _, named := range []string{filepath.Join(home, "gone"), ".", ""} {
		if got := at(named); got != home {
			t.Errorf("with %q named and no Downloads at home, defaultReceiveDir = %q, want %q", named, got, home)
		}
	}
	atHome := filepath.Join(home, "Downloads")
	if err := os.Mkdir(atHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if got := at(""); got != atHome {
		t.Errorf("with nothing named, defaultReceiveDir = %q, want %q", got, atHome)
	}
	if got := at(moved); got != moved {
		t.Errorf("with a Downloads left at home, defaultReceiveDir = %q, want the one Windows names, %q", got, moved)
	}
}

func TestFolderCmd(t *testing.T) {
	dir := `C:\Users\me\Downloads`
	wantArgs(t, folderCmd("windows", dir).Args, "explorer", dir)
	wantArgs(t, folderCmd("darwin", dir).Args, "open", dir)
	wantArgs(t, folderCmd("linux", dir).Args, "xdg-open", dir)
}

// TestOpenFolderOpensTheNearestFolderThatExists: File Explorer given a gone
// folder opened Documents when tried. The seam records the command, so no window opens.
func TestOpenFolderOpensTheNearestFolderThatExists(t *testing.T) {
	var started []string
	prev := startFolder
	startFolder = func(c *exec.Cmd) error { started = c.Args; return nil }
	t.Cleanup(func() { startFolder = prev })
	a := &App{}
	check := func(err error, want []string) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		wantArgs(t, started, want...)
		started = nil
	}
	root := t.TempDir()
	want := folderCmd(runtime.GOOS, root).Args
	gone := filepath.Join(root, "gone")
	check(a.OpenFolder(root), want)
	check(a.OpenFolder(gone), want)
	check(a.OpenFolder(filepath.Join(gone, "deeper")), want)
	check(a.RevealFile(gone, "a.txt"), want)
	check(a.OpenFile(gone, "a.txt"), want)
	// Nothing to walk: a relative path, and on Windows a drive that is not there.
	rel := filepath.Join("gone", "deeper")
	check(a.OpenFolder(rel), folderCmd(runtime.GOOS, rel).Args)
	if runtime.GOOS == "windows" {
		noDrive := missingDrive() + `\Floe`
		check(a.OpenFolder(noDrive), folderCmd("windows", noDrive).Args)
	}
}

// TestRevealAndOpenFindAFileThatArrivedInAFolder: the one file of a receive
// can arrive inside a folder, and its saved name then keeps that folder
// ("Invoices/report.pdf", relative to the save folder and slash-separated).
// RevealFile and OpenFile cut the name to its last part, so they selected or
// opened report.pdf in the save folder, an older file that only shares the
// name, or opened the save folder with nothing selected. They now act on the
// file where it is and never on a namesake, and a name that would leave the
// save folder still opens the save folder. The seams record instead of
// opening anything, and PATH holds no program, so a command started past
// startFolder fails instead of opening a window.
func TestRevealAndOpenFindAFileThatArrivedInAFolder(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("the shell open is Windows only")
	}
	t.Setenv("PATH", t.TempDir())
	var started, shelled []string
	prevStart, prevShell := startFolder, shellOpenFn
	startFolder = func(c *exec.Cmd) error { started = c.Args; return nil }
	shellOpenFn = func(p string) error { shelled = append(shelled, p); return nil }
	t.Cleanup(func() { startFolder, shellOpenFn = prevStart, prevShell })

	root := t.TempDir()
	dir := filepath.Join(root, "save")
	nested := filepath.Join(dir, "Invoices", "report.pdf")
	write := func(t *testing.T, p string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// The messages name the temporary folder <root>, whose path changes
	// every run.
	show := func(s string) string { return strings.ReplaceAll(s, root, "<root>") }
	// did makes one call and says what it did.
	did := func(call func() error) string {
		started, shelled = nil, nil
		err := call()
		var out []string
		for _, p := range shelled {
			out = append(out, "asked the shell for "+p)
		}
		if started != nil {
			out = append(out, "started "+strings.Join(started, " "))
		}
		if err != nil {
			out = append(out, "failed: "+err.Error())
		}
		if out == nil {
			return "did nothing"
		}
		return show(strings.Join(out, ", "))
	}
	selects := show("started " + strings.Join(revealCmd("windows", dir, nested).Args, " "))
	opens := show("asked the shell for " + nested)
	folder := show("started " + strings.Join(folderCmd("windows", dir).Args, " "))
	a := &App{}
	expect := func(t *testing.T, name, reveal, open string) {
		t.Helper()
		if got := did(func() error { return a.RevealFile(dir, name) }); got != reveal {
			t.Errorf("RevealFile(%s, %#q) %s, want %s", show(dir), show(name), got, reveal)
		}
		if got := did(func() error { return a.OpenFile(dir, name) }); got != open {
			t.Errorf("OpenFile(%s, %#q) %s, want %s", show(dir), show(name), got, open)
		}
	}

	// The first three fail on main, and the last passes there already.
	t.Run("the file in its folder", func(t *testing.T) {
		write(t, nested)
		expect(t, "Invoices/report.pdf", selects, opens)
	})
	t.Run("beside an older file of the same name in the save folder", func(t *testing.T) {
		write(t, filepath.Join(dir, "report.pdf"))
		expect(t, "Invoices/report.pdf", selects, opens)
	})
	t.Run("gone from its folder, with the older file still there", func(t *testing.T) {
		if err := os.Remove(nested); err != nil {
			t.Fatal(err)
		}
		expect(t, "Invoices/report.pdf", folder, folder)
		// And with its folder gone too.
		if err := os.Remove(filepath.Dir(nested)); err != nil {
			t.Fatal(err)
		}
		expect(t, "Invoices/report.pdf", folder, folder)
	})
	t.Run("a name that would leave the save folder", func(t *testing.T) {
		outside := filepath.Join(root, "outside.txt")
		write(t, outside)
		// A sibling folder whose path starts with the save folder's.
		write(t, filepath.Join(root, "save2", "x.txt"))
		for _, name := range []string{
			"../outside.txt",
			`..\outside.txt`,
			"../save2/x.txt",
			"Invoices/../../outside.txt",
			// Localize takes this one, and Windows does not read ".. " as "..".
			".. /outside.txt",
			outside,
		} {
			expect(t, name, folder, folder)
		}
	})
}
