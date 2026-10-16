//go:build windows

package main

// The Windows half of OpenFile: the shell's own open of a received file, in
// this process.

import (
	"runtime"
	"syscall"

	"golang.org/x/sys/windows"
)

// shellOpen opens path in its default application through ShellExecuteW with
// the default verb, as a double-click in Explorer does (A3-B8). The path goes
// in as one UTF-16 string, so a '#' or '%' in a file name stays part of the
// name. The shell may hand the open to an extension that needs a COM
// single-threaded apartment, so the call runs on a locked thread with COM
// initialized that way, as the ShellExecute documentation asks.
func shellOpen(path string) error {
	file, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	// S_OK, and S_FALSE (this thread already had COM this way), each need a
	// CoUninitialize; RPC_E_CHANGED_MODE needs none, and the open still runs
	// in the apartment the thread has.
	if err := windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED|windows.COINIT_DISABLE_OLE1DDE); err == nil || err == syscall.Errno(windows.S_FALSE) {
		defer windows.CoUninitialize()
	}
	return windows.ShellExecute(0, nil, file, nil, nil, windows.SW_SHOWNORMAL)
}
