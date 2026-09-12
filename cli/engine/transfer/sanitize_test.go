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
// sanitizeComponent is a pure function of (name, goos), so one table proves all
// three branches on all three CI legs. TestSafeJoin stays containment-only,
// which is what keeps IT host-independent.
//
// The linux/darwin rows are not filler: they are the anti-regression half. Every
// name Windows cannot represent is a legal, distinct file name on ext4 and APFS,
// and rewriting it there would lose fidelity for no security gain. Because those
// rows also run on the Windows leg, a future change that drops the goos gate
// fails on all three platforms rather than passing quietly on two.
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
		// COM10 and COM0 are not devices, and CON.txt demonstrably creates an
		// ordinary file on Windows 11. The widespread stem-based rule would
		// rename all three. Match the whole component and nothing that works
		// gets touched.
		{"two digit port is not a device", "COM10", "windows", "COM10"},
		{"zero port is not a device", "COM0", "windows", "COM0"},
		{"device name with extension", "CON.txt", "windows", "CON.txt"},
		{"device name as a prefix", "CONTRACT.pdf", "windows", "CONTRACT.pdf"},

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
		{"right to left override", "photo‮gnp.exe", "linux", "photo_gnp.exe"},
		{"directional isolates", "a⁦b⁩c.txt", "windows", "a_b_c.txt"},
		{"invisible marks", "a‎b.txt", "darwin", "a_b.txt"},
		// U+061C is the fourth Bidi_Control character and reorders exactly like
		// the RLM beside it, so leaving it out would be an inconsistency inside
		// a set the code presents as complete.
		{"arabic letter mark", "a؜b.txt", "linux", "a_b.txt"},
		// C1 controls: U+0085 is a line break. The browser twin strips these,
		// so Go has to as well or the two surfaces disagree on the same name.
		{"c1 next line", "ab.txt", "windows", "a_b.txt"},
		{"c1 upper bound", "ab.txt", "linux", "a_b.txt"},
		{"just below c1 is untouched", "a b.txt", "linux", "a b.txt"},

		// Right-to-left SCRIPT carries its own directionality and uses none of
		// those controls, so it must pass through byte for byte.
		{"arabic script untouched", "تقرير.pdf", "linux", "تقرير.pdf"},
		{"arabic script untouched on windows", "تقرير.pdf", "windows", "تقرير.pdf"},
		{"accented latin untouched", "réport résumé.pdf", "windows", "réport résumé.pdf"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := sanitizeComponent(tc.in, tc.goos)
			if got != tc.want {
				t.Errorf("sanitizeComponent(%q, %q) = %q, want %q", tc.in, tc.goos, got, tc.want)
			}
			// Sanitizing is idempotent, which is what makes the mapping safe to
			// reason about across repeat sends and after claimPart de-collides.
			if again := sanitizeComponent(got, tc.goos); again != got {
				t.Errorf("not idempotent: sanitizeComponent(%q, %q) = %q", got, tc.goos, again)
			}
		})
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
		got, want := displayText(in, 10000), sanitizeComponent(in, "linux")
		if got != want {
			t.Errorf("displayText(%q) = %q, but sanitizeComponent(linux) = %q", in, got, want)
		}
	}
}
