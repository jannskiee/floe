package transfer

// Windows only on purpose (the _windows suffix is the build constraint): the
// flag is a bit of GetVolumeInformationByHandle's file system flags.

import (
	"testing"

	"golang.org/x/sys/windows"
)

// TestHasNamedStreamsReadsOnlyThatFlag (S-7): FILE_NAMED_STREAMS alone decides
// the answer. Every other file system flag, in any mix, leaves it at no, and
// the flag among others leaves it at yes.
func TestHasNamedStreamsReadsOnlyThatFlag(t *testing.T) {
	const others = windows.FILE_CASE_SENSITIVE_SEARCH | windows.FILE_CASE_PRESERVED_NAMES | windows.FILE_UNICODE_ON_DISK |
		windows.FILE_SUPPORTS_HARD_LINKS | windows.FILE_SUPPORTS_REPARSE_POINTS
	for _, c := range []struct {
		name  string
		flags uint32
		want  bool
	}{
		{"no flags", 0, false},
		{"a FAT32-like set", others, false},
		{"named streams alone", windows.FILE_NAMED_STREAMS, true},
		{"an NTFS-like set", others | windows.FILE_NAMED_STREAMS, true},
	} {
		if got := hasNamedStreams(c.flags); got != c.want {
			t.Errorf("%s (%#x): hasNamedStreams = %v, want %v", c.name, c.flags, got, c.want)
		}
	}
}
