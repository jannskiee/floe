//go:build !windows

package main

import (
	"fmt"
	"os"
)

// showFatal reports a startup failure on stderr. Floe Desktop ships on Windows
// only, but the module has to build elsewhere (see contextmenu_other.go), and a
// non-Windows build is run from a terminal, so stderr is the visible channel
// there and no dialog is needed.
func showFatal(title, body string) {
	fmt.Fprintf(os.Stderr, "%s: %s\n", title, body)
}
