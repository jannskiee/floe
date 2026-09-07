// The de-collision scan and the session memory that keeps it linear.
//
// claimPart used to restart at index 0 for every incoming file, so N names that
// land on one name on disk cost N^2 Lstats. These tests pin the resume and the
// one thing that would silently defeat it: a case-insensitive filesystem, where
// two map keys are one file.
package transfer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestNameHintsFoldCaseWhereTheFilesystemDoes: on NTFS and a default APFS
// volume "Shot.png" and "shot.png" name one file, so they have to share a hint.
// Without the fold a sender shipping case variants of one name gets a cold scan
// each time and hands the quadratic back to whoever picks the names. On Linux
// they really are two files and must NOT share.
func TestNameHintsFoldCaseWhereTheFilesystemDoes(t *testing.T) {
	cases := []struct {
		goos   string
		shared bool
	}{
		{"windows", true},
		{"darwin", true},
		{"linux", false},
	}
	for _, tc := range cases {
		t.Run(tc.goos, func(t *testing.T) {
			h := newNameHints(tc.goos)
			h.record("/out/shot.png", 4)
			got := h.start("/out/Shot.png")
			want := 0
			if tc.shared {
				want = 5
			}
			if got != want {
				t.Fatalf("%s: start(Shot.png) after record(shot.png, 4) = %d, want %d", tc.goos, got, want)
			}
			// The same-case key always shares, on every platform.
			if same := h.start("/out/shot.png"); same != 5 {
				t.Fatalf("%s: start(shot.png) = %d, want 5", tc.goos, same)
			}
		})
	}
}

// TestNameHintsOnlyMoveForward: record must never walk a hint backward, or a
// later claim would rescan ground an earlier one already cleared.
func TestNameHintsOnlyMoveForward(t *testing.T) {
	h := newNameHints("linux")
	h.record("/out/a.bin", 9)
	h.record("/out/a.bin", 2)
	if got := h.start("/out/a.bin"); got != 10 {
		t.Fatalf("start after record(9) then record(2) = %d, want 10", got)
	}
}

// TestNilNameHintsScanFromScratch: a nil *nameHints is the no-memory case, used
// by tests that claim concurrently. nameHints is not safe for concurrent use;
// the receive loop is sequential and each ReceiveFilesWithOptions call gets its
// own.
func TestNilNameHintsScanFromScratch(t *testing.T) {
	var h *nameHints
	h.record("/out/a.bin", 7) // must not panic
	if got := h.start("/out/a.bin"); got != 0 {
		t.Fatalf("nil hints start = %d, want 0", got)
	}
}

// TestClaimPartResumesTheScan is the fix itself, asserted behaviorally rather
// than with a stopwatch.
//
// After N claims of one base the hint sits at N, so claim N+1 opens exactly one
// candidate instead of walking N of them. Freeing an earlier candidate proves
// the same thing from the other side: a cold scan would step back into the gap,
// and the resumed scan steps over it. That is the deliberate trade. The hint
// only moves forward, and O_EXCL, not the hint, is what makes a claim
// exclusive, so a skipped candidate costs a higher suffix and never a file.
func TestClaimPartResumesTheScan(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Join(dir, "a_b.txt")
	h := newNameHints("linux")

	var open []*os.File
	t.Cleanup(func() {
		// Windows refuses to remove a directory holding an open handle, and
		// os.Open does not pass FILE_SHARE_DELETE, so t.TempDir's own cleanup
		// fails unless every claim is closed first.
		for _, f := range open {
			_ = f.Close()
		}
	})

	for i, want := range []string{"a_b.txt", "a_b (1).txt", "a_b (2).txt", "a_b (3).txt"} {
		if got := h.start(base); got != i {
			t.Fatalf("claim %d started the scan at %d, want %d", i, got, i)
		}
		f, dest, err := claimPart(base, h)
		if err != nil {
			t.Fatalf("claim %d: %v", i, err)
		}
		open = append(open, f)
		if filepath.Base(dest) != want {
			t.Fatalf("claim %d landed on %q, want %q", i, filepath.Base(dest), want)
		}
	}
	if got := h.start(base); got != 4 {
		t.Fatalf("hint after four claims = %d, want 4", got)
	}

	// Free the middle candidate. A scan that restarted would take it back.
	if err := open[2].Close(); err != nil {
		t.Fatalf("close the claim being freed: %v", err)
	}
	if err := os.Remove(filepath.Join(dir, "a_b (2).txt"+partSuffix)); err != nil {
		t.Fatalf("free the middle candidate: %v", err)
	}

	f, dest, err := claimPart(base, h)
	if err != nil {
		t.Fatalf("claim after freeing: %v", err)
	}
	open = append(open, f)
	if got := filepath.Base(dest); got != "a_b (4).txt" {
		t.Fatalf("claim after freeing landed on %q, want %q (a restarted scan would reuse the freed name)", got, "a_b (4).txt")
	}
}

// TestClaimPartHintIsPerBasePath: a folder send puts the same base NAME in
// different directories, so the hint has to key on the full safeJoin output. A
// name-keyed map would number project/b/main.go as "main (1).go" because
// project/a/main.go had already been claimed.
func TestClaimPartHintIsPerBasePath(t *testing.T) {
	root := t.TempDir()
	h := newNameHints("linux")
	var open []*os.File
	t.Cleanup(func() {
		for _, f := range open {
			_ = f.Close()
		}
	})

	for _, sub := range []string{"a", "b"} {
		dir := filepath.Join(root, sub)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", sub, err)
		}
		f, dest, err := claimPart(filepath.Join(dir, "main.go"), h)
		if err != nil {
			t.Fatalf("claim in %s: %v", sub, err)
		}
		open = append(open, f)
		if got := filepath.Base(dest); got != "main.go" {
			t.Fatalf("claim in %s landed on %q, want main.go", sub, got)
		}
	}
}

// TestClaimPartCapIsNamed keeps the backstop honest: the bound is a constant, it
// is still the number the exhaustion error talks about, and exhausting it fails
// rather than looping.
func TestClaimPartCapIsNamed(t *testing.T) {
	if maxDecollide != 100000 {
		t.Fatalf("maxDecollide = %d; the cap is a backstop, not a tuning knob", maxDecollide)
	}
	dir := t.TempDir()
	base := filepath.Join(dir, "full.bin")
	h := newNameHints("linux")
	h.record(base, maxDecollide-1) // pretend the whole space is spoken for
	_, _, err := claimPart(base, h)
	if err == nil {
		t.Fatal("expected the exhausted-suffix error, got nil")
	}
	if !strings.Contains(err.Error(), "too many files named like") {
		t.Fatalf("error does not name the exhaustion: %v", err)
	}
}
