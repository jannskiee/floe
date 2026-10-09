package main

// The save volume's size, for the automatic Accept's floor (requestauto.go,
// G13), answered by Windows. The _windows suffix is the build constraint, on
// purpose; volume_other.go is the twin for every other GOOS and answers
// "unknown", so every drop asks there. Whether the volume keeps named streams
// is the engine's question (transfer.VolumeNamedStreams), asked through
// requestVolumeStreamsFn.

import (
	"math"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// volumeSize reports the size of the volume under dir as this process sees it
// (a disk quota lowers it, like DiskFree's figure). GetDiskFreeSpaceEx answers
// for the volume files written under dir land on: it follows a directory
// junction, a symbolic link, a mount point or a subst drive by itself. dir
// must exist; any error answers nothing, so the drop asks.
func volumeSize(dir string) (int64, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return 0, err
	}
	p, err := windows.UTF16PtrFromString(abs)
	if err != nil {
		return 0, err
	}
	var total uint64
	if err := windows.GetDiskFreeSpaceEx(p, nil, &total, nil); err != nil {
		return 0, err
	}
	if total > math.MaxInt64 {
		total = math.MaxInt64
	}
	return int64(total), nil
}
