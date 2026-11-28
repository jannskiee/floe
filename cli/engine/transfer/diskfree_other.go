//go:build !windows

package transfer

// diskFree and volumeNamedStreams off Windows. The file name carries no GOOS
// suffix, so the constraint above is what keeps this twin off Windows. The
// volume's largest file is asked in volmax_statfs.go on macOS and Linux, and
// volmax_other.go answers it everywhere else.
//
// diskFree answers "unknown" and no error, which makes every check that reads
// it skip: -1 free bytes. The receive limits never guess a figure they cannot
// read.

func diskFree(dir string) (int64, error) { return -1, nil }

// volumeNamedStreams off Windows answers no: applyMOTW is a no-op there, so
// no volume carries a mark Floe wrote.
func volumeNamedStreams(dir string) (bool, error) { return false, nil }
