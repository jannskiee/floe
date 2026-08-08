//go:build windows

package main

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// MSIX package-identity detection. A Microsoft Store install runs with a
// package identity, and two things change under it: the process's HKCU writes
// land in a private per-package registry view that Explorer never reads (so
// the "Send with Floe" verb cannot work), and a Store uninstall runs no
// cleanup code that could remove a verb pointing at the versioned WindowsApps
// exe path. The context-menu feature is therefore hidden when packaged; see
// the guards in app.go.
//
// Verified empirically against a loose-layout package of this app (2026-08):
// the app's registry writes were virtualized into the package's private hive
// while its file writes went to the real %APPDATA%, so only the
// registry-dependent feature needs gating and the CLI-shared config keeps
// working.

// procGetCurrentPackageFullName reuses the kernel32 lazy DLL declared in
// clipboard_windows.go (same package main, both windows-tagged).
var procGetCurrentPackageFullName = kernel32.NewProc("GetCurrentPackageFullName")

// isPackaged reports whether the process runs with MSIX package identity.
//
// GetCurrentPackageFullName returns its win32 error code directly:
// ERROR_INSUFFICIENT_BUFFER (122) when there IS a package name to return
// (we pass no buffer), APPMODEL_ERROR_NO_PACKAGE (15700) when unpackaged.
// Fail-open: anything but the unambiguous "packaged" answer counts as
// unpackaged, so the NSIS/portable builds can never lose the context-menu
// feature to a probe hiccup.
func isPackaged() bool {
	var length uint32
	r, _, _ := procGetCurrentPackageFullName.Call(
		uintptr(unsafe.Pointer(&length)),
		0,
	)
	return r == uintptr(windows.ERROR_INSUFFICIENT_BUFFER)
}
