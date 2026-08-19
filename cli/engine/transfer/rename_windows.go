//go:build windows

package transfer

import (
	"os"

	"golang.org/x/sys/windows"
)

// renameNoReplace publishes src at dst atomically, failing (with an error that
// satisfies os.IsExist) if dst already exists.
//
// This is MoveFileEx WITHOUT MOVEFILE_REPLACE_EXISTING, which is the whole
// point: Go's os.Rename passes that flag and silently clobbers an existing
// destination, and the portable placeholder workaround leaves a 0-byte file
// at the final name for the duration of the call, which an adversarial review
// measured at nearly a second under an AV-held retry loop. Windows is the only
// platform the desktop app ships on, so here the final name either does not
// exist or holds the complete file; there is no in-between instant at all.
func renameNoReplace(src, dst string) error {
	from, err := windows.UTF16PtrFromString(src)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(dst)
	if err != nil {
		return err
	}
	if err := windows.MoveFileEx(from, to, 0); err != nil {
		if err == windows.ERROR_ALREADY_EXISTS || err == windows.ERROR_FILE_EXISTS {
			return &os.LinkError{Op: "rename", Old: src, New: dst, Err: os.ErrExist}
		}
		return &os.LinkError{Op: "rename", Old: src, New: dst, Err: err}
	}
	return nil
}
