//go:build !windows

package main

// knownDownloads returns the absolute path to the user's Downloads folder
// on Windows, or "" on other platforms.
func knownDownloads() string {
	return ""
}
