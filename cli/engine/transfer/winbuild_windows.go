package transfer

// The Windows build that sanitizeComponent's device stem rule is decided by.
// The _windows suffix is the build constraint, on purpose; winbuild_other.go
// is the twin for every other GOOS.

import "golang.org/x/sys/windows"

// readWindowsBuild reports the build number of the Windows this process runs
// on, through RtlGetVersion, which Go's own standard library reads for the
// same question and which Microsoft documents as always succeeding.
//
// Two ways it can be wrong, and both land on the safe side. A compatibility
// mode set on floe.exe makes it report the older Windows the mode imitates,
// and every mode Windows offers is older than Windows 11, so a mode can only
// turn the stem rule on. A read that came back empty is build 0, below
// windows11Build, so it turns the rule on too. The rule turned on where it was
// not needed costs an underscore in front of a name; turned off where it was
// needed, it costs a file that fails to save.
func readWindowsBuild() uint32 {
	return windows.RtlGetVersion().BuildNumber
}
