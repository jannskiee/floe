package selfupdate

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

// TestMain points the OS user directories at a temporary folder before any test
// runs, so no test (or a test under a mutation) can read or write the real
// update-check cache under os.UserConfigDir. The same guard as the desktop
// package's, added after a mutated desktop test wrote the owner's real
// desktop.json at CP-QA (2026-09-25).
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "floe-selfupdate-test-home-")
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

// The update-check cache resolves inside the temporary home while tests run.
func TestCacheFilePathStaysInTheTestHome(t *testing.T) {
	p := cacheFilePath()
	if p == "" {
		t.Fatal("cacheFilePath is empty")
	}
	rel, err := filepath.Rel(testConfigHome, p)
	if err != nil || strings.HasPrefix(rel, "..") {
		t.Fatalf("cacheFilePath = %q, outside the test home %q", p, testConfigHome)
	}
}
