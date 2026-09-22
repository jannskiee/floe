//go:build windows

package main

// Getting the owner's attention for a waiting request without a toast: the
// taskbar button flashes until the window comes to the foreground (spec 06
// 4.10). Wails v2 has no flash API, so this goes through user32 directly, the
// lazy DLL clipboard_windows.go declares. Nothing here carries text of any
// kind, so no visitor string can reach it.

import (
	"os"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	procEnumWindows              = user32.NewProc("EnumWindows")
	procGetWindowThreadProcessId = user32.NewProc("GetWindowThreadProcessId")
	procIsWindowVisible          = user32.NewProc("IsWindowVisible")
	procFlashWindowEx            = user32.NewProc("FlashWindowEx")
)

// FLASHWINFO dwFlags (winuser.h).
const (
	flashwStop      = 0
	flashwAll       = 3  // FLASHW_CAPTION | FLASHW_TRAY
	flashwTimerNoFG = 12 // flash until the window comes to the foreground
)

// flashWInfo is FLASHWINFO. On amd64 it is 32 bytes: 4, 4 of padding, the
// 8-byte handle, three 4-byte fields and 4 of padding. cbSize is always
// computed with unsafe.Sizeof, never written as a number.
type flashWInfo struct {
	cbSize    uint32
	hwnd      uintptr
	dwFlags   uint32
	uCount    uint32
	dwTimeout uint32
}

// enumMu serializes findOwnWindow: the EnumWindows callback reports through
// the two package variables below instead of through its lparam, so no
// foreign address is ever converted to an unsafe.Pointer (go vet unsafeptr).
var (
	enumMu    sync.Mutex
	enumPID   uint32
	enumFound uintptr
	// enumCB is created once: windows.NewCallback slots are never freed.
	enumCB = windows.NewCallback(func(hwnd, _ uintptr) uintptr {
		var pid uint32
		procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
		if pid != enumPID {
			return 1 // keep enumerating
		}
		if visible, _, _ := procIsWindowVisible.Call(hwnd); visible == 0 {
			return 1
		}
		enumFound = hwnd
		return 0 // stop
	})
)

// findOwnWindow returns this process's visible top-level window, or 0 when
// it has none (a test process, or before the window exists).
func findOwnWindow() uintptr {
	enumMu.Lock()
	defer enumMu.Unlock()
	enumPID = uint32(os.Getpid())
	enumFound = 0
	procEnumWindows.Call(enumCB, 0)
	return enumFound
}

// flashWindow sends one FLASHWINFO for this process's window; a no-op when
// there is no window.
func flashWindow(flags uint32) {
	hwnd := findOwnWindow()
	if hwnd == 0 {
		return
	}
	fi := flashWInfo{hwnd: hwnd, dwFlags: flags}
	fi.cbSize = uint32(unsafe.Sizeof(fi))
	procFlashWindowEx.Call(uintptr(unsafe.Pointer(&fi)))
}

// flashTaskbar flashes the taskbar button and caption until the owner brings
// Floe to the foreground (count 0, default rate).
func flashTaskbar() { flashWindow(flashwAll | flashwTimerNoFG) }

// stopFlash stops the flash and restores the button.
func stopFlash() { flashWindow(flashwStop) }
