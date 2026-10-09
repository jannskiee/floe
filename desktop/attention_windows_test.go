//go:build windows

package main

import (
	"testing"
	"time"
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

// TestInFrontNeedsOwnPIDAndRecentInput (S-12): Floe counts as in front only
// when the foreground window is its own AND the PC was used in the last 60
// seconds. A foreground window of nobody's (a lock screen, a switch in
// progress) is never in front.
func TestInFrontNeedsOwnPIDAndRecentInput(t *testing.T) {
	const own = 4242
	for _, c := range []struct {
		name string
		fg   uint32
		idle time.Duration
		want bool
	}{
		{"own window, just used", own, 0, true},
		{"own window, 59 s idle", own, 59 * time.Second, true},
		{"own window, exactly 60 s idle", own, 60 * time.Second, false},
		{"own window, away for an hour", own, time.Hour, false},
		{"another app in front", 777, 0, false},
		{"no foreground window", 0, 0, false},
	} {
		if got := inFront(c.fg, own, c.idle); got != c.want {
			t.Errorf("%s: inFront(%d, %d, %v) = %v, want %v", c.name, c.fg, own, c.idle, got, c.want)
		}
	}
}

// TestFloeInFrontFalseWithoutWindow: the test process owns no window, so
// whatever is in front is somebody else's.
func TestFloeInFrontFalseWithoutWindow(t *testing.T) {
	if floeInFront() {
		t.Fatal("floeInFront() is true in a process with no window")
	}
}

// TestLastInputInfoSizeIs8 pins LASTINPUTINFO's layout: GetLastInputInfo
// fails when cbSize is wrong, which would read as "never idle" and quietly
// swallow every toast Floe is not in front of.
func TestLastInputInfoSizeIs8(t *testing.T) {
	var li lastInputInfo
	if got := unsafe.Sizeof(li); got != 8 {
		t.Fatalf("lastInputInfo is %d bytes, want 8", got)
	}
}

// TestLastInputTickSetsCbSize: the size test above pins the layout, this one
// that the call is handed a struct that already says so. GetLastInputInfo
// fails when cbSize is not 8, and floeInFront reads a failure as "not in
// front", so a toast would fire in front of an owner who is looking at Floe.
func TestLastInputTickSetsCbSize(t *testing.T) {
	var seen uint32
	prev := getLastInputInfo
	t.Cleanup(func() { getLastInputInfo = prev })
	getLastInputInfo = func(li *lastInputInfo) bool {
		seen, li.dwTime = li.cbSize, 1234
		return true
	}
	if tick, ok := lastInputTick(); !ok || tick != 1234 {
		t.Errorf("lastInputTick() = %d, %v, want 1234, true", tick, ok)
	}
	if seen != 8 {
		t.Errorf("GetLastInputInfo was called with cbSize %d, want 8", seen)
	}
}

// TestIdleSinceSurvivesTheTickWrap: both clocks are 32-bit milliseconds that
// wrap every 49.7 days, so the difference must be taken in uint32.
func TestIdleSinceSurvivesTheTickWrap(t *testing.T) {
	if got := idleSince(5000, 2000); got != 3*time.Second {
		t.Errorf("idleSince(5000, 2000) = %v, want 3s", got)
	}
	if got := idleSince(5, 0xFFFFFFF0); got != 21*time.Millisecond {
		t.Errorf("across the wrap idleSince = %v, want 21ms", got)
	}
}
