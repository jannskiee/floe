package transfer

// What a sender's metadata may ask of this machine, in two layers.
//
// Layer 1 is every Go receiver's sanity limits, always on and with no option
// to turn them off (D-033): a path at most maxPathDepth components deep and
// maxPathUnits UTF-16 units long, never starting at a drive or a root, and a
// size the volume can hold. They are constants, not fields, so no caller can
// switch them off.
//
// Layer 2 is ReceiveLimits, the request link's stricter policy, active only
// when a caller sets ReceiveOptions.Limits.
//
// Every check here is a pure function the receive loop consults at a fixed
// point (spec 05 8.1), and each answers with the refusal code and the
// surface-neutral wire reason, or "" for no refusal. The loop owns the order,
// which is the security property: every path check before OnIncoming and
// Decide, the free-space check after Decide, and all of them before MkdirAll
// or a claim touches the disk.

import (
	"path/filepath"
	"strings"
	"unicode/utf16"

	"github.com/pion/webrtc/v4"
)

const (
	// maxPathDepth bounds the components of the relative path a file is saved
	// under, the file itself included: 31 folders and a file. Before it, depth
	// was bounded only by the 1000-byte control frame, and the pairing spike's
	// F2 created 40 nested folders.
	maxPathDepth = 32
	// maxPathUnits bounds that relative path in UTF-16 code units, counting
	// the ".part" suffix the staging file carries. It keeps every component
	// under the 255-unit NTFS limit with room for a " (n)" de-collision suffix;
	// the spike's F6 hit that limit with a raw OS error.
	maxPathUnits = 240
)

// fat32MaxFileSize is the largest file a FAT or FAT32 volume can hold: the
// size field is 32 bits, so 4 GiB minus one byte.
const fat32MaxFileSize = 4294967295

// reasonPathNotRelative is path-too-long's wire reason for a name that starts
// at a drive or a root. D-100 reuses the code for this sub-case rather than
// add a thirteenth, and this sentence is what names the sub-case for a peer
// that prints the reason. Receiver-voiced and naming no path, like every
// WireReason.
const reasonPathNotRelative = "receiver cannot store a file path that is not relative to its save folder"

// ReceiveLimits is the request link's receive policy (layer 2). A nil
// *ReceiveLimits checks nothing beyond layer 1, which is what the plain CLI
// and code receive run.
//
// There is no byte field: the approved total is the announced total of the
// first metadata at the moment the transfer is accepted, recorded inside the
// receive loop, and only bytes that actually arrive count against it (D-055).
type ReceiveLimits struct {
	// MaxFiles caps the files a drop may announce and the metadata frames it
	// may send (E-37). Zero or less refuses every drop, the direction that
	// fails closed.
	MaxFiles int
	// FreeReserve is the space that must still be free after each file, on
	// top of the file itself. Negative counts as zero.
	FreeReserve int64
	// BlockShellTypes turns on the name hook (blockshell.go): a file Windows
	// Explorer would parse on sight is saved as <name>.floe-blocked, and a
	// class ID suffix is stripped from every path component. A rename, never
	// a refusal.
	BlockShellTypes bool
	// HostRelayCheck holds a drop to RelaySizeLimit when this side's own
	// probe of the selected candidate pair says relay (relay.go,
	// hostRelayVerdict): probed once when the transfer is accepted, then a
	// file whose announced size, or a frame whose bytes, would take the
	// drop past the limit is refused relay-cap. A probe that fails lets the
	// drop through, as the sender's gate does.
	HostRelayCheck bool
}

// The volume questions, as seams so a test can stand in any file system and
// any free space. diskfree_windows.go answers them for real; every other GOOS
// answers "unknown" (-1 free, 0 max), which makes the checks skip.
var (
	diskFreeFn  = diskFree
	volumeMaxFn = volumeMaxFileSize
)

// pathUnits is the length of rel in UTF-16 code units with the ".part" suffix
// added, which is how Windows measures the name the staging file claims. A
// character outside the Basic Multilingual Plane costs two.
func pathUnits(rel string) int {
	return len(utf16.Encode([]rune(rel + partSuffix)))
}

// depthBelow counts the components of rel, a relative path in this OS's
// separator form as safeJoin builds it (never empty, never "." or "..").
func depthBelow(rel string) int {
	return len(strings.Split(rel, string(filepath.Separator)))
}

// startsAtDriveOrRoot reports whether a sender's name, as sent, is anchored
// somewhere other than the save folder: a root ("/etc", "\Windows", a UNC
// "\\server" or a "\\?\" device path, either separator) or a drive letter in
// any spelling ("C:\x", "c:x", "C:"). It reads the raw name on purpose:
// safeJoin strips volume names and leading separators, which is exactly how
// the spike's F4b turned C:\Windows\System32\evil.dll into a folder tree under
// the save folder. The rule is the same on every GOOS, so a Linux receiver
// refuses a Windows drive path as well.
func startsAtDriveOrRoot(name string) bool {
	if name == "" {
		return false
	}
	if name[0] == '/' || name[0] == '\\' {
		return true
	}
	c := name[0] | 0x20 // ASCII lower case; only letters survive the range test
	return len(name) >= 2 && c >= 'a' && c <= 'z' && name[1] == ':'
}

// checkPathShape is layer 1's path check. name is the sender's fileName as it
// arrived and rel the relative path the file will be claimed under (safeJoin's
// result, after any rename). A name anchored at a drive or a root is refused
// outright; otherwise rel is held to maxPathDepth components and maxPathUnits
// units. All three are path-too-long; the reason names which.
func checkPathShape(name, rel string) (RefusalCode, string) {
	if startsAtDriveOrRoot(name) {
		return CodePathTooLong, reasonPathNotRelative
	}
	if depthBelow(rel) > maxPathDepth || pathUnits(rel) > maxPathUnits {
		return CodePathTooLong, CodePathTooLong.WireReason()
	}
	return "", ""
}

// checkAnnouncedSize is layer 1's size check. A size past 2^53 - 1 never gets
// here (byteCount rejects it inside parseMetadata, with its own frame), and
// is refused again anyway so this check stands on its own. volumeMax is the
// output volume's largest file, 0 when none is known.
func checkAnnouncedSize(size, volumeMax int64) (RefusalCode, string) {
	if size > maxAnnouncedSize || (volumeMax > 0 && size > volumeMax) {
		return CodeFileTooLargeForFolder, CodeFileTooLargeForFolder.WireReason()
	}
	return "", ""
}

// checkFirstMetadata is layer 2 at the first metadata, the checks that need
// no folder and so run before OnIncoming and Decide: the announced count
// within MaxFiles, an announced total that is present and not zero, and file
// 1 first. The last is also checked before every claim; asking it here too
// means the owner is never prompted for a drop the next check would refuse.
func checkFirstMetadata(info FileInfo, l *ReceiveLimits) (RefusalCode, string) {
	if info.Total > l.MaxFiles || info.TotalBytes == 0 || info.Index != 1 {
		return CodeOverApproved, CodeOverApproved.WireReason()
	}
	return "", ""
}

// checkEveryMetadata is layer 2 immediately before each claim. first is the
// first metadata, filesReceived the files committed so far and frames the
// metadata frames seen, this one included. Both totals must match the first
// metadata's, the index must be the next file, and the frames must stay
// within MaxFiles (E-37), all over-approved; free, the free bytes under the
// folder this file lands in (-1 when unknown, which skips it), must cover the
// file plus FreeReserve, or disk-full.
func checkEveryMetadata(info FileInfo, first FileInfo, filesReceived int, frames int, l *ReceiveLimits, free int64) (RefusalCode, string) {
	if info.Total != first.Total || info.TotalBytes != first.TotalBytes ||
		info.Index != filesReceived+1 || frames > l.MaxFiles {
		return CodeOverApproved, CodeOverApproved.WireReason()
	}
	reserve := l.FreeReserve
	if reserve < 0 {
		reserve = 0
	}
	// Subtracting keeps the sum from overflowing: free is at least zero here
	// and FileSize is at most 2^53 - 1.
	if free >= 0 && free-info.FileSize < reserve {
		return CodeDiskFull, CodeDiskFull.WireReason()
	}
	return "", ""
}

// checkFrame is layer 2 at every binary frame: the bytes actually received,
// never an announced number, may not pass the approved total.
func checkFrame(totalReceived int64, n int, approvedTotal int64) (RefusalCode, string) {
	if totalReceived+int64(n) > approvedTotal {
		return CodeOverApproved, CodeOverApproved.WireReason()
	}
	return "", ""
}

// refuseLimit is the receive loop's one way out for a limit: the coded frame,
// flushed, then the typed error. saved is the count of files committed before
// it. Nothing here touches the disk; a refusal with a file open leaves its
// .part to the loop's deferred discard.
func refuseLimit(dc *webrtc.DataChannel, localVer string, code RefusalCode, reason string, saved int) error {
	AbortWithCode(dc, localVer, code, reason, saved)
	return &RefusedError{Code: code, Saved: saved}
}
