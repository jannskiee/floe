package transfer

// Turning a peer-supplied file name into a path this machine is willing to
// write. Every rule here is a defense against a name chosen by the other side.

import (
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// safeJoin prevents path traversal attacks by cleaning the relative file name
// and ensuring it stays inside the output directory.
func safeJoin(outputDir, fileName string) string {
	// Normalize separators first (the browser sends forward slashes).
	name := filepath.FromSlash(fileName)
	// Strip any volume name (e.g. "C:" or a "\\host\share" UNC prefix on
	// Windows) so an absolute or UNC path can never anchor outside outputDir.
	name = strings.TrimPrefix(name, filepath.VolumeName(name))
	clean := filepath.Clean(name)
	// Drop empty (leading separator → rooted path), "." and ".." components.
	//
	// sanitizeComponent runs FIRST so the traversal filter below judges the
	// string that will actually reach the filesystem, not the one the peer
	// sent. Keep that order, and keep the filter itself untouched: a component
	// that a trailing trim reduces to ".." or "" has to meet the same test
	// every other component meets.
	parts := strings.Split(clean, string(filepath.Separator))
	goos, build := runtime.GOOS, hostWindowsBuild()
	var safe []string
	for _, p := range parts {
		p = sanitizeComponent(p, goos, build)
		if p != ".." && p != "." && p != "" {
			safe = append(safe, p)
		}
	}
	if len(safe) == 0 {
		safe = []string{"received_file"}
	}
	return filepath.Join(outputDir, filepath.Join(safe...))
}

// reservedDeviceNames are the Win32 device names a file cannot be called.
// sanitizeComponent matches them, case-insensitively, by two rules:
//
//   - The whole component, on every Windows build. "CONTRACT.pdf" never
//     matches.
//   - The stem, below windows11Build only: the part before the FIRST dot, less
//     the spaces Windows trims before that dot, so "aux.h", "CON.txt" and
//     "nul .txt" all match there.
//
// The stem rule is the widespread advice, and Windows 11 no longer needs it:
// "CON.txt", "AUX.log" and even "NUL.txt" all create ordinary files there, so
// applying it on every build would rename names that demonstrably work. On
// Windows 10 it is still needed: deep QA (A2-03) measured that "aux.h" and
// "con.txt" open the device there, so claimPart refused the file as not a
// regular file and the transfer or the drop stopped at it. The owner's
// answer was to hold the stem rule to the builds below Windows 11 (answer 18,
// 2026-10-16) and keep every name Windows 11 can store as it is.
//
// On Windows 11 with go1.26.3, measured, only bare "NUL" actually reaches a
// device; "CON", "AUX", "PRN", "COM1".."COM9" and "LPT1".."LPT9" all produce
// ordinary files. The rest of the list is kept anyway rather than trimmed to
// NUL alone: the set is a documented Win32 constraint that older Windows
// versions and non-Go APIs do enforce, and renaming a file nobody sensibly
// calls "CON" is far cheaper than silently losing one. The stem rule uses the
// same list, CONIN$ and CONOUT$ included; a stem it renames that Windows 10
// would have accepted costs an underscore, never the file. The IsRegular check
// at the call site is what actually catches whatever this list misses.
//
// The superscript ports (COM¹ COM² COM³ LPT¹ LPT² LPT³) are on Microsoft's
// list because Windows reads the Latin-1 superscripts ¹ ² ³ as digits; no
// other superscript counts, and neither does 0, so COM0 and COM⁴ stay out.
// They have no case, so strings.ToUpper leaves them as they are and the
// lookup matches "com¹" too. Measured on Windows 11 build 26200, "COM¹",
// "LPT³" and "COM¹.txt" all create ordinary files, like "COM1".
var reservedDeviceNames = map[string]struct{}{
	"CON": {}, "PRN": {}, "AUX": {}, "NUL": {},
	"COM1": {}, "COM2": {}, "COM3": {}, "COM4": {}, "COM5": {},
	"COM6": {}, "COM7": {}, "COM8": {}, "COM9": {},
	"COM¹": {}, "COM²": {}, "COM³": {},
	"LPT1": {}, "LPT2": {}, "LPT3": {}, "LPT4": {}, "LPT5": {},
	"LPT6": {}, "LPT7": {}, "LPT8": {}, "LPT9": {},
	"LPT¹": {}, "LPT²": {}, "LPT³": {},
	"CONIN$": {}, "CONOUT$": {},
}

// windows11Build is the first Windows 11 build. A build below it gets the
// device stem rule, and so does a build of 0, which is what an unread build
// looks like: wrongly applied, the rule puts an underscore in front of a name
// that would have worked; wrongly skipped, a file fails to save. Windows Server
// 2022 (20348) is below the line and Windows Server 2025 (26100) above it.
const windows11Build = 22000

// hostWindowsBuild is this machine's Windows build, read once (readWindowsBuild,
// in winbuild_windows.go and its twin). Off Windows it is 0, which no rule
// consults, because every rule that reads a build is gated on goos.
var hostWindowsBuild = sync.OnceValue(readWindowsBuild)

// isDeviceName reports whether s is one of reservedDeviceNames, in any case.
func isDeviceName(s string) bool {
	_, reserved := reservedDeviceNames[strings.ToUpper(s)]
	return reserved
}

// deviceStem is the part of a trimmed component that Windows 10 compares with
// the device names: everything before the first dot, less trailing spaces. A
// colon, the other character Windows ends it at, is already "_" by then.
func deviceStem(trimmed string) string {
	stem, _, _ := strings.Cut(trimmed, ".")
	return strings.TrimRight(stem, " ")
}

// sanitizeComponent rewrites one peer-supplied path component into a name the
// receiving system can actually represent.
//
// The caller passes exactly one component (no separators) and must cope with
// two legitimate outputs: "" when everything was stripped, and ".." when a
// trailing trim exposes one. safeJoin's existing filter handles both.
//
// This function runs only inside safeJoin, AFTER the Incoming box, the accept
// prompt, OnIncoming and OnProgress have already used the name, so it protects
// the disk and nothing else. The terminal and the GUI callbacks are protected
// by displayText, which shares sanitizeRune with this function so the two can
// never disagree about what a control or a bidi mark becomes.
//
// Two classes of rule, gated differently on purpose:
//
//   - Every platform: C0 controls, DEL, and the Unicode bidi controls become
//     "_". Controls are never valid in a name, and a bare \r or \x1b inside one
//     is only ever an attempt at the terminal or the file manager that shows it.
//     The bidi controls are the spoofing vector:
//     "photo‮gnp.exe" renders as "photoexe.png" in Explorer, Finder and
//     GNOME Files alike, so gating them to Windows would leave the other two
//     exposed. Text that is inherently right-to-left (Arabic, Hebrew) needs no
//     control character and is left alone.
//
//   - Windows only: the characters Win32 reserves become "_", trailing spaces
//     and dots are trimmed, and a component that IS a device name is prefixed,
//     as is one whose stem is a device name when build is below
//     windows11Build (see reservedDeviceNames). Those names are legal and
//     distinct on ext4 and APFS, so rewriting them elsewhere would lose
//     fidelity for no security gain. The RECEIVER's OS is the correct gate,
//     because this process is the one creating the file.
//
// Trailing spaces and dots are trimmed rather than replaced because Win32 drops
// them while resolving a path, so such a name does not refer to the file it
// appears to. That is what silently detaches the Mark of the Web: for
// "evil.exe " the bytes land on a real "evil.exe", but applyMOTW then writes
// "evil.exe :Zone.Identifier", where the space is interior and survives, so the
// stream attaches to something else and the saved file carries no zone tag.
// Substituting "evil.exe_" would keep the name distinct but destroy the
// extension association, which is a worse outcome than a de-collision.
//
// The replacement character is "_", and that mapping is a compatibility
// surface rather than an implementation detail: changing it later means a
// repeat receive lands as a separate file instead of "name (1).ext", and
// desktop history rows persisted with the old SavedName stop resolving (see
// Progress.SavedName). "_" is never itself a replacement target, so sanitizing
// twice gives the same answer as sanitizing once.
//
// goos and build (the Windows build number, read only when goos is "windows")
// are parameters rather than a build tag so that every branch is exercised on
// all three CI legs, matching selfupdate.AssetName and desktop's
// revealCmd/openCmd. The rules here are a decision about the target OS, not an
// operation that only exists on one (which is what motw_windows.go is for).
// Callers pass runtime.GOOS and hostWindowsBuild().
func sanitizeComponent(name, goos string, build uint32) string {
	windows := goos == "windows"

	// strings.Map rewrites invalid UTF-8 to U+FFFD. That is harmless here:
	// FileName arrives through json.Unmarshal, which has already made the same
	// substitution before this code ever sees the name.
	clean := strings.Map(func(r rune) rune { return sanitizeRune(r, windows) }, name)

	if !windows {
		return clean
	}

	// "." and ".." trim to "", and the caller's filter drops them either way.
	trimmed := strings.TrimRight(clean, " .")
	if trimmed == "" {
		return ""
	}
	if isDeviceName(trimmed) || (build < windows11Build && isDeviceName(deviceStem(trimmed))) {
		return "_" + trimmed
	}
	return trimmed
}

// SafeFolderName turns one name into a single path component this machine can
// create, by the rules sanitizeComponent applies to a peer-supplied component:
// controls and bidi marks become "_" on every platform; on Windows the reserved
// characters become "_", trailing spaces and dots go, and a device name is
// prefixed (below Windows 11, a device name before the first dot as well). Both
// path separators become "_" first, so the result is always ONE component and
// can never climb out of the folder it is joined onto.
//
// "" means nothing usable was left, and so do "." and "..", which a caller must
// never join onto a folder: each caller picks its own fallback name. The
// desktop's request lane names the subfolder a drop is saved into after the
// owner's label with it (spec 06 4.7).
func SafeFolderName(name string) string {
	return safeFolderName(name, runtime.GOOS, hostWindowsBuild())
}

// safeFolderName is SafeFolderName for a given goos and Windows build, so a
// test can pin each rule on every CI leg.
func safeFolderName(name, goos string, build uint32) string {
	one := strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' {
			return '_'
		}
		return r
	}, name)
	out := sanitizeComponent(one, goos, build)
	if out == "." || out == ".." {
		return ""
	}
	return out
}

// sanitizeRune is the one mapping shared by sanitizeComponent (on disk) and
// displayText (on screen), so the two can never disagree about what a control
// or a bidi mark becomes. windows adds the Win32 reserved characters, which
// only matter when this receiver's filesystem is the target.
//
// C1 matters because U+0085 is a line break: the browser twin strips it, so
// Go has to as well or the two surfaces disagree on the same name. The bidi
// set is written as escapes rather than the characters themselves, because
// the characters are invisible in an editor and one of them reverses the
// display of the line it sits on.
func sanitizeRune(r rune, windows bool) rune {
	switch {
	case r < 0x20 || (r >= 0x7f && r <= 0x9f): // C0, DEL, C1 (U+0085 is a line break)
		return '_'
	case r == '\u061c', // ALM, the fourth Bidi_Control mark
		r == '\u200e' || r == '\u200f', // LRM, RLM
		r >= '\u202a' && r <= '\u202e', // embeddings and overrides
		r >= '\u2066' && r <= '\u2069': // isolates
		return '_'
	case windows && strings.ContainsRune(`<>:"|?*`, r):
		return '_'
	}
	return r
}
