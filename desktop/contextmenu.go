package main

// The Explorer "Send with Floe" toggle: the registry key it owns, the command
// it expects to find there, and the bound methods behind the Settings switch.
// The registry calls live in contextmenu_windows.go, with stubs in
// contextmenu_other.go. This file carries no build tag: its bound methods
// exist on every platform, where the stubs make the entry read as missing.

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// contextMenuBase is the per-user Explorer context-menu key for all file types.
const contextMenuBase = `Software\Classes\*\shell\Floe`

// expectedCommand is the context-menu launch command for the given executable.
func expectedCommand(exe string) string {
	return fmt.Sprintf(`"%s" "%%1"`, exe)
}

// executable is os.Executable, a variable only so a test can name the path
// IsInstalled judges by.
var executable = os.Executable

// The five answers of ContextMenuState, read by initCtxMenu in App.tsx.
const (
	ctxMenuSelf     = "self"
	ctxMenuOther    = "other"
	ctxMenuMissing  = "missing"
	ctxMenuDead     = "dead"
	ctxMenuPackaged = "packaged"
)

// IsInstalled reports whether this copy came from the installer: the NSIS
// installer writes uninstall.exe beside the app (project.nsi), and an
// unzipped portable copy has none. The frontend registers the Explorer entry
// unasked only on an installed copy (DSK-04, owner answer 26: off by default
// on portable), because deleting a portable folder leaves the entry behind
// with nothing to run, and no uninstaller to remove it.
func (a *App) IsInstalled() bool {
	exe, err := executable()
	if err != nil || exe == "" {
		return false
	}
	fi, err := os.Stat(filepath.Join(filepath.Dir(exe), "uninstall.exe"))
	return err == nil && fi.Mode().IsRegular()
}

// ContextMenuState names whose the Explorer entry is, for the frontend's
// launch rule (initCtxMenu in App.tsx): "self" when it runs this executable,
// "other" when it runs another copy, "dead" when it runs a program that no
// longer exists, "missing" when there is none, and "packaged" in a Store
// build, where the entry cannot work and nothing reads the registry (see
// IsPackaged). The frontend never re-points "other": that is another copy's
// entry, and only the owner's switch moves it here.
func (a *App) ContextMenuState() string {
	if isPackaged() {
		return ctxMenuPackaged
	}
	exe, _ := executable()
	cmd, ok := contextMenuCommand(contextMenuBase)
	return contextMenuStateOf(exe, cmd, ok)
}

// contextMenuStateOf is ContextMenuState's decision, apart from the registry.
//
// An entry whose program no longer exists (its portable folder was deleted or
// replaced) is dead: no copy's, and broken in Explorer. It has a state of its
// own rather than reading as missing (DESKTOP-01), because the launch rule
// treats it as missing for registering and must also remove it when this
// copy registers nothing: Floe Desktop 0.3.0 registered the entry on the
// first run of every copy and recorded no choice, so a 0.3.0 portable copy
// that was deleted leaves one behind with no marker to say the owner wanted
// it. A command in a shape Floe never writes is someone else's and reads as
// other, so it is left alone.
//
// "self" compares the program with this executable the way the file system
// does (sameProgram), so the same copy launched under another spelling of
// its path is still itself (DESKTOP-02).
func contextMenuStateOf(exe, cmd string, registered bool) string {
	if !registered {
		return ctxMenuMissing
	}
	target, ok := commandProgram(cmd)
	if !ok {
		return ctxMenuOther
	}
	if exe != "" && sameProgram(target, exe) {
		return ctxMenuSelf
	}
	if _, err := os.Stat(target); os.IsNotExist(err) {
		return ctxMenuDead
	}
	return ctxMenuOther
}

// sameProgram reports whether two paths name one program. On Windows a path
// ignores letter case, and the case an executable reports is the case it was
// launched with (os.Executable is GetModuleFileName, which keeps it): a
// folder typed in lower case on the installer's page and the same exe
// double-clicked in Explorer give two spellings of one copy (DESKTOP-02).
// Elsewhere letter case is part of the name.
func sameProgram(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// commandProgram is the program of a command in the shape expectedCommand
// writes ("<exe>" "%1"), and false for any other shape.
func commandProgram(cmd string) (string, bool) {
	exe, ok := strings.CutSuffix(cmd, `" "%1"`)
	if !ok || !strings.HasPrefix(exe, `"`) {
		return "", false
	}
	exe = exe[1:]
	if exe == "" || strings.Contains(exe, `"`) {
		return "", false
	}
	return exe, true
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
// The frontend reads ContextMenuState instead; this stays bound so the
// generated bindings only grow, and it answers from the same decision, so the
// two never disagree about whose the entry is (DESKTOP-02).
func (a *App) ContextMenuEnabled() bool {
	return a.ContextMenuState() == ctxMenuSelf
}
