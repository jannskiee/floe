package transfer

// The on-disk name sanitizer (sanitize.go): containment inside the output dir,
// the exact per-hazard mapping on every target OS, and the drift guard that
// keeps it in step with the display sanitizer in format.go.

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestSafeJoin verifies that no crafted file name can escape the output dir.
func TestSafeJoin(t *testing.T) {
	outputDir := filepath.Join("tmp", "out")

	cases := []struct {
		name     string
		fileName string
	}{
		{"plain", "photo.jpg"},
		{"nested", "docs/report.pdf"},
		{"parent traversal", "../../etc/passwd"},
		{"rooted unix", "/etc/passwd"},
		{"windows volume", `C:\Windows\System32\cmd.exe`},
		{"unc path", `\\evil-host\share\file`},
		{"dot segments", "./a/./b/../c.txt"},
		{"empty", ""},
		{"only traversal", "../.."},
		// Names the sanitizer rewrites still have to stay inside outputDir.
		{"colon component", "backup:2026-08-19.log"},
		{"device name component", "NUL/x.txt"},
		{"control chars", "a\x00b/c\rd.txt"},
		{"trailing space parent", ".. /.. /secret.txt"},
		{"trailing space leaf", "evil.exe "},
		// Both components need sanitizing AND the directory level has to
		// survive: a whole-string sanitizer would flatten this to one name.
		{"nested with unsafe leaf", "docs<v2>/report:final.pdf"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := safeJoin(outputDir, tc.fileName)

			// Result must resolve to a path inside outputDir.
			rel, err := filepath.Rel(outputDir, got)
			if err != nil {
				t.Fatalf("filepath.Rel(%q, %q) error: %v", outputDir, got, err)
			}
			if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				t.Errorf("safeJoin(%q) escaped output dir: %q (rel %q)", tc.fileName, got, rel)
			}
			if filepath.IsAbs(rel) {
				t.Errorf("safeJoin(%q) produced absolute escape: %q", tc.fileName, got)
			}
		})
	}
}

// TestSafeJoinEmptyFallback ensures empty/degenerate names get a default.
func TestSafeJoinEmptyFallback(t *testing.T) {
	got := safeJoin("out", "")
	want := filepath.Join("out", "received_file")
	if got != want {
		t.Errorf("safeJoin(\"out\", \"\") = %q, want %q", got, want)
	}
}

// TestSanitizeComponent pins the exact output of the file name sanitizer for
// every hazard class, on every target OS.
//
// The exact-value assertions live here rather than in TestSafeJoin because
// sanitizeComponent is a pure function of (name, goos, build), so one table proves all
// three branches on all three CI legs. TestSafeJoin stays containment-only,
// which is what keeps IT host-independent.
//
// The linux/darwin rows are not filler: they are the anti-regression half. Every
// name Windows cannot represent is a legal, distinct file name on ext4 and APFS,
// and rewriting it there would lose fidelity for no security gain. Because those
// rows also run on the Windows leg, a future change that drops the goos gate
// fails on all three platforms rather than passing quietly on two.
//
// A "windows" row runs at windows11Build, the first build without the device
// stem rule, and a "windows10" row at win10Build. After the table, every
// "windows" row is run again at win10Build and must give the same answer,
// unless a "windows10" row gives that input an answer of its own: that is what
// holds the stem rule to the names it is for.
func TestSanitizeComponent(t *testing.T) {
	cases := []struct {
		name string
		in   string
		goos string
		want string
	}{
		// Reproduced Windows failures: each of these silently lost data,
		// aborted the batch, or detached the Mark of the Web before the fix.
		{"colon becomes underscore", "backup:2026-08-19.log", "windows", "backup_2026-08-19.log"},
		{"question mark", "what?.txt", "windows", "what_.txt"},
		{"angle brackets", "report<v2>.pdf", "windows", "report_v2_.pdf"},
		{"remaining reserved chars", `a"b|c*d.txt`, "windows", "a_b_c_d.txt"},
		{"substitution is one for one", "a:::b.txt", "windows", "a___b.txt"},

		// Trailing spaces and dots are trimmed, not substituted: Win32 drops
		// them while resolving, which is what detaches Zone.Identifier.
		{"trailing space", "evil.exe ", "windows", "evil.exe"},
		{"trailing dot", "evil.exe.", "windows", "evil.exe"},
		{"mixed trailing run", "evil.exe . . ", "windows", "evil.exe"},

		// Device names: whole-component match, case-insensitive, case-preserving.
		{"bare device name", "NUL", "windows", "_NUL"},
		{"device name lowercased", "nul", "windows", "_nul"},
		{"console device", "CONOUT$", "windows", "_CONOUT$"},
		{"serial port", "COM1", "windows", "_COM1"},
		// The superscript ports are on Microsoft's list: Windows reads the
		// Latin-1 superscripts as digits. They have no case, so a lowercase
		// prefix still matches. Superscript four is not a digit to Windows.
		{"superscript serial port", "COM¹", "windows", "_COM¹"},
		{"superscript printer port lowercased", "lpt³", "windows", "_lpt³"},
		{"superscript two", "Com²", "windows", "_Com²"},
		{"superscript four is not a port", "COM⁴", "windows", "COM⁴"},
		{"superscript port kept on linux", "COM¹", "linux", "COM¹"},
		// COM10 and COM0 are not devices, and CON.txt demonstrably creates an
		// ordinary file on Windows 11. Below Windows 11 a device name before
		// the first dot is one (the "windows10" rows); from Windows 11 on, the
		// whole component is matched and nothing that works gets touched.
		{"two digit port is not a device", "COM10", "windows", "COM10"},
		{"zero port is not a device", "COM0", "windows", "COM0"},
		{"device name with extension", "CON.txt", "windows", "CON.txt"},
		{"device name as a prefix", "CONTRACT.pdf", "windows", "CONTRACT.pdf"},
		{"device stem kept on windows 11", "aux.h", "windows", "aux.h"},
		{"port stem kept on windows 11", "COM1.log", "windows", "COM1.log"},
		{"spaced stem kept on windows 11", "nul .txt", "windows", "nul .txt"},

		// Windows 10 (deep QA A2-03): a device name before the FIRST dot, with
		// the spaces before that dot trimmed, still opens the device, so the
		// stem gets the same "_" a whole device name gets.
		{"device stem on windows 10", "aux.h", "windows10", "_aux.h"},
		{"device name with extension on windows 10", "CON.txt", "windows10", "_CON.txt"},
		{"port stem on windows 10", "COM1.log", "windows10", "_COM1.log"},
		{"printer port stem lowercased", "lpt9.x", "windows10", "_lpt9.x"},
		{"spaces before the dot are trimmed", "nul .txt", "windows10", "_nul .txt"},
		{"stem ends at the first dot", "NUL.tar.gz", "windows10", "_NUL.tar.gz"},
		{"trailing space trimmed before the stem is read", "aux.h ", "windows10", "_aux.h"},
		{"console name stem", "CONOUT$.txt", "windows10", "_CONOUT$.txt"},
		{"superscript port stem kept on windows 11", "COM¹.log", "windows", "COM¹.log"},
		{"superscript port stem on windows 10", "COM¹.log", "windows10", "_COM¹.log"},
		{"superscript printer port stem lowercased", "lpt² .x", "windows10", "_lpt² .x"},
		{"superscript four stem is not a device", "LPT⁴.x", "windows10", "LPT⁴.x"},
		{"bare device name on windows 10", "con", "windows10", "_con"},
		{"device name as a prefix on windows 10", "CONTRACT.pdf", "windows10", "CONTRACT.pdf"},
		{"two digit port stem is not a device", "COM10.log", "windows10", "COM10.log"},
		{"zero port stem is not a device", "COM0.log", "windows10", "COM0.log"},
		{"dotfile named like a device", ".aux", "windows10", ".aux"},
		{"leading space is not trimmed", " aux.h", "windows10", " aux.h"},
		// The colon, the other character Windows ends a stem at, is already
		// "_" when the stem is read, so it never ends one here.
		{"colon replaced before the stem is read", "aux:x.h", "windows10", "aux_x.h"},
		{"device stem kept on linux", "aux.h", "linux", "aux.h"},

		// Leading dots and spaces are legal on Windows and must survive.
		{"leading dot", ".hidden", "windows", ".hidden"},
		{"leading space", " leading.txt", "windows", " leading.txt"},

		// Degenerate components reduce to empty; safeJoin's filter drops them.
		{"dots only", "...", "windows", ""},
		{"parent with trailing space", ".. ", "windows", ""},
		{"ordinary name untouched", "photo.jpg", "windows", "photo.jpg"},

		// Anti-regression: none of the Windows rules apply off Windows.
		{"colon kept on linux", "backup:2026-08-19.log", "linux", "backup:2026-08-19.log"},
		{"question mark kept on linux", "what?.txt", "linux", "what?.txt"},
		{"angle brackets kept on darwin", "report<v2>.pdf", "darwin", "report<v2>.pdf"},
		{"trailing space kept on linux", "evil.exe ", "linux", "evil.exe "},
		{"device name kept on linux", "NUL", "linux", "NUL"},
		{"dots kept on linux", "...", "linux", "..."},
		{"parent with space kept on linux", ".. ", "linux", ".. "},

		// Every platform: controls and bidi overrides. These are never valid in
		// a name, and the name is printed to a terminal.
		{"nul byte", "a\x00b.txt", "windows", "a_b.txt"},
		{"carriage return rewrites the line", "log\r\n.txt", "linux", "log__.txt"},
		{"escape injects ansi", "esc\x1b[2Kfake.txt", "linux", "esc_[2Kfake.txt"},
		{"delete char", "del\x7f.txt", "darwin", "del_.txt"},
		{"right to left override", "photo\u202egnp.exe", "linux", "photo_gnp.exe"},
		{"directional isolates", "a\u2066b\u2069c.txt", "windows", "a_b_c.txt"},
		{"invisible marks", "a\u200eb.txt", "darwin", "a_b.txt"},
		// U+061C is the fourth Bidi_Control character and reorders exactly like
		// the RLM beside it, so leaving it out would be an inconsistency inside
		// a set the code presents as complete.
		{"arabic letter mark", "a\u061cb.txt", "linux", "a_b.txt"},
		// C1 controls: U+0085 is a line break. The browser twin strips these,
		// so Go has to as well or the two surfaces disagree on the same name.
		{"c1 next line", "a\u0085b.txt", "windows", "a_b.txt"},
		{"c1 upper bound", "a\u009fb.txt", "linux", "a_b.txt"},
		{"just below c1 is untouched", "a b.txt", "linux", "a b.txt"},

		// Right-to-left SCRIPT carries its own directionality and uses none of
		// those controls, so it must pass through byte for byte.
		{"arabic script untouched", "تقرير.pdf", "linux", "تقرير.pdf"},
		{"arabic script untouched on windows", "تقرير.pdf", "windows", "تقرير.pdf"},
		{"accented latin untouched", "réport résumé.pdf", "windows", "réport résumé.pdf"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			goos, build := testTarget(tc.goos)
			got := sanitizeComponent(tc.in, goos, build)
			if got != tc.want {
				t.Errorf("sanitizeComponent(%q, %q) = %q, want %q", tc.in, tc.goos, got, tc.want)
			}
			// Sanitizing is idempotent, which is what makes the mapping safe to
			// reason about across repeat sends and after claimPart de-collides.
			if again := sanitizeComponent(got, goos, build); again != got {
				t.Errorf("not idempotent: sanitizeComponent(%q, %q) = %q", got, tc.goos, again)
			}
		})
	}

	on10 := map[string]string{}
	for _, tc := range cases {
		if tc.goos == "windows10" {
			on10[tc.in] = tc.want
		}
	}
	for _, tc := range cases {
		if tc.goos != "windows" {
			continue
		}
		want, own := on10[tc.in]
		if !own {
			want = tc.want
		}
		if got := sanitizeComponent(tc.in, "windows", win10Build); got != want {
			t.Errorf("%s: sanitizeComponent(%q) on Windows 10 = %q, want %q", tc.name, tc.in, got, want)
		}
	}
}

// win10Build is a Windows 10 build (22H2) for the rows that need one.
const win10Build = 19045

// testTarget maps a table's goos column to sanitizeComponent's two arguments:
// "windows" is Windows 11, "windows10" is Windows 10, and anything else is
// that GOOS, whose build is never read.
func testTarget(label string) (goos string, build uint32) {
	switch label {
	case "windows":
		return "windows", windows11Build
	case "windows10":
		return "windows", win10Build
	}
	return label, 0
}

// TestDeviceStemRuleByBuild pins where the line falls: below the first
// Windows 11 build the stem rule applies, from it on it does not, and a build
// that could not be read (0) gets the rule, because an underscore in a name
// that would have worked costs less than a file that fails to save.
func TestDeviceStemRuleByBuild(t *testing.T) {
	cases := []struct {
		build uint32
		want  string
	}{
		{0, "_aux.h"},
		{10240, "_aux.h"}, // Windows 10 1507, the first Windows 10 build
		{20348, "_aux.h"}, // Windows Server 2022
		{windows11Build - 1, "_aux.h"},
		{windows11Build, "aux.h"},
		{26100, "aux.h"}, // Windows 11 24H2, Windows Server 2025
	}
	for _, c := range cases {
		if got := sanitizeComponent("aux.h", "windows", c.build); got != c.want {
			t.Errorf("sanitizeComponent(%q, windows, %d) = %q, want %q", "aux.h", c.build, got, c.want)
		}
	}
}

// TestHostWindowsBuild checks the read itself: on Windows it is a real build,
// at least Windows 10's first, and anywhere else it is 0 and never consulted.
func TestHostWindowsBuild(t *testing.T) {
	got := hostWindowsBuild()
	if runtime.GOOS == "windows" {
		if got < 10240 {
			t.Fatalf("hostWindowsBuild() = %d on Windows, want a real build (at least 10240)", got)
		}
		return
	}
	if got != 0 {
		t.Fatalf("hostWindowsBuild() = %d off Windows, want 0", got)
	}
}

// TestSafeJoinUsesThisWindowsBuild: safeJoin judges every component by this
// machine's own build, so the same name saves as "aux.h" on Windows 11 and as
// "_aux.h" on Windows 10, folder and file alike.
func TestSafeJoinUsesThisWindowsBuild(t *testing.T) {
	goos, build := runtime.GOOS, hostWindowsBuild()
	got := safeJoin("out", "con.d/aux.h")
	want := filepath.Join("out", sanitizeComponent("con.d", goos, build), sanitizeComponent("aux.h", goos, build))
	if got != want {
		t.Errorf("safeJoin(\"out\", \"con.d/aux.h\") = %q, want %q", got, want)
	}
}

// TestSafeJoinSanitizedFallback covers the case where sanitizing, rather than an
// empty input, is what leaves nothing to work with. On Windows "..." trims away
// entirely and the default name takes over; elsewhere it is a legal name.
func TestSafeJoinSanitizedFallback(t *testing.T) {
	got := safeJoin("out", "...")
	want := filepath.Join("out", "...")
	if runtime.GOOS == "windows" {
		want = filepath.Join("out", "received_file")
	}
	if got != want {
		t.Errorf("safeJoin(\"out\", \"...\") = %q, want %q", got, want)
	}
}

// TestSanitizeRuneSharedByBothSanitizers is the drift guard: off Windows, the
// on-disk sanitizer and the display sanitizer must agree on every hostile
// input, because a name that reads one way in the accept prompt and lands
// another way on disk is the spoof this fix exists to close.
func TestSanitizeRuneSharedByBothSanitizers(t *testing.T) {
	hostile := []string{
		"photo\u202egnp.exe",
		"esc\x1b[2Kfake.txt",
		"log\r\n.txt",
		"del\x7f.txt",
		"a\u2066b\u2069c.txt",
		"a\u200eb.txt",
		"a\u061cb.txt",
		"a\u0085b.txt",
		"a\x00b.txt",
		"backup:2026-08-19.log",
		"what?.txt",
		"تقرير.pdf",
	}
	for _, in := range hostile {
		got, want := displayText(in, 10000), sanitizeComponent(in, "linux", 0)
		if got != want {
			t.Errorf("displayText(%q) = %q, but sanitizeComponent(linux) = %q", in, got, want)
		}
	}
}

// TestSafeFolderName pins the exported single-component wrapper: whatever the
// input, the result is one component (no separator of either kind), never "."
// or "..", and on this OS it follows sanitizeComponent's rules exactly.
func TestSafeFolderName(t *testing.T) {
	win := runtime.GOOS == "windows"
	pick := func(onWindows, elsewhere string) string {
		if win {
			return onWindows
		}
		return elsewhere
	}
	cases := []struct{ in, want string }{
		{"Acme footage", "Acme footage"},
		{"a/b\\c", "a_b_c"},
		{"../../Windows", pick(".._.._Windows", ".._.._Windows")},
		{"..", ""},
		{".", ""},
		{"", ""},
		{"x\x00y\x1b", "x_y_"},
		{"photo\u202egnp", "photo_gnp"},
		{"a\u2066b", "a_b"},
		{`a<b>c:d"e|f?g*h`, pick("a_b_c_d_e_f_g_h", `a<b>c:d"e|f?g*h`)},
		{"CON", pick("_CON", "CON")},
		{"com1", pick("_com1", "com1")},
		{"name. ", pick("name", "name. ")},
		{" . ", pick("", " . ")},
		{"تقرير", "تقرير"},
	}
	for _, c := range cases {
		got := SafeFolderName(c.in)
		if got != c.want {
			t.Errorf("SafeFolderName(%q) = %q, want %q", c.in, got, c.want)
		}
		if strings.ContainsAny(got, `/\`) {
			t.Errorf("SafeFolderName(%q) = %q keeps a separator", c.in, got)
		}
		if got == "." || got == ".." {
			t.Errorf("SafeFolderName(%q) = %q, a traversal component", c.in, got)
		}
	}
}

// TestSafeFolderNameDeviceStem: the owner's request-link label names a folder
// ("<label> YYYY-MM-DD HHMM"), and on Windows 10 a label such as "CON.x" makes
// that folder the console, so the drop stopped before a file was saved. Below
// windows11Build the label gets the same "_" a received file does; Windows 11
// and every other OS keep it.
func TestSafeFolderNameDeviceStem(t *testing.T) {
	cases := []struct {
		in    string
		goos  string
		build uint32
		want  string
	}{
		{"CON.x", "windows", win10Build, "_CON.x"},
		{"CON.x", "windows", windows11Build, "CON.x"},
		{"CON.x", "linux", win10Build, "CON.x"},
		{"nul .notes", "windows", win10Build, "_nul .notes"},
		{"Lpt1.backup", "windows", win10Build, "_Lpt1.backup"},
		{"COM³.notes", "windows", win10Build, "_COM³.notes"},
		{"COM³.notes", "windows", windows11Build, "COM³.notes"},
		{"lpt¹", "windows", windows11Build, "_lpt¹"},
		// The separator becomes "_" first, so the stem is "aux_x", not "aux".
		{"aux/x.h", "windows", win10Build, "aux_x.h"},
		{"CONTRACT.x", "windows", win10Build, "CONTRACT.x"},
		{"con", "windows", windows11Build, "_con"},
	}
	for _, c := range cases {
		if got := safeFolderName(c.in, c.goos, c.build); got != c.want {
			t.Errorf("safeFolderName(%q, %q, %d) = %q, want %q", c.in, c.goos, c.build, got, c.want)
		}
	}
	// The exported wrapper is the same function at this machine's own build.
	if got, want := SafeFolderName("CON.x"), safeFolderName("CON.x", runtime.GOOS, hostWindowsBuild()); got != want {
		t.Errorf("SafeFolderName(%q) = %q, want %q (this machine's build)", "CON.x", got, want)
	}
}
