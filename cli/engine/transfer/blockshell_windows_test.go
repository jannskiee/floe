package transfer

// Windows only on purpose (the _windows suffix is the build constraint): the
// Mark of the Web is an NTFS alternate data stream, as in motw_windows_test.go.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestBlockShellTypesKeepsMOTW: a file the hook renamed is still tagged as
// coming from the Internet zone. The tag is applied to the .part before the
// rename, so it has to survive both the hook's new name and the commit.
func TestBlockShellTypesKeepsMOTW(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	stubDisk(t, 0, 1<<40)
	dir := t.TempDir()
	run := runHostileIn(t, dir, metaFor("evil.url", 4, 1, 1, 4), []byte("abcd"), ReceiveOptions{Limits: hookLimits(true)})
	wantSaved(t, run, "evil.url.floe-blocked")
	zone, err := os.ReadFile(filepath.Join(dir, "evil.url.floe-blocked") + ":Zone.Identifier")
	if err != nil {
		t.Fatalf("read Zone.Identifier stream: %v", err)
	}
	if !strings.Contains(string(zone), "ZoneId=3") {
		t.Fatalf("Zone.Identifier = %q, want it to contain ZoneId=3", zone)
	}
}
