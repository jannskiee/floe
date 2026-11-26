//go:build !windows && !linux && !darwin

package transfer

func volumeMaxFileSize(dir string) (int64, error) { return 0, nil }
