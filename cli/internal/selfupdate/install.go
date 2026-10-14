package selfupdate

// Replacing the running executable, which is the step that differs most
// between platforms. Named install.go rather than install_<goos>.go on
// purpose: a GOOS suffix is an implicit build constraint in Go, and these
// functions must all compile everywhere.

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// installBinary places newBinary at exe, replacing the running executable.
// It works for user-owned install dirs (e.g. ~/.local/bin) without elevation,
// and falls back to sudo when the install dir is root-owned (e.g. /usr/local/bin).
func installBinary(exe, newBinary string) error {
	if runtime.GOOS == "windows" {
		return windowsInstall(exe, newBinary)
	}

	// Fast path: install without elevation. Works when the install dir is
	// writable by the current user.
	err := unixInstall(exe, newBinary)
	if err == nil {
		return nil
	}
	if !errors.Is(err, fs.ErrPermission) {
		return err
	}

	// The install dir is not writable, typically /usr/local/bin owned by root.
	dir := filepath.Dir(exe)
	if os.Geteuid() == 0 {
		return fmt.Errorf("permission denied writing to %s", dir)
	}
	sudo, lookErr := exec.LookPath("sudo")
	if lookErr != nil {
		return fmt.Errorf("%s is not writable and sudo is not available; "+
			"re-run as root, or reinstall with the install script", dir)
	}
	return sudoInstall(sudo, exe, newBinary)
}

// unixInstall stages a copy of newBinary alongside exe and atomically renames it
// into place. Renaming (rather than writing over exe) is required because a
// running executable cannot be opened for writing on Linux (ETXTBSY), and it
// makes the swap atomic. Staging in the same directory also keeps the rename on
// one filesystem. Returns an fs.ErrPermission error when the install dir is not
// writable, which the caller uses to decide whether to elevate.
func unixInstall(exe, newBinary string) error {
	staged, err := os.CreateTemp(filepath.Dir(exe), ".floe-update-*")
	if err != nil {
		return err
	}
	stagedPath := staged.Name()
	_ = staged.Close()
	defer os.Remove(stagedPath)

	if err := copyFile(newBinary, stagedPath, 0o755); err != nil {
		return err
	}
	return os.Rename(stagedPath, exe)
}

// sudoInstall completes the swap with elevated privileges. The download and
// extraction already ran as the normal user; only the final move needs root.
// It copies to a sibling (a new file, so the running binary is never opened for
// writing -> no ETXTBSY), fixes the mode, then atomically renames it over exe,
// all in a single sudo invocation (one password prompt).
func sudoInstall(sudo, exe, newBinary string) error {
	fmt.Printf("  %s is not writable; requesting sudo to install the update...\n", filepath.Dir(exe))
	const script = `cp "$1" "$2.new" && chmod 0755 "$2.new" && mv -f "$2.new" "$2"`
	cmd := exec.Command(sudo, "sh", "-c", script, "sh", newBinary, exe)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("sudo install failed: %w", err)
	}
	return nil
}

// windowsInstall stages the new binary next to exe (avoiding cross-volume
// renames), renames the running exe out of the way, then moves the new one in.
// Windows disallows overwriting a running .exe but allows renaming it.
func windowsInstall(exe, newBinary string) error {
	staged := exe + ".new"
	_ = os.Remove(staged)
	if err := copyFile(newBinary, staged, 0o755); err != nil {
		return err
	}
	// The .bak is the name earlier versions moved the old image to; an
	// update has always cleared it before its rename, and still does, so one
	// those versions left goes at the next update as it always did.
	_ = os.Remove(exe + ".bak")
	bak := updateBackupPath(exe)
	_ = os.Remove(bak)
	if err := os.Rename(exe, bak); err != nil {
		_ = os.Remove(staged)
		return fmt.Errorf("cannot rename current binary: %w", err)
	}
	if err := os.Rename(staged, exe); err != nil {
		_ = os.Rename(bak, exe) // attempt restore
		_ = os.Remove(staged)
		return fmt.Errorf("cannot install new binary: %w", err)
	}
	// Fails while this process runs from bak, which is every update run from
	// floe itself; RemoveUpdateBackup takes it at the next start.
	_ = os.Remove(bak)
	return nil
}

// updateBackupPath is where windowsInstall moves the running image: a name
// only floe makes, so the cleanup at every start can never take a file a
// person made. floe.exe.bak, the name before, is the obvious one for a copy
// kept by hand before trying a new build (CLI-03).
func updateBackupPath(exe string) string {
	return exe + ".floe-update-old"
}

// RemoveUpdateBackup removes the old image windowsInstall leaves beside
// floe.exe (A4-B17): the update renames the running image aside, and its own
// delete cannot succeed while that process runs, so the file stayed until the
// next update. main calls this at every start, when the process runs from the
// new floe.exe and nothing holds the old one. One still running (another floe
// started before the update) cannot be removed and is left for a later start.
// Windows only: no other platform's update leaves an old image.
func RemoveUpdateBackup() {
	if runtime.GOOS != "windows" {
		return
	}
	exe, err := os.Executable()
	if err != nil {
		return
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	removeUpdateBackup(exe)
}

// removeUpdateBackup is RemoveUpdateBackup for the executable at exe. It
// removes updateBackupPath(exe) and nothing else: a floe.exe.bak is left
// alone, because no update of this build made it (CLI-03).
func removeUpdateBackup(exe string) {
	_ = os.Remove(updateBackupPath(exe))
}

// copyFile copies src to dst, creating or truncating dst with the given mode.
func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	// Ensure the mode sticks even if umask trimmed it at create time.
	return os.Chmod(dst, mode)
}
