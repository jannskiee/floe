//go:build windows

package main

import "golang.org/x/sys/windows"

// knownDownloads returns the absolute path to the user's Downloads folder
// as reported by Windows, or "" on any error.
func knownDownloads() string {
	dir, err := windows.KnownFolderPath(windows.FOLDERID_Downloads, windows.KF_FLAG_DONT_VERIFY)
	if err != nil {
		return ""
	}
	return dir
}
