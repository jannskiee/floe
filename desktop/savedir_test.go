package main

import (
	"path/filepath"
	"runtime"
	"testing"
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
		vol := filepath.VolumeName(home)
		cases = append(cases,
			struct{ in, want string }{`\Floe`, vol + `\Floe`},
			struct{ in, want string }{`D:Floe`, `D:\Floe`},
			struct{ in, want string }{`d:\Floe\x`, `d:\Floe\x`},
		)
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
