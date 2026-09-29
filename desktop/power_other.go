//go:build !windows

package main

// hasBattery off Windows answers "maybe": no power-state API is asked there,
// so every prompt keeps the laptop line, as before P11's gate. The file name
// carries no GOOS suffix, so the constraint above is what keeps this twin off
// Windows.
func hasBattery() bool { return true }
