package main

// The request drop's own folder (dropfolder.go): the owner's label as one
// folder name, the name within the component limit, and the empty folders of
// a stopped drop removed without touching a kept .part.

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestSanitizeRequestLabel(t *testing.T) {
	long := strings.Repeat("a", 200)
	cases := []string{
		`a<b>c:d"e/f\g|h?i*j`, "tab\there", "bell\x07x", "photo\u202egnp", "a\u2066b",
		"CON", "com1", "LPT9", "nul", "name...  ", "  ", "", ".", "..", long, "Acme footage",
	}
	for _, in := range cases {
		got := sanitizeRequestLabel(in)
		if got == "" {
			t.Errorf("%q: empty folder name", in)
		}
		if strings.ContainsAny(got, "<>:\"/\\|?*") {
			t.Errorf("%q -> %q keeps a reserved character", in, got)
		}
		for _, r := range got {
			if r < 0x20 || r == 0x7f || (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069) {
				t.Errorf("%q -> %q keeps a control or bidi character", in, got)
			}
		}
		if strings.HasSuffix(got, ".") || strings.HasSuffix(got, " ") {
			t.Errorf("%q -> %q ends in a dot or space", in, got)
		}
		if isDeviceName(got) {
			t.Errorf("%q -> %q is a device name", in, got)
		}
		if n := len([]rune(got)); n > requestLabelMax {
			t.Errorf("%q -> %d runes, want at most %d", in, n, requestLabelMax)
		}
	}
	for in, want := range map[string]string{"": "Request", "  ": "Request", "..": "Request", "Acme footage": "Acme footage", long: strings.Repeat("a", 64)} {
		if got := sanitizeRequestLabel(in); got != want {
			t.Errorf("sanitizeRequestLabel(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestDropFolderNameFitsNameMax (review 1b N2): the drop folder's name, with
// its time stamp and a " (99)", stays within the 255-byte component limit of
// ext4 and APFS, whatever the label; the 64-rune label cap alone is 256 bytes
// of four-byte runes.
func TestDropFolderNameFitsNameMax(t *testing.T) {
	now := time.Date(2026, 9, 14, 14, 5, 0, 0, time.Local)
	astral := strings.Repeat(string(rune(0x1F600)), 64)
	for _, label := range []string{astral, strings.Repeat("a", 300), strings.Repeat(string(rune(0x4E2D)), 64), "Acme footage", ""} {
		name := dropFolderName(label, now) + " (99)"
		if len(name) > 255 {
			t.Errorf("label of %d bytes: folder name is %d bytes, over 255", len(label), len(name))
		}
		if !utf8.ValidString(name) {
			t.Errorf("label of %d bytes: the cut split a rune", len(label))
		}
		if !strings.HasSuffix(name, " 2026-09-14 1405 (99)") {
			t.Errorf("folder name %q lost its time stamp", name)
		}
	}
	if got := dropFolderName("", now); got != "Request 2026-09-14 1405" {
		t.Errorf("empty label gives %q", got)
	}
	dir, err := makeDropFolder(t.TempDir(), astral, now)
	if err != nil {
		t.Fatalf("a long label's drop folder could not be made: %v", err)
	}
	if len(filepath.Base(dir)) > 255 {
		t.Fatal("the created folder's name is over 255 bytes")
	}
}

// TestRemoveEmptyDirsKeepsAKeptPart (D-128): only empty folders go, deepest
// first; a kept .part keeps its folder and every folder above it, and with
// nothing left in it the drop folder goes too.
func TestRemoveEmptyDirsKeepsAKeptPart(t *testing.T) {
	root := filepath.Join(t.TempDir(), "Acme footage 2026-09-25 1654")
	for _, d := range []string{"Project/raw/deep", "Project/empty", "Other/a/b"} {
		if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(d)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	part := filepath.Join(root, "Project", "raw", "clip.mov.part")
	if err := os.WriteFile(part, []byte("verified bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	removeEmptyDirs(root)
	got := strings.Join(treeUnder(t, root), ",")
	if want := "Project,Project/raw,Project/raw/clip.mov.part"; got != want {
		t.Fatalf("left %q, want %q", got, want)
	}
	if b, err := os.ReadFile(part); err != nil || string(b) != "verified bytes" {
		t.Fatalf("the kept .part changed: %q, %v", b, err)
	}

	if err := os.Remove(part); err != nil {
		t.Fatal(err)
	}
	removeEmptyDirs(root)
	if _, err := os.Stat(root); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the emptied drop folder is still there: %v", err)
	}
	removeEmptyDirs(root) // a folder that is already gone is no error
}
