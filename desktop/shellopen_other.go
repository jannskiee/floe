//go:build !windows

package main

// OpenFile asks the shell only on Windows; elsewhere openCmd starts open or
// xdg-open, so this is never reached.

import "errors"

func shellOpen(string) error {
	return errors.New("the shell open is only available on Windows")
}
