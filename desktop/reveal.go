package main

// Showing a received file to the user: the platform commands, and the name
// and path checks that run before either of them is handed anything.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
)

// OpenFolder reveals the given path in the OS file manager.
func (a *App) OpenFolder(path string) error {
	if path == "" {
		return fmt.Errorf("no path to open")
	}
	var cmd *exec.Cmd
	switch goruntime.GOOS {
	case "windows":
		cmd = exec.Command("explorer", path)
	case "darwin":
		cmd = exec.Command("open", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	// Launch without waiting: explorer.exe in particular can return a non-zero
	// exit code even on success, and we only care that it started.
	return cmd.Start()
}

// fileExists reports whether p exists and is a regular file (not a directory).
func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

// safeLeaf reduces a peer-supplied name to a single in-directory path component
// so it cannot escape the target dir when joined. It defeats path traversal
// (.., absolute, UNC, drive-letter, and forward- or back-slash separators) by
// normalizing every backslash to a forward slash and keeping only the final
// component, independent of the build OS. Returns ("", false) when there is no
// usable leaf (".", "..", ""), so the caller falls back to opening the folder.
// This is the security boundary for RevealFile/OpenFile: the UI passes the raw
// sender-controlled file name, so the guard must live here, not in the webview.
func safeLeaf(name string) (string, bool) {
	name = strings.ReplaceAll(name, "\\", "/")
	if i := strings.LastIndexByte(name, '/'); i >= 0 {
		name = name[i+1:]
	}
	if name == "." || name == ".." || name == "" {
		return "", false
	}
	return name, true
}

// revealCmd returns the command that opens the OS file manager with path
// selected/highlighted. Windows uses `explorer /select,<path>` as a SINGLE
// argument: explorer parses its own command line, and splitting it into two
// args often opens the folder without selecting. The path must use backslashes,
// which filepath.Join yields on Windows (do not introduce forward slashes).
// macOS uses `open -R`. Linux has no portable "select this file" verb, so it
// opens the folder instead (dir is passed in for exactly this, so we never call
// filepath.Dir and the pure helper stays host-separator independent for tests).
func revealCmd(goos, dir, path string) *exec.Cmd {
	switch goos {
	case "windows":
		return exec.Command("explorer", "/select,"+path)
	case "darwin":
		return exec.Command("open", "-R", path)
	default:
		return exec.Command("xdg-open", dir)
	}
}

// openCmd returns the command that opens path in its default application off
// Windows. Windows has no process for it: OpenFile asks the shell itself
// (shellOpenFn), because rundll32's FileProtocolHandler, used until A3-B8,
// read its argument as a URL, so a '#' or '%' in a received file's name could
// open the wrong thing or nothing.
func openCmd(goos, path string) *exec.Cmd {
	if goos == "darwin" {
		return exec.Command("open", path)
	}
	return exec.Command("xdg-open", path)
}

// shellOpenFn opens a file in its default application on Windows
// (shellopen_windows.go); a variable so a test can see the path it is handed
// without opening anything.
var shellOpenFn = shellOpen

// RevealFile opens the OS file manager with the received file dir/name selected.
// If the exact file is missing it falls back to opening the folder, so the
// action is never broken. Live transfers pass the engine's SavedName (the real
// on-disk name, de-collided by claimPart), so the fallback now covers only
// history entries persisted before SavedName existed (those hold the sender's
// name forever) and files moved/deleted after the transfer.
func (a *App) RevealFile(dir, name string) error {
	if dir == "" {
		return fmt.Errorf("no folder to open")
	}
	leaf, ok := safeLeaf(name)
	if !ok {
		return a.OpenFolder(dir)
	}
	p := filepath.Join(dir, leaf)
	if fileExists(p) {
		return revealCmd(goruntime.GOOS, dir, p).Start()
	}
	return a.OpenFolder(dir)
}

// OpenFile opens the received file dir/name in its default application, falling
// back to opening the folder if the exact file is missing (see RevealFile).
func (a *App) OpenFile(dir, name string) error {
	if dir == "" {
		return fmt.Errorf("no file to open")
	}
	leaf, ok := safeLeaf(name)
	if !ok {
		return a.OpenFolder(dir)
	}
	p := filepath.Join(dir, leaf)
	if fileExists(p) {
		if goruntime.GOOS == "windows" {
			return shellOpenFn(p)
		}
		return openCmd(goruntime.GOOS, p).Start()
	}
	return a.OpenFolder(dir)
}

// defaultReceiveDir returns a safe default save location (the user's Downloads
// folder, or home) so a blank destination never writes into the app's working
// directory and clobbers unrelated files.
func defaultReceiveDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	if dl := filepath.Join(home, "Downloads"); dirExists(dl) {
		return dl
	}
	return home
}

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}
