//go:build !windows

package transfer

import (
	"errors"
	"syscall"
)

// isDiskFull reports whether err is the OS saying the drive has no room:
// ENOSPC, which errors.Is finds inside the *os.PathError a File.Write or a
// Sync returns (a Sync can fail with it too on delayed allocation).
func isDiskFull(err error) bool {
	return errors.Is(err, syscall.ENOSPC)
}
