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
// Found at CP-QA (2026-09-25): under a mutation of requestLinksChange,
// TestSetRequestLinksOnNeedsRequest1's SetRequestLinks(true) reached
// saveConfig(configPath()) and wrote its fake server's settings over the
// owner's real desktop.json. A green run never saves there, which is why no
// earlier run noticed; this makes the whole package safe regardless.
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
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

// The settings file, the WebView2 profile and the update cache all resolve
// inside the temporary home while tests run.
func TestConfigPathsStayInTheTestHome(t *testing.T) {
	for name, p := range map[string]string{"configPath": configPath(), "webviewDataPath": webviewDataPath()} {
		if p == "" {
			t.Fatalf("%s is empty", name)
		}
		rel, err := filepath.Rel(testConfigHome, p)
		if err != nil || strings.HasPrefix(rel, "..") {
			t.Fatalf("%s = %q, outside the test home %q", name, p, testConfigHome)
		}
	}
}
