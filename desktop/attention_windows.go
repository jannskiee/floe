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
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	procEnumWindows              = user32.NewProc("EnumWindows")
	procGetWindowThreadProcessId = user32.NewProc("GetWindowThreadProcessId")
	procIsWindowVisible          = user32.NewProc("IsWindowVisible")
	procFlashWindowEx            = user32.NewProc("FlashWindowEx")
	procGetForegroundWindow      = user32.NewProc("GetForegroundWindow")
	procGetLastInputInfo         = user32.NewProc("GetLastInputInfo")
	procGetTickCount             = kernel32.NewProc("GetTickCount")
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

// inFrontIdleLimit is how long the PC may sit unused before Floe's own
// foreground window stops counting as "in front": a window left open in front
// of an empty chair is where a toast is most needed.
const inFrontIdleLimit = 60 * time.Second

// lastInputInfo is LASTINPUTINFO: 8 bytes, cbSize then the tick count of the
// last keyboard or mouse input. cbSize is always computed with unsafe.Sizeof.
type lastInputInfo struct {
	cbSize uint32
	dwTime uint32
}

// inFront is the foreground rule (S-12): the window in front belongs to this
// process and the PC was used within the idle limit. A foreground window of
// nobody's (pid 0: a lock screen, a window switch in progress) is never Floe.
func inFront(fgPID, ownPID uint32, idle time.Duration) bool {
	return fgPID != 0 && fgPID == ownPID && idle < inFrontIdleLimit
}

// idleSince is the time since the last input. Both clocks are 32-bit
// milliseconds that wrap every 49.7 days, so the difference is taken in
// uint32: across a wrap it is still the small number it should be.
func idleSince(tick, last uint32) time.Duration {
	return time.Duration(tick-last) * time.Millisecond
}

// getLastInputInfo is the GetLastInputInfo call, a seam so a test can see the
// struct as Windows is handed it.
var getLastInputInfo = func(li *lastInputInfo) bool {
	ok, _, _ := procGetLastInputInfo.Call(uintptr(unsafe.Pointer(li)))
	return ok != 0
}

// lastInputTick is the tick count of the last input, and false when Windows
// refuses (it does when cbSize is not the struct's size).
func lastInputTick() (uint32, bool) {
	li := lastInputInfo{}
	li.cbSize = uint32(unsafe.Sizeof(li))
	ok := getLastInputInfo(&li)
	return li.dwTime, ok
}

// floeInFront reports whether Floe is the foreground window of a PC in use.
// Wails v2 has no focus query, so this asks Windows. Any call that fails reads
// as "not in front": a toast too many is better than one swallowed.
func floeInFront() bool {
	hwnd, _, _ := procGetForegroundWindow.Call()
	if hwnd == 0 {
		return false
	}
	var pid uint32
	procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	last, ok := lastInputTick()
	if !ok {
		return false
	}
	tick, _, _ := procGetTickCount.Call()
	return inFront(pid, uint32(os.Getpid()), idleSince(uint32(tick), last))
}
