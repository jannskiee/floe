//go:build windows

package main

import "golang.org/x/sys/windows"

// showFatal puts a startup failure on screen. The release binary is linked with
// -H windowsgui and so has no console: without this, a failure before the window
// exists kills the process with nothing for the user to read, which reads as the
// app silently refusing to start.
//
// MB_SETFOREGROUND and MB_TOPMOST both matter here. The failure happens before
// any Floe window exists, so the dialog has no parent to sit in front of and
// would otherwise be free to open behind whatever the user was looking at.
func showFatal(title, body string) {
	caption, err := windows.UTF16PtrFromString(title)
	if err != nil {
		return
	}
	text, err := windows.UTF16PtrFromString(body)
	if err != nil {
		return
	}
	// Failure is ignored on purpose: this is the last thing the process does
	// before exiting, and there is no better channel left to report it on.
	_, _ = windows.MessageBox(
		windows.HWND(0),
		text,
		caption,
		windows.MB_OK|windows.MB_ICONERROR|windows.MB_SETFOREGROUND|windows.MB_TOPMOST,
	)
}
