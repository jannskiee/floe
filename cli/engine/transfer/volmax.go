package transfer

// fsMaxFileSize returns the known single-file size limit, or zero if unknown.
func fsMaxFileSize(name string) int64 {
	if name == "msdos" {
		return fat32MaxFileSize
	}
	return 0
}

// linuxFSName maps the Linux FAT magic number to the filesystem name msdos.
func linuxFSName(fsType int64) string {
	if fsType == 0x4d44 { // MSDOS_SUPER_MAGIC
		return "msdos"
	}
	return ""
}
