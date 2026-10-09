package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// testConfigHome is the temporary folder TestMain points every OS user
// directory at for the whole package.
var testConfigHome string

// TestMain points the OS user directories (os.UserConfigDir, UserCacheDir and
// UserHomeDir on every platform) at a temporary folder before any test runs, so
// no test can read or write the real %APPDATA%\floe (desktop.json, the update
// check cache, the pinned WebView2 profile) or the real Downloads folder.
//
// Found at CP-QA (2026-09-25): under a mutation of a settings setter's guard,
// a test's call to that setter reached saveConfig(configPath()) and wrote its
// fake server's settings over the owner's real desktop.json. A green run never
// saves there, which is why no earlier run noticed; this makes the whole
// package safe regardless.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "floe-desktop-test-home-")
	if err != nil {
		fmt.Fprintln(os.Stderr, "TestMain: temporary home:", err)
		os.Exit(1)
	}
	testConfigHome = dir
	for _, k := range []string{"APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"} {
		os.Setenv(k, dir)
	}
	// The temp directory too (review A R4): TestSweepPasteTemps removes every
	// floe-paste-* folder under os.TempDir, which outside the test home is
	// where a running Floe Desktop stages a pasted image for a send. The home
	// itself was made in the real temp directory above, before this override.
	tmp := filepath.Join(dir, "tmp")
	if err := os.Mkdir(tmp, 0o700); err != nil {
		fmt.Fprintln(os.Stderr, "TestMain: temporary temp dir:", err)
		os.Exit(1)
	}
	for _, k := range []string{"TMP", "TEMP", "TMPDIR"} {
		os.Setenv(k, tmp)
	}
	// Whether Floe is the foreground window is a fact about the machine the
	// tests run on, and it would silently swallow every toast a test expects.
	// TestNotifySkippedWhileFloeInFront sets it itself.
	floeInFrontFn = func() bool { return false }
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

// The settings file, the WebView2 profile, the update cache, the default save
// folder (Downloads, taken here since the home has one for this test) and the
// temp directory all resolve inside the temporary home while tests run.
func TestConfigPathsStayInTheTestHome(t *testing.T) {
	downloads := filepath.Join(testConfigHome, "Downloads")
	if err := os.Mkdir(downloads, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Remove(downloads) })
	if got := defaultReceiveDir(); got != downloads {
		t.Fatalf("defaultReceiveDir = %q, want the test home's Downloads %q", got, downloads)
	}
	for name, p := range map[string]string{
		"configPath":        configPath(),
		"webviewDataPath":   webviewDataPath(),
		"updateCachePath":   updateCachePath(),
		"defaultReceiveDir": defaultReceiveDir(),
		"os.TempDir":        os.TempDir(),
	} {
		if p == "" {
			t.Fatalf("%s is empty", name)
		}
		rel, err := filepath.Rel(testConfigHome, p)
		if err != nil || strings.HasPrefix(rel, "..") {
			t.Fatalf("%s = %q, outside the test home %q", name, p, testConfigHome)
		}
	}
}
