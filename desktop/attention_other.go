//go:build !windows

package main

// The taskbar flash is Windows-only (attention_windows.go); elsewhere the
// title and the in-app notice carry the request.

func findOwnWindow() uintptr { return 0 }

func flashTaskbar() {}

func stopFlash() {}
