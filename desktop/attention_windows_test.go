//go:build windows

package main

import (
	"testing"
	"unsafe"
)

// TestFlashWInfoSizeIs32OnAmd64 pins FLASHWINFO's layout: FlashWindowEx
// rejects a struct whose cbSize is wrong, and the flash then silently never
// happens.
func TestFlashWInfoSizeIs32OnAmd64(t *testing.T) {
	var fi flashWInfo
	want := uintptr(32)
	if unsafe.Sizeof(uintptr(0)) == 4 {
		want = 20
	}
	if got := unsafe.Sizeof(fi); got != want {
		t.Fatalf("flashWInfo is %d bytes, want %d", got, want)
	}
}

// TestFindOwnWindowWithoutWindowReturnsZero: the test process has no visible
// window, so the flash has nothing to flash and must not guess one.
func TestFindOwnWindowWithoutWindowReturnsZero(t *testing.T) {
	if hwnd := findOwnWindow(); hwnd != 0 {
		t.Fatalf("findOwnWindow() = %#x in a process with no window", hwnd)
	}
	flashTaskbar()
	stopFlash()
}
