package transfer

// Turning a peer-supplied file name into a path this machine is willing to
// write. Every rule here is a defense against a name chosen by the other side.

import (
	"path/filepath"
	"runtime"
	"strings"
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
	var safe []string
	for _, p := range parts {
		p = sanitizeComponent(p, runtime.GOOS)
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
//
// The match is on the WHOLE component, case-insensitively, and deliberately
// NOT on the stem before the extension. The widespread advice is stem-based,
// but "CON.txt", "AUX.log" and even "NUL.txt" all create ordinary files on
// Windows 11, so a stem rule would rename names that demonstrably work.
// "CONTRACT.pdf" never matches under either rule.
//
// On Windows 11 with go1.26.3, measured, only bare "NUL" actually reaches a
// device; "CON", "AUX", "PRN", "COM1".."COM9" and "LPT1".."LPT9" all produce
// ordinary files. The rest of the list is kept anyway rather than trimmed to
// NUL alone: the set is a documented Win32 constraint that older Windows
// versions and non-Go APIs do enforce, and renaming a file nobody sensibly
// calls "CON" is far cheaper than silently losing one. The IsRegular check at
// the call site is what actually catches whatever this list misses.
var reservedDeviceNames = map[string]struct{}{
	"CON": {}, "PRN": {}, "AUX": {}, "NUL": {},
	"COM1": {}, "COM2": {}, "COM3": {}, "COM4": {}, "COM5": {},
	"COM6": {}, "COM7": {}, "COM8": {}, "COM9": {},
	"LPT1": {}, "LPT2": {}, "LPT3": {}, "LPT4": {}, "LPT5": {},
	"LPT6": {}, "LPT7": {}, "LPT8": {}, "LPT9": {},
	"CONIN$": {}, "CONOUT$": {},
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
//     and dots are trimmed, and a component that IS a device name is prefixed.
//     Those names are legal and distinct on ext4 and APFS, so rewriting them
//     elsewhere would lose fidelity for no security gain. The RECEIVER's OS is
//     the correct gate, because this process is the one creating the file.
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
// goos is a parameter rather than a build tag so that every branch is
// exercised on all three CI legs, matching selfupdate.AssetName and desktop's
// revealCmd/openCmd. The rules here are a decision about the target OS, not an
// operation that only exists on one (which is what motw_windows.go is for).
func sanitizeComponent(name, goos string) string {
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
	if _, reserved := reservedDeviceNames[strings.ToUpper(trimmed)]; reserved {
		return "_" + trimmed
	}
	return trimmed
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
