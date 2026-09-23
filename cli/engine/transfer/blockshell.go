package transfer

// The name hook (ReceiveLimits.BlockShellTypes, E-41, spec 05 8.4): the file
// types Windows Explorer parses as soon as it shows a folder are saved under a
// name it will not parse, because some of them make Explorer fetch a path the
// sender chose and hand over the owner's NTLM credentials on the way
// (CVE-2025-24054, CVE-2025-50154). A rename, never a refusal, and request
// links only in Beta (OD-12): the uniform rule for every receiver is BX-08.
//
// Residual, by design: a new Explorer handler bug can make another type
// dangerous before it is listed here; nothing scans file contents; and the
// Mark of the Web, which still tags a renamed file, exists only on NTFS.

import (
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

// clsidSuffix matches a class ID written as a trailing ".{8-4-4-4-12}". A
// folder named that way is a shell namespace junction: Explorer opens the COM
// object instead of the folder. sanitizeComponent keeps braces and dots, so
// safeJoin lets it through, and the hook strips it from every component,
// folders included.
var clsidSuffix = regexp.MustCompile(`(?i)\.\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$`)

// clsidSuffixLen is the fixed length of what clsidSuffix matches, all ASCII.
// Matching only that many trailing bytes keeps stripping a stack of class IDs
// linear: running the pattern over the whole component once per strip was
// measured at 2.1 s for 2,000 of them in 78 KB. The control frame cap keeps a
// real name to about 25, so this is about the fuzzer, and about a caller that
// someday passes a name that did not come through that cap.
const clsidSuffixLen = len(".{00000000-0000-0000-0000-000000000000}")

// stripClassIDs removes every trailing class ID from one component, looking
// past trailing dots and spaces the way Windows resolves a name, so neither
// "x.{id}." nor "x.{id} .{id}" keeps one. A component with no class ID comes
// back untouched, trailing characters and all. A slice that starts inside a
// multi-byte character cannot match, because the pattern's first byte is an
// ASCII dot.
func stripClassIDs(p string) string {
	for {
		t := strings.TrimRight(p, " .")
		if len(t) < clsidSuffixLen || !clsidSuffix.MatchString(t[len(t)-clsidSuffixLen:]) {
			return p
		}
		p = t[:len(t)-clsidSuffixLen]
	}
}

// blockedExtensions are the E-41 table: spec 05 8.4's seven plus .website,
// .search-ms and .deskthemepack (the Windows 8 and later spelling of a
// .themepack, a CAB holding a .theme; WP-A1 review L3). Matched against the
// leaf's last extension, case-insensitively.
var blockedExtensions = []string{".lnk", ".url", ".library-ms", ".searchConnector-ms", ".scf", ".theme", ".themepack", ".deskthemepack", ".website", ".search-ms"}

// blockedLeafNames are matched against the whole leaf, in any folder.
var blockedLeafNames = []string{"desktop.ini"}

// blockedSuffix is what a renamed leaf ends in, so the staging file is
// <name>.floe-blocked.part. The desktop counts renamed files by this suffix
// on SavedName, which is why there is no callback for it.
const blockedSuffix = ".floe-blocked"

// sameFold is a case-insensitive match that covers both ways Windows might
// fold a name: Unicode simple folding (the Kelvin sign is a k) and upper
// casing (the long s is an S, the dotless i an I). Either one matching is
// enough; a false match only renames a file, which is the safe direction.
func sameFold(a, b string) bool {
	return strings.EqualFold(a, b) || strings.ToUpper(a) == strings.ToUpper(b)
}

func foldIn(s string, list []string) bool {
	for _, e := range list {
		if sameFold(s, e) {
			return true
		}
	}
	return false
}

// blockShellTypes applies the hook to rel, the relative path safeJoin built
// from the sender's FileName, and reports whether the leaf was renamed. Every
// component loses its trailing class IDs, then meets sanitizeComponent and
// safeJoin's traversal filter again, because a strip can expose what safeJoin
// would have refused: "...{class id}" leaves "..", ".{class id}" leaves
// nothing, and "CON.{class id}" leaves a device name. Then a leaf of a blocked
// type, judged with trailing dots and spaces trimmed as Windows does, becomes
// <leaf>.floe-blocked. The result only ever loses components, never gains
// one, and the receive loop checks its depth and length afterward.
func blockShellTypes(rel string) (string, bool) {
	var kept []string
	for _, p := range strings.Split(rel, string(filepath.Separator)) {
		p = sanitizeComponent(stripClassIDs(p), runtime.GOOS)
		if p != ".." && p != "." && p != "" {
			kept = append(kept, p)
		}
	}
	if len(kept) == 0 {
		kept = []string{"received_file"}
	}
	leaf := strings.TrimRight(kept[len(kept)-1], " .")
	renamed := foldIn(filepath.Ext(leaf), blockedExtensions) || foldIn(leaf, blockedLeafNames)
	if renamed {
		kept[len(kept)-1] = leaf + blockedSuffix
	}
	return filepath.Join(kept...), renamed
}
