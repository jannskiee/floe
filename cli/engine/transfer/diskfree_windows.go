package transfer

// The two volume questions the receive limits ask, answered by Windows. The
// _windows suffix is the build constraint, on purpose; diskfree_other.go is
// the twin for every other GOOS and answers "unknown".

import (
	"errors"
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
// unrecognized is treated as unlimited rather than guessed at. Any error means
// the volume could not say, which the receive counts as no known limit.
func volumeMaxFileSize(dir string) (int64, error) {
	fsName, _, err := volumeInfo(dir)
	if err != nil {
		return 0, err
	}
	switch fsName {
	case "FAT32", "FAT":
		return fat32MaxFileSize, nil
	}
	return 0, nil
}

// volumeInfo reports the name and the file system flags of the volume under
// dir, the two answers GetVolumeInformationByHandle gives that the receive
// asks about.
//
// The file system is asked through a handle to dir, which follows a junction,
// a symbolic link, a mount point or a subst drive to the volume files written
// under dir land on, as the desktop's volumeSpace does (FU-36). Asking by the
// path's root (GetVolumePathName) resolved a junction and a symbolic link as
// well, but failed on a subst drive mapped to a folder (measured 2026-10-01),
// so a FAT32 folder behind such a letter read as no known limit and a file
// past 4 GiB failed mid-write instead of being refused up front.
//
// dir may not be made yet (the receive makes it after Decide), so a missing
// dir is asked through the nearest folder above it that exists, as the root
// form answered for a missing folder too.
func volumeInfo(dir string) (string, uint32, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", 0, err
	}
	var h windows.Handle
	for {
		p, err := windows.UTF16PtrFromString(abs)
		if err != nil {
			return "", 0, err
		}
		// FILE_FLAG_BACKUP_SEMANTICS opens a directory; without
		// FILE_FLAG_OPEN_REPARSE_POINT the open follows a junction or link.
		h, err = windows.CreateFile(p, windows.FILE_READ_ATTRIBUTES,
			windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
			nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
		if err == nil {
			break
		}
		if !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) && !errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
			return "", 0, err
		}
		parent := filepath.Dir(abs)
		if parent == abs {
			return "", 0, err
		}
		abs = parent
	}
	defer windows.CloseHandle(h)
	var flags uint32
	name := make([]uint16, windows.MAX_PATH+1)
	if err := windows.GetVolumeInformationByHandle(h, nil, 0, nil, nil, &flags, &name[0], uint32(len(name))); err != nil {
		return "", 0, err
	}
	return windows.UTF16ToString(name), flags, nil
}

// volumeNamedStreams reports whether the volume under dir can carry named
// (alternate) data streams, which is what the downloaded-file mark needs:
// applyMOTW writes a Zone.Identifier stream. NTFS and ReFS can; FAT32, exFAT
// and many network shares cannot, and there the write fails and Windows has
// nothing to warn with when the file is opened. It asks the volume, as
// volumeMaxFileSize does, so a junction or a subst drive answers for the
// volume the files land on.
func volumeNamedStreams(dir string) (bool, error) {
	_, flags, err := volumeInfo(dir)
	if err != nil {
		return false, err
	}
	return hasNamedStreams(flags), nil
}

// hasNamedStreams reads FILE_NAMED_STREAMS, the one file system flag that
// says the volume keeps alternate data streams, from the flags
// GetVolumeInformationByHandle returned.
func hasNamedStreams(flags uint32) bool { return flags&windows.FILE_NAMED_STREAMS != 0 }
