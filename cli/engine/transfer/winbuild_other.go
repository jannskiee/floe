//go:build !windows

package transfer

// readWindowsBuild off Windows. The file name carries no GOOS suffix, so the
// constraint above is what keeps this twin off Windows.
//
// There is no Windows build to read, so it answers 0. Nothing consults it:
// sanitizeComponent reads the build only when goos is "windows".

func readWindowsBuild() uint32 { return 0 }
