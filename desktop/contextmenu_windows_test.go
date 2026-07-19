//go:build windows

package main

import (
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
