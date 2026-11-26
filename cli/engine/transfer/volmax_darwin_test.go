package transfer

// macOS only on purpose (the _darwin suffix is the build constraint): the
// name in f_fstypename is how macOS names a file system.

import "testing"

// TestPlatformFSNameNamesTheMacOSSystemVolume: the real statfs names the file
// system of "/", which is APFS on every Mac Go runs on. It pins that the name
// is read from f_fstypename: f_type is a number on macOS, and reading it as
// Linux does would answer "" for every volume, FAT included.
func TestPlatformFSNameNamesTheMacOSSystemVolume(t *testing.T) {
	if got, err := platformFSName("/"); err != nil || got != "apfs" {
		t.Fatalf(`platformFSName("/") = %q, %v; want "apfs" and no error`, got, err)
	}
}
