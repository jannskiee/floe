//go:build windows

package transfer

import "os"

// applyMOTW tags a received file with the Windows "Mark of the Web": a small
// Zone.Identifier alternate data stream marking it as coming from the Internet
// zone (ZoneId=3). Windows then applies its normal download protections when the
// file is opened, exactly as for a browser download: SmartScreen on unrecognized
// executables, Office Protected View on documents.
//
// Best-effort. The stream is an NTFS feature, so a FAT32/exFAT/network save
// location returns an error that the caller ignores (the file itself is already
// saved). It writes a separate stream, never the file's data, so the byte count
// and the receiver's integrity check are unaffected.
func applyMOTW(path string) error {
	return os.WriteFile(path+":Zone.Identifier", []byte("[ZoneTransfer]\r\nZoneId=3\r\n"), 0o644)
}
