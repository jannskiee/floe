package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestShareLink guards the property that matters: the room id is the transfer's
// only secret, so it must live in the URL fragment, which browsers never send to
// a server. Anything before the '#' does reach the server, so the room id
// appearing there would leak it into access logs, Referer headers, and analytics.
func TestShareLink(t *testing.T) {
	const (
		base   = "https://floe.one"
		nonce  = "deadbeef"
		roomID = "6f207790-92a6-4662-bb68-4c4059f75139"
	)

	got := shareLink(base, nonce, roomID)

	if want := base + "/?s=" + nonce + "#room=" + roomID; got != want {
		t.Errorf("shareLink = %q, want %q", got, want)
	}

	// The invariant, asserted independently of the exact shape above.
	beforeFragment, _, found := strings.Cut(got, "#")
	if !found {
		t.Fatalf("shareLink = %q, want a '#' fragment", got)
	}
	if strings.Contains(beforeFragment, roomID) {
		t.Errorf("room id leaked into the server-visible part %q", beforeFragment)
	}
	if strings.Contains(got, "?room=") {
		t.Errorf("shareLink = %q, must not use the leaky ?room= form", got)
	}
	if strings.Contains(got, base+"//") {
		t.Errorf("shareLink = %q, has a double slash after the host", got)
	}
}

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

// TestFilterFileArgs verifies command-line arg filtering keeps only existing
// files/dirs and drops flags, empties, and stale paths.
func TestFilterFileArgs(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	got := filterFileArgs([]string{
		file,
		dir,
		filepath.Join(dir, "missing.bin"),
		"--flag",
		"-v",
		"",
	})

	if len(got) != 2 || got[0] != file || got[1] != dir {
		t.Errorf("filterFileArgs = %v, want [%s %s]", got, file, dir)
	}
}

// TestCancelTransferIdle guards the Start-over path, which calls CancelTransfer
// unconditionally: with no transfer in flight (nil curSC/curConn) it must be a
// safe no-op, never a nil-dereference panic.
func TestCancelTransferIdle(t *testing.T) {
	(&App{}).CancelTransfer()
}
