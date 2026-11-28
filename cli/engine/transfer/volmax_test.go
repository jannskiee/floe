package transfer

// The rule behind the largest file a macOS or Linux volume holds: FAT and
// FAT32 only, and anything unrecognized has no limit, as diskfree_windows.go
// answers on Windows. Pure, with no build constraint, so it runs on every OS.

import "testing"

// TestOnlyFATHasALargestFileTheReceiveKnows: "msdos", the name macOS gives
// FAT and FAT32 and the one linuxFSName gives Linux's vfat and msdos mounts,
// answers FAT32's 4 GiB less one byte. exFAT, whose limit is far past any size
// a sender may announce, and every name and magic number not listed answer 0,
// no known limit.
func TestOnlyFATHasALargestFileTheReceiveKnows(t *testing.T) {
	if got := fsMaxFileSize("msdos"); got != fat32MaxFileSize {
		t.Errorf(`fsMaxFileSize("msdos") = %d, want %d`, got, fat32MaxFileSize)
	}
	for _, name := range []string{"exfat", "apfs", "hfs", "ntfs", "smbfs", "nfs", ""} {
		if got := fsMaxFileSize(name); got != 0 {
			t.Errorf("fsMaxFileSize(%q) = %d, want 0", name, got)
		}
	}
	if got := linuxFSName(0x4d44); got != "msdos" {
		t.Errorf(`linuxFSName(0x4d44) = %q, want "msdos"`, got)
	}
	for _, magic := range []int64{
		0xEF53,     // ext2, ext3 and ext4
		0x2011BAB0, // exFAT
		0x01021994, // tmpfs
		0x9123683E, // btrfs
		0x58465342, // XFS
		0x65735546, // FUSE, which an exFAT or NTFS driver can be
		0x794C7630, // overlayfs, a container's own
		0,
	} {
		if got := linuxFSName(magic); got != "" {
			t.Errorf(`linuxFSName(%#x) = %q, want ""`, magic, got)
		}
	}
}
