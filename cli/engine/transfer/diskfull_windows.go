package transfer

import (
	"errors"
	"syscall"

	"golang.org/x/sys/windows"
)

// isDiskFull reports whether err is the OS saying the drive has no room.
// ERROR_DISK_FULL (112) is what a write past the free space returns and
// ERROR_HANDLE_DISK_FULL (39) is the older spelling some filters still raise;
// both are syscall.Errno values, so errors.Is finds them inside the
// *os.PathError a File.Write returns. syscall.ENOSPC is a placeholder errno on
// Windows and never comes from the kernel here, but a wrapped error built
// elsewhere can carry it, and including it costs nothing.
func isDiskFull(err error) bool {
	return errors.Is(err, windows.ERROR_DISK_FULL) ||
		errors.Is(err, windows.ERROR_HANDLE_DISK_FULL) ||
		errors.Is(err, syscall.ENOSPC)
}
