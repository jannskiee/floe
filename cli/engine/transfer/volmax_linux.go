package transfer

import "golang.org/x/sys/unix"

// platformFSName identifies FAT on Linux from the filesystem magic number.
func platformFSName(p string) (string, error) {
	magic, err := statfsMagic(p)
	if err != nil {
		return "", err
	}
	return linuxFSName(magic), nil
}

// statfsMagic reads the Linux filesystem magic number from statfs f_type.
func statfsMagic(p string) (int64, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(p, &st); err != nil {
		return 0, err
	}
	return int64(st.Type), nil
}
