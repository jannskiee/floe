//go:build windows

package main

import (
	"runtime"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// cfHDROP is the Windows clipboard format for a list of file paths (what
// Explorer puts on the clipboard when you copy files).
const cfHDROP = 15

// The user32 and kernel32 lazy DLLs declared here are shared by the other
// *_windows.go files that make raw proc calls through them (attention,
// packaged, power, wake). The clipboard read mirrors the standard Go one (LockOSThread ->
// Open -> Get -> GlobalLock -> copy out -> Unlock -> Close -> UnlockOSThread).
// Reads use RtlMoveMemory to copy the clipboard bytes into a Go buffer so the
// foreign address is never converted to an unsafe.Pointer (keeps `go vet`'s
// unsafeptr check clean).
var (
	user32   = windows.NewLazySystemDLL("user32.dll")
	kernel32 = windows.NewLazySystemDLL("kernel32.dll")

	procIsClipboardFormatAvailable = user32.NewProc("IsClipboardFormatAvailable")
	procOpenClipboard              = user32.NewProc("OpenClipboard")
	procCloseClipboard             = user32.NewProc("CloseClipboard")
	procGetClipboardData           = user32.NewProc("GetClipboardData")
	procRegisterClipboardFormatW   = user32.NewProc("RegisterClipboardFormatW")

	procGlobalLock    = kernel32.NewProc("GlobalLock")
	procGlobalUnlock  = kernel32.NewProc("GlobalUnlock")
	procGlobalSize    = kernel32.NewProc("GlobalSize")
	procRtlMoveMemory = kernel32.NewProc("RtlMoveMemory")

	clipboardOpen  = openClipboardRetry
	clipboardData  = clipboardGlobalBytes
	clipboardClose = func() { procCloseClipboard.Call() }
)

// openClipboardRetry opens the clipboard, retrying briefly since another process
// may hold it open for a moment. Returns false if it never opened.
func openClipboardRetry() bool {
	for i := 0; i < 10; i++ {
		if r, _, _ := procOpenClipboard.Call(0); r != 0 {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

// clipboardGlobalBytes copies out the bytes of the clipboard object for the
// given format (an HGLOBAL). The clipboard must already be open.
func clipboardGlobalBytes(format uintptr) []byte {
	h, _, _ := procGetClipboardData.Call(format)
	if h == 0 {
		return nil
	}
	src, _, _ := procGlobalLock.Call(h)
	if src == 0 {
		return nil
	}
	defer procGlobalUnlock.Call(h)
	size, _, _ := procGlobalSize.Call(h)
	if size == 0 {
		return nil
	}
	buf := make([]byte, int(size))
	// Copy from the locked clipboard memory (src, an address) into buf. src stays
	// a uintptr the whole time; only our own &buf[0] becomes a pointer.
	procRtlMoveMemory.Call(uintptr(unsafe.Pointer(&buf[0])), src, size)
	return buf
}

// readClipboard locks the goroutine to its current OS thread, opens the
// clipboard, reads the bytes for format, closes the clipboard and unlocks the
// OS thread. Windows requires the open and close to run on the same thread.
func readClipboard(format uintptr) []byte {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if !clipboardOpen() {
		return nil
	}
	defer clipboardClose()
	return clipboardData(format)
}

// clipboardFilePaths returns the file paths on the clipboard (files copied in
// Explorer), or nil if there are none.
func clipboardFilePaths() []string {
	if r, _, _ := procIsClipboardFormatAvailable.Call(cfHDROP); r == 0 {
		return nil
	}
	return parseDropFiles(readClipboard(cfHDROP))
}

// clipboardImagePNG returns the bytes of a PNG-format image on the clipboard
// (what Snipping Tool / Win+Shift+S and Chromium put there), or nil if none.
func clipboardImagePNG() []byte {
	fmtID, _, _ := procRegisterClipboardFormatW.Call(uintptr(unsafe.Pointer(windows.StringToUTF16Ptr("PNG"))))
	if fmtID == 0 {
		return nil
	}
	if r, _, _ := procIsClipboardFormatAvailable.Call(fmtID); r == 0 {
		return nil
	}
	return readClipboard(fmtID)
}
