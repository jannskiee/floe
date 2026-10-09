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
	// The temp directory too (review A R4), where Apply stages a download: a
	// test's temp files stay in the home. The home itself was made in the real
	// temp directory above, before this override.
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

// The update-check cache and the temp directory (where Apply stages a
// download) resolve inside the temporary home while tests run.
func TestCacheFilePathStaysInTheTestHome(t *testing.T) {
	for name, p := range map[string]string{"cacheFilePath": cacheFilePath(), "os.TempDir": os.TempDir()} {
		if p == "" {
			t.Fatalf("%s is empty", name)
		}
		rel, err := filepath.Rel(testConfigHome, p)
		if err != nil || strings.HasPrefix(rel, "..") {
			t.Fatalf("%s = %q, outside the test home %q", name, p, testConfigHome)
		}
	}
}
