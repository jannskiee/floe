package transfer

import "golang.org/x/sys/unix"

// platformFSName reads the macOS filesystem name from statfs f_fstypename.
func platformFSName(p string) (string, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(p, &st); err != nil {
		return "", err
	}
	return unix.ByteSliceToString(st.Fstypename[:]), nil
}
