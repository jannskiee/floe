package transfer

// The two volume questions the receive limits ask, answered by Windows. The
// _windows suffix is the build constraint, on purpose; diskfree_other.go is
// the twin for every other GOOS and answers "unknown".

import (
	"math"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// diskFree reports the bytes this process may still write under dir, which is
// the caller-visible figure (a disk quota lowers it) rather than the volume's
// raw free space. dir must exist.
func diskFree(dir string) (int64, error) {
	p, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return -1, err
	}
	var avail uint64
	if err := windows.GetDiskFreeSpaceEx(p, &avail, nil, nil); err != nil {
		return -1, err
	}
	if avail > math.MaxInt64 {
		return math.MaxInt64, nil
	}
	return int64(avail), nil
}

// volumeMaxFileSize reports the largest single file the volume under dir can
// hold, or 0 when the file system sets no limit this code knows of. Only FAT
// and FAT32 have one worth refusing on; NTFS, exFAT and ReFS limits are far
// past the 2^53 - 1 every announced size is already held to, and anything
// unrecognized is treated as unlimited rather than guessed at.
func volumeMaxFileSize(dir string) (int64, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return 0, err
	}
	p, err := windows.UTF16PtrFromString(abs)
	if err != nil {
		return 0, err
	}
	root := make([]uint16, windows.MAX_PATH+1)
	if err := windows.GetVolumePathName(p, &root[0], uint32(len(root))); err != nil {
		return 0, err
	}
	fsName := make([]uint16, windows.MAX_PATH+1)
	if err := windows.GetVolumeInformation(&root[0], nil, 0, nil, nil, nil, &fsName[0], uint32(len(fsName))); err != nil {
		return 0, err
	}
	switch windows.UTF16ToString(fsName) {
	case "FAT32", "FAT":
		return fat32MaxFileSize, nil
	}
	return 0, nil
}
