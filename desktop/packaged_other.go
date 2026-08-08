//go:build !windows

package main

// isPackaged reports MSIX package identity, which exists only on Windows.
func isPackaged() bool { return false }
