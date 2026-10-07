//go:build !windows

package main

// volumeSize off Windows answers "unknown": no size and no error, like the
// engine's diskFree there. A link made with Auto-accept on then asks for every
// drop (requestauto.go, G13), which is the safe reading; the desktop app
// ships on Windows only today. The file name carries no GOOS suffix, so the
// constraint above is what keeps this twin off Windows.
func volumeSize(dir string) (int64, error) { return 0, nil }
