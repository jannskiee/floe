//go:build !windows

package main

// blockSleep and allowSleep are no-ops off Windows: keeping the machine awake
// during a transfer is only implemented for the Windows desktop build today.
func blockSleep() {}
func allowSleep() {}
