package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// testConfigHome is the temporary folder TestMain points every OS user
// directory and the temp directory at for the whole package.
var testConfigHome string

// TestMain points the OS user directories and the temp directory at a
// temporary folder before any test runs, the same guard as the desktop and
// selfupdate packages' (review A R5). These tests drive the real command tree
// through rootCmd.Execute, only with `help` today, but the tree holds
// `version`, whose selfupdate.CheckAvailable writes the update-check cache
// under os.UserConfigDir, and `update`, which stages a download in the temp
// directory: one changed argument in a test, or a test under a mutation, would
// reach them.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "floe-cmd-test-home-")
	if err != nil {
		fmt.Fprintln(os.Stderr, "TestMain: temporary home:", err)
		os.Exit(1)
	}
	testConfigHome = dir
	for _, k := range []string{"APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"} {
		os.Setenv(k, dir)
	}
	// The temp directory too, made after the home itself (see the desktop
	// package's TestMain, review A R4).
	tmp := filepath.Join(dir, "tmp")
	if err := os.Mkdir(tmp, 0o700); err != nil {
		fmt.Fprintln(os.Stderr, "TestMain: temporary temp dir:", err)
		os.Exit(1)
	}
	for _, k := range []string{"TMP", "TEMP", "TMPDIR"} {
		os.Setenv(k, tmp)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

// The user directories and the temp directory all resolve inside the temporary
// home while tests run.
func TestUserDirsStayInTheTestHome(t *testing.T) {
	dirs := map[string]func() (string, error){
		"os.UserConfigDir": os.UserConfigDir,
		"os.UserCacheDir":  os.UserCacheDir,
		"os.UserHomeDir":   os.UserHomeDir,
		"os.TempDir":       func() (string, error) { return os.TempDir(), nil },
	}
	for name, dir := range dirs {
		p, err := dir()
		if err != nil || p == "" {
			t.Fatalf("%s: %q, %v", name, p, err)
		}
		rel, err := filepath.Rel(testConfigHome, p)
		if testConfigHome == "" || err != nil || strings.HasPrefix(rel, "..") {
			t.Fatalf("%s = %q, outside the test home %q", name, p, testConfigHome)
		}
	}
}
