package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// useExecutable points the executable seam at path for one test.
func useExecutable(t *testing.T, path string, err error) {
	t.Helper()
	prev := executable
	executable = func() (string, error) { return path, err }
	t.Cleanup(func() { executable = prev })
}

// TestIsInstalledLooksForTheUninstallerBesideTheApp (DSK-04): the NSIS
// installer writes uninstall.exe next to the app (project.nsi), and an
// unzipped portable copy has none, which is how the frontend keeps the
// Explorer entry off by default on a portable copy (owner answer 26).
func TestIsInstalledLooksForTheUninstallerBesideTheApp(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "floe-desktop.exe")
	if err := os.WriteFile(exe, []byte("app"), 0o600); err != nil {
		t.Fatal(err)
	}
	useExecutable(t, exe, nil)
	a := &App{}
	if a.IsInstalled() {
		t.Fatal("a folder with no uninstall.exe reads as installed")
	}
	if err := os.Mkdir(filepath.Join(dir, "uninstall.exe"), 0o700); err != nil {
		t.Fatal(err)
	}
	if a.IsInstalled() {
		t.Fatal("a folder named uninstall.exe reads as installed")
	}
	if err := os.Remove(filepath.Join(dir, "uninstall.exe")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "uninstall.exe"), []byte("nsis"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !a.IsInstalled() {
		t.Fatal("uninstall.exe beside the app does not read as installed")
	}
	useExecutable(t, "", errors.New("no executable path"))
	if a.IsInstalled() {
		t.Fatal("an unknown executable path reads as installed")
	}
}

// TestContextMenuStateOf (DSK-04) is the decision behind ContextMenuState,
// apart from the registry: whose the entry is, judged by the command it runs.
func TestContextMenuStateOf(t *testing.T) {
	dir := t.TempDir()
	self := filepath.Join(dir, "portable", "floe-desktop.exe")
	other := filepath.Join(dir, "installed", "floe-desktop.exe")
	for _, p := range []string{self, other} {
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("app"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	gone := filepath.Join(dir, "deleted", "floe-desktop.exe")
	type row struct {
		name       string
		cmd        string
		registered bool
		want       string
	}
	rows := []row{
		{"no entry", "", false, "missing"},
		{"this copy's entry", expectedCommand(self), true, "self"},
		{"another copy's entry", expectedCommand(other), true, "other"},
		// The folder it ran from was deleted: the entry is dead, a state of
		// its own (DESKTOP-01), so the launch rule registers over it when this
		// copy would register and otherwise removes it, rather than leaving a
		// broken entry behind a switch that reads off.
		{"an entry whose program is gone", expectedCommand(gone), true, "dead"},
		// Not a command Floe writes: someone else's, never touched.
		{"an entry in a shape Floe never writes", `notepad.exe "%1"`, true, "other"},
		{"an empty command", "", true, "other"},
	}
	if runtime.GOOS == "windows" {
		// DESKTOP-02: Windows paths ignore letter case, so this copy launched
		// under another spelling (a folder typed in lower case on the
		// installer's page, then the exe double-clicked in Explorer) is still
		// this copy, and so is the same path with a doubled separator.
		rows = append(rows,
			row{"this copy's entry in other letter case", expectedCommand(strings.ToUpper(self)), true, "self"},
			row{"this copy's entry, not cleaned", expectedCommand(strings.Replace(self, `\portable\`, `\portable\\`, 1)), true, "self"},
		)
	}
	for _, tc := range rows {
		t.Run(tc.name, func(t *testing.T) {
			if got := contextMenuStateOf(self, tc.cmd, tc.registered); got != tc.want {
				t.Fatalf("contextMenuStateOf(%q) = %q, want %q", tc.cmd, got, tc.want)
			}
		})
	}
}
