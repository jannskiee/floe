package main

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

// buildDropFiles builds a wide (UTF-16) CF_HDROP payload for the given paths so
// parseDropFiles can be exercised without the OS clipboard.
func buildDropFiles(paths []string) []byte {
	const headerLen = 20
	buf := make([]byte, headerLen)
	binary.LittleEndian.PutUint32(buf[0:4], headerLen) // pFiles = offset to the list
	binary.LittleEndian.PutUint32(buf[16:20], 1)       // fWide = true
	for _, p := range paths {
		for _, u := range utf16.Encode([]rune(p)) {
			var b [2]byte
			binary.LittleEndian.PutUint16(b[:], u)
			buf = append(buf, b[:]...)
		}
		buf = append(buf, 0, 0) // null-terminate this path (one UTF-16 unit)
	}
	buf = append(buf, 0, 0) // final double-null
	return buf
}

func TestParseDropFilesWide(t *testing.T) {
	want := []string{`C:\Users\me\a.txt`, `D:\pics\b.png`}
	got := parseDropFiles(buildDropFiles(want))
	if len(got) != len(want) {
		t.Fatalf("count = %d, want %d (%v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("path[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestParseDropFilesSingleWithSpaces(t *testing.T) {
	want := []string{`C:\a b\c d.dat`}
	got := parseDropFiles(buildDropFiles(want))
	if len(got) != 1 || got[0] != want[0] {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestParseDropFilesMalformed(t *testing.T) {
	if got := parseDropFiles(nil); got != nil {
		t.Errorf("nil input: got %v, want nil", got)
	}
	if got := parseDropFiles([]byte{1, 2, 3}); got != nil {
		t.Errorf("short input: got %v, want nil", got)
	}
	if got := parseDropFiles(buildDropFiles(nil)); len(got) != 0 {
		t.Errorf("no paths: got %v, want empty", got)
	}
}

// TestPastedImageName checks the timestamped, receiver-visible screenshot name.
func TestPastedImageName(t *testing.T) {
	ts := time.Date(2026, 7, 20, 21, 30, 45, 0, time.UTC)
	if got := pastedImageName(ts); got != "pasted-image-20260720-213045.png" {
		t.Errorf("pastedImageName = %q, want pasted-image-20260720-213045.png", got)
	}
}

// TestWriteImageTemp verifies pasted-image staging: a timestamped pasted-image
// name the receiver sees and an exact byte round-trip.
func TestWriteImageTemp(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\n fake body")
	path, err := writeImageTemp(png)
	if err != nil {
		t.Fatalf("writeImageTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(filepath.Dir(path)) })

	if base := filepath.Base(path); !strings.HasPrefix(base, "pasted-image-") || !strings.HasSuffix(base, ".png") {
		t.Errorf("name = %q, want pasted-image-<timestamp>.png", base)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != string(png) {
		t.Errorf("content mismatch")
	}
}

// TestSweepPasteTemps checks the startup sweep removes floe-paste-* directories
// and leaves the text-send staging (floe-text-*) alone.
func TestSweepPasteTemps(t *testing.T) {
	pasteDir, err := os.MkdirTemp("", "floe-paste-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(pasteDir) })
	textDir, err := os.MkdirTemp("", "floe-text-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(textDir) })

	sweepPasteTemps()

	if _, err := os.Stat(pasteDir); !os.IsNotExist(err) {
		t.Errorf("sweep did not remove the paste dir %s", pasteDir)
	}
	if _, err := os.Stat(textDir); err != nil {
		t.Errorf("sweep wrongly removed the text-send dir: %v", err)
	}
}
