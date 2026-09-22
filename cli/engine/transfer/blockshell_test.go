package transfer

// The name hook (blockshell.go, E-41): the pure table first, then the hook in
// a real receive. FuzzNameHook in fuzz_test.go holds the properties over
// arbitrary names; blockshell_windows_test.go checks the Mark of the Web.

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// e41Extensions is the E-41 table written out here, not read from
// blockedExtensions, so dropping an entry from the package list fails a row.
var e41Extensions = []string{".lnk", ".url", ".library-ms", ".searchConnector-ms", ".scf", ".theme", ".themepack", ".website", ".search-ms"}

const testCLSID = "{ED7BA470-8E54-465E-825C-99712043E01C}"

// hookRel runs a sender's name through safeJoin and the hook the way the
// receive loop does, and returns the result in slash form.
func hookRel(name string) (string, bool) {
	out, renamed := blockShellTypes(safeJoin("", name))
	return filepath.ToSlash(out), renamed
}

// alternateCase upper-cases every other letter: ".lNk" style.
func alternateCase(s string) string {
	var b strings.Builder
	for i, r := range s {
		if i%2 == 1 {
			b.WriteString(strings.ToUpper(string(r)))
		} else {
			b.WriteString(strings.ToLower(string(r)))
		}
	}
	return b.String()
}

// TestBlockShellTypesTable (VR2-06): every E-41 extension in lower, upper and
// mixed case, desktop.ini at any depth, trailing dots and spaces, names that
// only contain a blocked extension, and the class ID strip on folders and
// leaves, including a strip that would leave a traversal segment.
func TestBlockShellTypesTable(t *testing.T) {
	type row struct {
		in      string
		want    string
		renamed bool
	}
	var rows []row
	for _, ext := range e41Extensions {
		for _, e := range []string{strings.ToLower(ext), strings.ToUpper(ext), alternateCase(ext)} {
			rows = append(rows, row{"evil" + e, "evil" + e + ".floe-blocked", true})
		}
	}
	rows = append(rows,
		row{"a/b/c/desktop.ini", "a/b/c/desktop.ini.floe-blocked", true},
		row{"a/b/c/DESKTOP.INI", "a/b/c/DESKTOP.INI.floe-blocked", true},
		row{"Desktop.Ini", "Desktop.Ini.floe-blocked", true},
		// Windows drops trailing dots and spaces, so these open as .lnk.
		row{"evil.lnk.", "evil.lnk.floe-blocked", true},
		row{"evil.lnk ", "evil.lnk.floe-blocked", true},
		row{"evil.lnk. . ", "evil.lnk.floe-blocked", true},
		// Case folds Windows applies and a byte compare would miss: the
		// Kelvin sign folds to k, and the long s and dotless i upper-case to
		// S and I.
		row{"evil.ln\u212a", "evil.ln\u212a.floe-blocked", true},
		row{"evil.\u017fcf", "evil.\u017fcf.floe-blocked", true},
		row{"desktop.\u0131n\u0131", "desktop.\u0131n\u0131.floe-blocked", true},
		// Only the last extension counts, and only a whole leaf is desktop.ini.
		row{"a.lnk.txt", "a.lnk.txt", false},
		row{"x.lnkx", "x.lnkx", false},
		row{"lnk", "lnk", false},
		row{"desktop.ini.txt", "desktop.ini.txt", false},
		row{"mydesktop.ini", "mydesktop.ini", false},
		row{"x.floe-blocked", "x.floe-blocked", false},
		row{"folder.lnk/readme.txt", "folder.lnk/readme.txt", false},
		// The class ID strip, on every component.
		row{"Folder." + testCLSID + "/x.txt", "Folder/x.txt", false},
		row{"Folder." + testCLSID, "Folder", false},
		row{"x." + strings.ToLower(testCLSID), "x", false},
		row{"x.lnk." + testCLSID, "x.lnk.floe-blocked", true},
		row{"x." + testCLSID + "." + testCLSID, "x", false},
		// Windows drops trailing dots and spaces, so these are junctions too.
		row{"x." + testCLSID + "./y.txt", "x/y.txt", false},
		row{"x." + testCLSID + " ." + testCLSID + "/y.txt", "x/y.txt", false},
		row{"a/b." + testCLSID + "/c." + testCLSID + "/d.txt", "a/b/c/d.txt", false},
		// A strip that leaves nothing, or a traversal segment, drops the
		// component exactly as safeJoin would have.
		row{"." + testCLSID + "/a.txt", "a.txt", false},
		row{"..." + testCLSID + "/a.txt", "a.txt", false},
		row{"x/..." + testCLSID + "/a.txt", "x/a.txt", false},
		row{"." + testCLSID, "received_file", false},
		// Not a class ID: left alone.
		row{"x.{ED7BA470-8E54-465E-825C-99712043E01}", "x.{ED7BA470-8E54-465E-825C-99712043E01}", false},
		row{"x" + testCLSID, "x" + testCLSID, false},
		row{"x.{not-a-class-id}", "x.{not-a-class-id}", false},
		row{"a.txt", "a.txt", false},
	)
	// What the strip exposes meets the same Windows rules safeJoin applies.
	rows = append(rows,
		row{"Folder ." + testCLSID + "/x.txt", sanitizeComponent("Folder ", runtime.GOOS) + "/x.txt", false},
		row{"CON." + testCLSID, sanitizeComponent("CON", runtime.GOOS), false},
	)
	for _, r := range rows {
		got, renamed := hookRel(r.in)
		if got != r.want || renamed != r.renamed {
			t.Errorf("blockShellTypes(%q) = %q, %v; want %q, %v", r.in, got, renamed, r.want, r.renamed)
		}
	}
	// The package list is the E-41 table, no more and no fewer.
	if len(blockedExtensions) != len(e41Extensions) {
		t.Errorf("blockedExtensions has %d entries, E-41 lists %d", len(blockedExtensions), len(e41Extensions))
	}
}

// TestBlockShellTypesStripIsLinear: stripping a stack of class IDs costs time
// in proportion to the name, not its square. FuzzNameHook found the square
// (2,000 stacked in 78 KB took 2.1 s); 20,000 would take minutes that way and
// takes milliseconds this way, so the bound below has room for a slow machine.
func TestBlockShellTypesStripIsLinear(t *testing.T) {
	name := "x" + strings.Repeat("."+testCLSID, 20000)
	start := time.Now()
	got, _ := hookRel(name)
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("stripping 20,000 class IDs took %v", took)
	}
	if got != "x" {
		t.Fatalf("got %q, want x", got)
	}
}

// hookLimits is a request link's limits with the hook on, and a reserve of 0
// so the free-space stub never matters.
func hookLimits(block bool) *ReceiveLimits {
	return &ReceiveLimits{MaxFiles: 10000, BlockShellTypes: block}
}

// TestBlockShellTypesDecollides: a renamed file de-collides like any other
// name. With x.lnk.floe-blocked already in the folder, a second x.lnk lands
// as "x.lnk (1).floe-blocked" (still ending in .floe-blocked, which is what
// the desktop counts), the existing file is untouched, and FileDone reports
// the renamed name.
func TestBlockShellTypesDecollides(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	stubDisk(t, 0, 1<<40)
	dir := t.TempDir()
	existing := filepath.Join(dir, "x.lnk.floe-blocked")
	if err := os.WriteFile(existing, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var saved []string
	opts := ReceiveOptions{Limits: hookLimits(true), OnFileDone: func(d FileDone) {
		mu.Lock()
		saved = append(saved, d.SavedName)
		mu.Unlock()
	}}
	run := runHostileIn(t, dir, metaFor("x.lnk", 4, 1, 1, 4), []byte("abcd"), opts)
	wantSaved(t, run, "x.lnk (1).floe-blocked", "x.lnk.floe-blocked")
	if got, _ := os.ReadFile(existing); string(got) != "old" {
		t.Fatalf("the existing x.lnk.floe-blocked now holds %q", got)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "x.lnk (1).floe-blocked")); string(got) != "abcd" {
		t.Fatalf("the new file holds %q", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(saved) != 1 || saved[0] != "x.lnk (1).floe-blocked" {
		t.Fatalf("FileDone SavedName %v, want [x.lnk (1).floe-blocked]", saved)
	}
}

// TestBlockShellTypesRenameCountsTowardLength: the hook runs before layer 1's
// depth and length checks (spec 05 8.3), so they measure the name that will
// be claimed. 222 characters plus ".lnk" is 231 units with ".part", inside
// 240, and arrives as sent with the hook off; renamed it would be 244, so with
// the hook on it is refused before anything is created.
func TestBlockShellTypesRenameCountsTowardLength(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	name := strings.Repeat("l", 222) + ".lnk"
	stubDisk(t, 0, 1<<40)
	wantSaved(t, runHostile(t, metaFor(name, 4, 1, 1, 4), []byte("abcd"), ReceiveOptions{Limits: hookLimits(false)}), name)
	run := runHostile(t, metaFor(name, 4, 1, 1, 4), []byte("abcd"), ReceiveOptions{Limits: hookLimits(true)})
	if run.incoming != 0 {
		t.Fatalf("OnIncoming fired %d times for a name the receiver refuses", run.incoming)
	}
	wantRefused(t, run, CodePathTooLong, CodePathTooLong.WireReason(), "llll")
}

// TestBlockShellTypesOffByDefault: with Limits nil, the plain CLI and code
// receive, and with BlockShellTypes false, nothing is renamed and no class ID
// is stripped.
func TestBlockShellTypesOffByDefault(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	if got, renamed := hookRel("evil.lnk"); got != "evil.lnk.floe-blocked" || !renamed {
		t.Fatalf("the hook itself does not rename evil.lnk (%q, %v), so this test would prove nothing", got, renamed)
	}
	junction := "Folder." + testCLSID
	for _, tc := range []struct {
		name   string
		limits *ReceiveLimits
	}{
		{"nil limits", nil},
		{"BlockShellTypes false", hookLimits(false)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stubDisk(t, 0, 1<<40)
			wantSaved(t, runHostile(t, metaFor("evil.lnk", 4, 1, 1, 4), []byte("abcd"), ReceiveOptions{Limits: tc.limits}), "evil.lnk")
			wantSaved(t, runHostile(t, metaFor(junction+"/x.txt", 4, 1, 1, 4), []byte("abcd"), ReceiveOptions{Limits: tc.limits}), junction+"/", junction+"/x.txt")
		})
	}
	t.Run("BlockShellTypes true", func(t *testing.T) {
		stubDisk(t, 0, 1<<40)
		wantSaved(t, runHostile(t, metaFor("evil.lnk", 4, 1, 1, 4), []byte("abcd"), ReceiveOptions{Limits: hookLimits(true)}), "evil.lnk.floe-blocked")
		wantSaved(t, runHostile(t, metaFor(junction+"/x.txt", 4, 1, 1, 4), []byte("abcd"), ReceiveOptions{Limits: hookLimits(true)}), "Folder/", "Folder/x.txt")
	})
}
