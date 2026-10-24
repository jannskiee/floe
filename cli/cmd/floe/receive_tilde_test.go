package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// issue #726: a leading ~ in -o is the home folder, because Windows
// PowerShell 5.1, PowerShell 7.5- and cmd.exe pass it on as typed, and every
// shell does inside quotes or after --output=.
func TestExpandHome(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("no home dir: %v", err)
	}

	for _, tt := range []struct {
		in, want string
	}{
		{"~", home},
		{"~/Downloads", filepath.Join(home, "Downloads")},
		{`~\Downloads`, filepath.Join(home, "Downloads")},
		{"relative/dir", "relative/dir"},
		{"/abs/dir", "/abs/dir"},
		{"~user/stuff", "~user/stuff"},   // a shell that has ~user expands it itself
		{"%NAME%/x", "%NAME%/x"},         // cmd.exe expands its own variables
		{"home~/x", "home~/x"},           // not a leading ~
	} {
		got, err := expandHome(tt.in)
		if err != nil {
			t.Fatalf("expandHome(%q): %v", tt.in, err)
		}
		if got != tt.want {
			t.Errorf("expandHome(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

// The failure the issue reports: -o ~/Downloads made a folder named ~ under
// the current folder. With the fix, the saved path is under the home folder.
func TestReceiveOutputTildeLandsInHome(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("path shape differs; the unit test above covers the rule")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	got, err := expandHome("~/Downloads")
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(home, "Downloads")
	if got != want {
		t.Fatalf("expandHome = %q, want %q", got, want)
	}
	if filepath.Base(filepath.Dir(got)) == "~" {
		t.Fatalf("output still lands in a folder named ~: %q", got)
	}
}
