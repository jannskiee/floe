package main

// The Explorer "Send with Floe" toggle: the registry key it owns, the command
// it expects to find there, and the bound methods behind the Settings switch.
// The registry calls live in contextmenu_windows.go, with stubs in
// contextmenu_other.go. This file carries no build tag because the startup
// self-heal in app.go calls into it behind a runtime GOOS check, so it must
// compile on every platform.

import (
	"fmt"
	"os"
)

// contextMenuBase is the per-user Explorer context-menu key for all file types.
const contextMenuBase = `Software\Classes\*\shell\Floe`

// expectedCommand is the context-menu launch command for the given executable.
func expectedCommand(exe string) string {
	return fmt.Sprintf(`"%s" "%%1"`, exe)
}

// IsPackaged reports whether this build runs with MSIX package identity (the
// Microsoft Store install). The Settings screen hides the Explorer
// context-menu toggle when it does: a packaged process's HKCU writes land in
// a private registry view that Explorer never reads, so the verb cannot work,
// and a Store uninstall runs no cleanup that could remove a stale entry.
func (a *App) IsPackaged() bool {
	return isPackaged()
}

// EnableContextMenu adds the "Send with Floe" entry to the Explorer right-click
// menu for the current user (Windows only, unpackaged builds only).
func (a *App) EnableContextMenu() error {
	if isPackaged() {
		// Unreachable through the UI (the toggle is hidden when packaged);
		// a clear error beats a write that would silently do nothing.
		return fmt.Errorf("the right-click menu is not available in the Microsoft Store build")
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return registerContextMenu(contextMenuBase, exe)
}

// DisableContextMenu removes the Explorer entry. Deliberately not gated on
// isPackaged: removal is harmless everywhere, so a cleanup call can never fail
// for channel reasons.
func (a *App) DisableContextMenu() error {
	return unregisterContextMenu(contextMenuBase)
}

// ContextMenuEnabled reports whether the entry exists and points at the current
// executable; a moved exe reads as disabled until re-enabled. Always false when
// packaged: the merged registry view could report an entry that Explorer does
// not actually show, and false is the truth that matters (the feature is off).
func (a *App) ContextMenuEnabled() bool {
	if isPackaged() {
		return false
	}
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	cmd, ok := contextMenuCommand(contextMenuBase)
	return ok && cmd == expectedCommand(exe)
}
