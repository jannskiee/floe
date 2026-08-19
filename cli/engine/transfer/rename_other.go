//go:build !windows

package transfer

import "os"

// renameNoReplace publishes src at dst, failing (with an error that satisfies
// os.IsExist) if dst already exists.
//
// POSIX os.Rename replaces an existing destination, so the never-overwrite
// claim is made with an O_EXCL placeholder created and consumed inside this
// one call: the placeholder exists at the final name only for the microseconds
// between the two syscalls, and a crash in that window leaves a visibly empty
// file beside the intact .part. (Windows uses a genuinely atomic no-replace
// MoveFileEx instead; see rename_windows.go.)
func renameNoReplace(src, dst string) error {
	placeholder, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0666)
	if err != nil {
		return err // includes os.IsExist when dst is taken
	}
	placeholder.Close()
	if err := os.Rename(src, dst); err != nil {
		_ = os.Remove(dst) // take back the placeholder
		return err
	}
	return nil
}
