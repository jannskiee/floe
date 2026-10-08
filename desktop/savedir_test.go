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
