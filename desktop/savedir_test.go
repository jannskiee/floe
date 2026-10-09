package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestResolveSaveDir(t *testing.T) {
	home, other := t.TempDir(), t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)
	t.Setenv("FLOE_QA_SAVEDIR", other)
	t.Chdir(t.TempDir())
	cases := []struct{ in, want string }{
		{"", ""},
		{"   ", ""},
		{filepath.Join("Downloads", "Floe"), filepath.Join(home, "Downloads", "Floe")},
		{"  " + filepath.Join("Downloads", "Floe") + "  ", filepath.Join(home, "Downloads", "Floe")},
		{"~", home},
		{filepath.Join("~", "Floe"), filepath.Join(home, "Floe")},
		{filepath.Join("%FLOE_QA_SAVEDIR%", "Floe"), filepath.Join(other, "Floe")},
		{filepath.Join("%FLOE_QA_UNSET_VAR%", "Floe"), filepath.Join(home, "%FLOE_QA_UNSET_VAR%", "Floe")},
		{filepath.Join(other, "a", "..", "Floe"), filepath.Join(other, "Floe")},
		{`"` + filepath.Join(other, "Floe") + `"`, filepath.Join(other, "Floe")},
	}
	if runtime.GOOS == "windows" {
		cases = append(cases, struct{ in, want string }{`d:\Floe\x`, `d:\Floe\x`})
	}
	for _, c := range cases {
		got, err := resolveSaveDir(c.in)
		if err != nil {
			t.Fatalf("resolveSaveDir(%q): %v", c.in, err)
		}
		if got != c.want {
			t.Errorf("resolveSaveDir(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	if runtime.GOOS == "windows" {
		// Relative to something the owner cannot see: refused, never guessed.
		for _, in := range []string{`\Floe`, `/Floe`, `D:Floe`, `"D:Floe"`} {
			if got, err := resolveSaveDir(in); !errors.Is(err, errNotFullPath) {
				t.Errorf("resolveSaveDir(%q) = %q, %v, want errNotFullPath", in, got, err)
			}
		}
	}
}

// W3 R2-01: a %NAME% set to nothing leaves nothing to resolve, which is the
// caller's default as for an empty field. It indexed dir[0] and panicked inside
// a Wails call, which never settles the promise: Make link sat on "Making
// link..." until a restart.
func TestResolveSaveDirEmptyExpansion(t *testing.T) {
	t.Setenv("FLOE_QA_EMPTY", "")
	for _, in := range []string{"%FLOE_QA_EMPTY%", `"%FLOE_QA_EMPTY%"`, " %FLOE_QA_EMPTY% "} {
		got, err := resolveSaveDir(in)
		if err != nil || got != "" {
			t.Errorf("resolveSaveDir(%q) = %q, %v, want the caller's default (\"\", nil)", in, got, err)
		}
	}
}

// W3 R2-11: the home folder is read only when a typed path needs it, so an
// unset USERPROFILE refuses no absolute folder.
func TestResolveSaveDirAbsoluteNeedsNoHome(t *testing.T) {
	abs := t.TempDir()
	t.Setenv("USERPROFILE", "")
	t.Setenv("HOME", "")
	if got, err := resolveSaveDir(abs); err != nil || got != filepath.Clean(abs) {
		t.Fatalf("resolveSaveDir(%q) with no home = %q, %v, want the folder itself", abs, got, err)
	}
}

func TestSaveDirUsable(t *testing.T) {
	dir := t.TempDir()
	if !saveDirUsable(filepath.Join(dir, "new", "deeper")) {
		t.Error("a folder under an existing one is usable")
	}
	f := filepath.Join(dir, "a-file")
	if err := os.WriteFile(f, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if saveDirUsable(filepath.Join(f, "sub")) {
		t.Error("a path through a file is not usable")
	}
	if missing := missingDrive(); missing != "" && saveDirUsable(missing+`\Floe`) {
		t.Errorf("a folder on a drive that does not exist (%s) is not usable", missing)
	}
}

// W3 R2-02: a name Windows refuses (< > : " | ? * or a control character)
// cannot be made at Accept, so it is not a usable folder; Make link then ends
// with save-folder instead of spending the link on write-failed.
func TestSaveDirUsableRefusesNamesWindowsCannotMake(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("the refused characters are Windows' own")
	}
	dir := t.TempDir()
	for _, name := range []string{"a|b", "a:b", "a<b", "a>b", `a"b`, "a?b", "a*b", "a\tb", "a\x01b"} {
		if saveDirUsable(filepath.Join(dir, name, "Floe")) {
			t.Errorf("%q is usable, want refused", filepath.Join(dir, name, "Floe"))
		}
	}
	if !saveDirUsable(filepath.Join(dir, "a b (2)", "Floe")) {
		t.Error("spaces and parentheses are legal in a name")
	}
}

// C1-08: Windows trims a space, and a period after the one it takes off,
// from the end of a name it is handed whole, but not from the same name inside
// a longer path. "foo " is made as "foo", "foo \Floe" then cannot be found,
// and the link was spent at Accept. A single trailing period is trimmed both
// ways, so "foo." works (measured on Windows 11 26200; the MkdirAll checks keep
// the rule honest against the OS).
func TestSaveDirUsableRefusesNamesWindowsTrims(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("the trimming is Windows' own")
	}
	dir := t.TempDir()
	for _, name := range []string{"foo ", "foo..", "foo. ", "foo .", "foo..."} {
		p := filepath.Join(dir, name, "Floe")
		if saveDirUsable(p) {
			t.Errorf("%q is usable, want refused", p)
		}
		if saveDirUsable(filepath.Join(dir, name)) {
			t.Errorf("%q as the last name is usable, want refused", filepath.Join(dir, name))
		}
		if err := os.MkdirAll(p, 0o755); err == nil {
			t.Errorf("MkdirAll(%q) worked, so the rule refuses a folder Windows can make", p)
		}
	}
	for _, name := range []string{"foo.", " foo", "a.b", "a b"} {
		p := filepath.Join(dir, name, "Floe")
		if !saveDirUsable(p) {
			t.Errorf("%q is refused, want usable", p)
		}
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Errorf("MkdirAll(%q): %v, so the rule passes a folder Windows cannot make", p, err)
		}
	}
	if !saveDirUsable(dir + `\x\..\Floe`) {
		t.Error("a parent step is not a name ending in a period")
	}
}

// W3 R2-02: a Save to made only of quotes, or of a %NAME% set to nothing, is
// the default folder as an empty field is, never the raw text kept as a
// relative folder that Accept would resolve against the working directory.
func TestMakeRequestLinkBlankFolderIsTheDefault(t *testing.T) {
	t.Setenv("FLOE_QA_EMPTY", "")
	def := t.TempDir()
	old := requestDefaultDirFn
	requestDefaultDirFn = func() string { return def }
	t.Cleanup(func() { requestDefaultDirFn = old })
	for _, in := range []string{`""`, `"   "`, "%FLOE_QA_EMPTY%"} {
		a, _ := laneApp(t, nil)
		if s := a.MakeRequestLink("x", in, "24h", false); s.SaveDir != def {
			t.Errorf("Make link into %q: SaveDir = %q, want the default %q", in, s.SaveDir, def)
		}
	}
}

// missingDrive is a drive letter with no volume behind it on this machine, or
// "" off Windows or when every letter is taken.
func missingDrive() string {
	if runtime.GOOS != "windows" {
		return ""
	}
	for c := 'Z'; c >= 'D'; c-- {
		d := string(c) + ":"
		if _, err := os.Stat(d + `\`); err != nil {
			return d
		}
	}
	return ""
}

// The installed build runs with the install folder as its working directory,
// which the uninstaller deletes: a typed relative Save to must never land there.
func TestMakeRequestLinkResolvesARelativeSaveDirUnderHome(t *testing.T) {
	home, cwd := t.TempDir(), t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)
	t.Chdir(cwd)
	a, _ := laneApp(t, nil)
	s := a.MakeRequestLink("x", filepath.Join("Downloads", "Floe"), "24h", false)
	if want := filepath.Join(home, "Downloads", "Floe"); s.SaveDir != want {
		t.Fatalf("SaveDir = %q, want %q (not under the working directory %q)", s.SaveDir, want, cwd)
	}
}

// A folder Floe cannot use ends Make link with save-folder (D-177, "Couldn't
// use that folder") before any server is asked, so no link is made and none is
// spent at Accept on a refusal that blames the sender.
func TestMakeRequestLinkRefusesAnUnusableFolder(t *testing.T) {
	f := filepath.Join(t.TempDir(), "a-file")
	if err := os.WriteFile(f, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	bad := []string{filepath.Join(f, "Floe")}
	if runtime.GOOS == "windows" {
		bad = append(bad, `\Floe`, `D:Floe`)
		if m := missingDrive(); m != "" {
			bad = append(bad, m+`\Floe`)
		}
	}
	for _, dir := range bad {
		fs := newFakeSignalServer(t)
		a, _ := laneApp(t, fs)
		a.MakeRequestLink("x", dir, "24h", false)
		s := waitState(t, a, 10*time.Second, "error")
		if s.Code != "save-folder" {
			t.Fatalf("Make link into %q: code %q, want save-folder", dir, s.Code)
		}
		if n := len(fs.tokenJoins()); n != 0 {
			t.Fatalf("Make link into %q asked the server %d time(s)", dir, n)
		}
	}
}
