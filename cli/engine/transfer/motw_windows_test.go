//go:build windows

package transfer

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestApplyMOTW proves a received file gets the Windows Mark-of-the-Web tag: a
// Zone.Identifier stream marking it Internet-sourced (ZoneId=3). t.TempDir() is
// on the system drive (NTFS), which supports alternate data streams.
func TestApplyMOTW(t *testing.T) {
	p := filepath.Join(t.TempDir(), "received.bin")
	if err := os.WriteFile(p, []byte("payload"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := applyMOTW(p); err != nil {
		t.Fatalf("applyMOTW: %v", err)
	}
	zone, err := os.ReadFile(p + ":Zone.Identifier")
	if err != nil {
		t.Fatalf("read Zone.Identifier stream: %v", err)
	}
	if !strings.Contains(string(zone), "ZoneId=3") {
		t.Errorf("Zone.Identifier = %q, want it to contain ZoneId=3", zone)
	}
}
