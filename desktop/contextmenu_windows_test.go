//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows/registry"
)

// TestContextMenuRoundTrip exercises the registry helpers against an inert key
// (not under Software\Classes, so it never appears in Explorer), cleaning up
// the whole test subtree afterwards.
func TestContextMenuRoundTrip(t *testing.T) {
	const base = `Software\FloeTest\shell\Send`
	t.Cleanup(func() {
		_ = unregisterContextMenu(base)
		_ = registry.DeleteKey(registry.CURRENT_USER, `Software\FloeTest\shell`)
		_ = registry.DeleteKey(registry.CURRENT_USER, `Software\FloeTest`)
	})

	const exe = `C:\fake\floe-desktop.exe`
	if err := registerContextMenu(base, exe); err != nil {
		t.Fatalf("register: %v", err)
	}

	cmd, ok := contextMenuCommand(base)
	if !ok {
		t.Fatal("command key missing after register")
	}
	if want := expectedCommand(exe); cmd != want {
		t.Errorf("command = %q, want %q", cmd, want)
	}

	if err := unregisterContextMenu(base); err != nil {
		t.Fatalf("unregister: %v", err)
	}
	if _, ok := contextMenuCommand(base); ok {
		t.Error("command key still present after unregister")
	}
	if err := unregisterContextMenu(base); err != nil {
		t.Errorf("second unregister should be a no-op, got %v", err)
	}
}

// TestContextMenuStateReadsTheRegistry (DSK-04): the entry as registerContextMenu
// writes it reads back as missing before it exists, then as this copy's, as
// another live copy's, and as dead once that copy's program is gone
// (DESKTOP-01). The same inert key as the round trip above, never the one
// Explorer reads.
func TestContextMenuStateReadsTheRegistry(t *testing.T) {
	const base = `Software\FloeTest\shell\State`
	t.Cleanup(func() {
		_ = unregisterContextMenu(base)
		_ = registry.DeleteKey(registry.CURRENT_USER, `Software\FloeTest\shell`)
		_ = registry.DeleteKey(registry.CURRENT_USER, `Software\FloeTest`)
	})
	dir := t.TempDir()
	self := filepath.Join(dir, "a", "floe-desktop.exe")
	other := filepath.Join(dir, "b", "floe-desktop.exe")
	for _, p := range []string{self, other} {
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("app"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	state := func() string {
		cmd, ok := contextMenuCommand(base)
		return contextMenuStateOf(self, cmd, ok)
	}
	if got := state(); got != ctxMenuMissing {
		t.Fatalf("no entry: %q", got)
	}
	if err := registerContextMenu(base, self); err != nil {
		t.Fatal(err)
	}
	if got := state(); got != ctxMenuSelf {
		t.Fatalf("this copy's entry: %q", got)
	}
	if err := registerContextMenu(base, other); err != nil {
		t.Fatal(err)
	}
	if got := state(); got != ctxMenuOther {
		t.Fatalf("another copy's entry: %q", got)
	}
	if err := os.RemoveAll(filepath.Dir(other)); err != nil {
		t.Fatal(err)
	}
	if got := state(); got != ctxMenuDead {
		t.Fatalf("an entry whose program was deleted: %q", got)
	}
}
