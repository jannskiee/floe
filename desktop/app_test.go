package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestWriteTextTemp verifies the text-send staging: exact content round-trip,
// the fixed message.txt name the receiver will see, and cleanup removing the
// temp directory.
func TestWriteTextTemp(t *testing.T) {
	const text = "hello floe\nline two · unicode ✓"

	path, cleanup, err := writeTextTemp(text)
	if err != nil {
		t.Fatalf("writeTextTemp: %v", err)
	}

	if got := filepath.Base(path); got != "message.txt" {
		t.Errorf("file name = %q, want message.txt", got)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != text {
		t.Errorf("content = %q, want %q", got, text)
	}

	cleanup()
	if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
		t.Errorf("cleanup did not remove the temp dir")
	}
}
