//go:build !windows

package main

// The taskbar flash is Windows-only (attention_windows.go); elsewhere the
// title and the in-app notice carry the request.

// floeInFront: there is no foreground rule off Windows, so a toast always fires.
func floeInFront() bool { return false }

func flashTaskbar() {}

func stopFlash() {}
