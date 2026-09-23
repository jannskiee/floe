//go:build !windows

package transfer

// diskFree and volumeMaxFileSize off Windows. The file name carries no GOOS
// suffix, so the constraint above is what keeps this twin off Windows.
//
// Both answer "unknown" and no error, which makes every check that reads them
// skip: -1 free bytes and 0 (no known limit) for the largest file. The receive
// limits never guess a figure they cannot read.

func diskFree(dir string) (int64, error) { return -1, nil }

func volumeMaxFileSize(dir string) (int64, error) { return 0, nil }
