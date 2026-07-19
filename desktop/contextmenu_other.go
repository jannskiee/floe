//go:build !windows

package main

import "fmt"

// The Explorer context-menu integration is Windows-only; these stubs keep the
// desktop module compiling on other platforms (x/sys/windows/registry does not
// build there) and make the feature read as unavailable.

func registerContextMenu(base, exe string) error {
	return fmt.Errorf("the right-click menu is only available on Windows")
}

func unregisterContextMenu(base string) error {
	return nil
}

func contextMenuCommand(base string) (string, bool) {
	return "", false
}
