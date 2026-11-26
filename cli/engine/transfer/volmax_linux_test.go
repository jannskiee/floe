package transfer

// Linux only on purpose (the _linux suffix is the build constraint): the
// magic number is how Linux names a file system.

import "testing"

// TestStatfsMagicIsTheFileSystemType: the real statfs reports procfs's magic
// number, 0x9fa0, for /proc, which every Linux system mounts. It pins that
// the number is read from f_type, the field linuxFSName reads.
func TestStatfsMagicIsTheFileSystemType(t *testing.T) {
	if got, err := statfsMagic("/proc"); err != nil || got != 0x9fa0 {
		t.Fatalf("statfsMagic(/proc) = %#x, %v; want 0x9fa0 and no error", got, err)
	}
}
