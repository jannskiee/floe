package transfer

// Formatting for people (format.go): batch summaries, byte and name
// formatting, and the display sanitizer every peer string passes through on
// its way to a terminal or a status line.

import (
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

// TestSummarizeSingleFile covers the single-file label format ("name · size").
func TestSummarizeSingleFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "report.pdf")
	if err := os.WriteFile(path, make([]byte, 1024*512), 0644); err != nil { // 512 KB
		t.Fatal(err)
	}
	s, err := Summarize([]string{path})
	if err != nil {
		t.Fatalf("Summarize error: %v", err)
	}
	if s.Files != 1 {
		t.Errorf("Files = %d, want 1", s.Files)
	}
	if s.TotalBytes != 1024*512 {
		t.Errorf("TotalBytes = %d, want %d", s.TotalBytes, 1024*512)
	}
	// Label must contain the filename and a size component.
	if !strings.Contains(s.Label, "report.pdf") {
		t.Errorf("Label %q does not contain filename", s.Label)
	}
	if !strings.Contains(s.Label, "KB") && !strings.Contains(s.Label, "MB") {
		t.Errorf("Label %q has no size unit", s.Label)
	}
}

// TestSummarizeMultiFile covers the multi-file label format ("N files · size").
func TestSummarizeMultiFile(t *testing.T) {
	dir := t.TempDir()
	for i, name := range []string{"a.txt", "b.txt"} {
		data := make([]byte, (i+1)*1024)
		if err := os.WriteFile(filepath.Join(dir, name), data, 0644); err != nil {
			t.Fatal(err)
		}
	}
	s, err := Summarize([]string{filepath.Join(dir, "a.txt"), filepath.Join(dir, "b.txt")})
	if err != nil {
		t.Fatalf("Summarize error: %v", err)
	}
	if s.Files != 2 {
		t.Errorf("Files = %d, want 2", s.Files)
	}
	if !strings.Contains(s.Label, "2 files") {
		t.Errorf("Label %q does not contain '2 files'", s.Label)
	}
}

// TestDisplayText pins the display sanitizer: the on-disk rune mapping, a rune
// cap with an ellipsis, and nothing else. The Windows-only rules do not apply,
// because a name on screen is not stored anywhere. Every row is also checked
// for idempotence, which is what lets a value that was displayed once be run
// through again (the desktop persists FirstName into history) unchanged.
func TestDisplayText(t *testing.T) {
	exact := []struct {
		name string
		in   string
		max  int
		want string
	}{
		{"right to left override", "photo\u202egnp.exe", maxDisplayName, "photo_gnp.exe"},
		{"escape sequence", "\x1b[2Kfake.txt", maxDisplayName, "_[2Kfake.txt"},
		{"carriage return", "a\rb", maxDisplayName, "a_b"},
		{"arabic script untouched", "تقرير.pdf", maxDisplayName, "تقرير.pdf"},
		{"accented latin untouched", "réport résumé.pdf", maxDisplayName, "réport résumé.pdf"},
		{"underscore untouched", "a_b.txt", maxDisplayName, "a_b.txt"},
		{"windows reserved char kept on screen", "backup:2026.log", maxDisplayName, "backup:2026.log"},
		{"empty", "", maxDisplayName, ""},
		{"real version string", "v1.10.4", maxDisplayVer, "v1.10.4"},
		// The cap shortens the stem and keeps the extension, so a long name
		// cannot hide what it is at the accept prompt.
		{"long name keeps its extension", strings.Repeat("n", 250) + ".txt", maxDisplayName, strings.Repeat("n", 195) + "….txt"},
		{"long stem before exe still says exe", strings.Repeat("a", 251) + ".exe", maxDisplayName, strings.Repeat("a", 195) + "….exe"},
		{"tail past 16 runes is not an extension", strings.Repeat("n", 250) + "." + strings.Repeat("e", 20), maxDisplayName, strings.Repeat("n", 199) + "…"},
		{"dotfile has no extension to keep", "." + strings.Repeat("n", 250), maxDisplayName, "." + strings.Repeat("n", 198) + "…"},
	}
	for _, tc := range exact {
		t.Run(tc.name, func(t *testing.T) {
			got := displayText(tc.in, tc.max)
			if got != tc.want {
				t.Errorf("displayText(%q, %d) = %q, want %q", tc.in, tc.max, got, tc.want)
			}
			if again := displayText(got, tc.max); again != got {
				t.Errorf("not idempotent: displayText(%q) = %q", got, again)
			}
		})
	}

	capped := []struct {
		name  string
		in    string
		max   int
		check func(t *testing.T, got string)
	}{
		{"5000 ascii runes", strings.Repeat("x", 5000), maxDisplayName, func(t *testing.T, got string) {
			if n := utf8.RuneCountInString(got); n != 200 {
				t.Errorf("rune count = %d, want 200", n)
			}
			if !strings.HasSuffix(got, "…") || !strings.HasPrefix(got, strings.Repeat("x", 199)) {
				t.Errorf("want 199 x then an ellipsis, got %q", got)
			}
		}},
		{"300 emoji, a cut that must not split a rune", strings.Repeat("😀", 300), maxDisplayName, func(t *testing.T, got string) {
			if n := utf8.RuneCountInString(got); n != 200 {
				t.Errorf("rune count = %d, want 200", n)
			}
			if !utf8.ValidString(got) {
				t.Errorf("cut inside a rune: %q", got)
			}
		}},
		{"10 KB version string", strings.Repeat("v", 10*1024), maxDisplayVer, func(t *testing.T, got string) {
			if n := utf8.RuneCountInString(got); n != 64 {
				t.Errorf("rune count = %d, want 64", n)
			}
		}},
		{"5 KB multi-line reason", strings.Repeat("line one\nline two\n", 300), maxDisplayReason, func(t *testing.T, got string) {
			if n := utf8.RuneCountInString(got); n != 300 {
				t.Errorf("rune count = %d, want 300", n)
			}
			if strings.Contains(got, "\n") {
				t.Errorf("a newline survived: %q", got)
			}
		}},
	}
	for _, tc := range capped {
		t.Run(tc.name, func(t *testing.T) {
			got := displayText(tc.in, tc.max)
			tc.check(t, got)
			if again := displayText(got, tc.max); again != got {
				t.Errorf("not idempotent: displayText(%q) = %q", got, again)
			}
		})
	}
}

// TestFormatBytesNeverPanics pins the guard for the crash a hostile size used
// to cause: math.Log of a negative is NaN, int(NaN) is MinInt64 on amd64, and
// the clamp only guarded the top, so units[i] panicked on the receive
// goroutine and, in the desktop app, ended the whole process.
func TestFormatBytesNeverPanics(t *testing.T) {
	for _, tc := range []struct {
		in   int64
		want string
	}{
		{-1, "0 Bytes"},
		{math.MinInt64, "0 Bytes"},
		{0, "0 Bytes"},
		{1536, "1.5 KB"},
	} {
		if got := formatBytes(tc.in); got != tc.want {
			t.Errorf("formatBytes(%d) = %q, want %q", tc.in, got, tc.want)
		}
	}
	if got := formatBytes(math.MaxInt64); !strings.Contains(got, "TB") {
		t.Errorf("formatBytes(MaxInt64) = %q, want a TB value", got)
	}
}

// TestTruncateNameCountsRunes: the cut is in runes, so a multi-byte name never
// loses half a character to the ellipsis.
func TestTruncateNameCountsRunes(t *testing.T) {
	got := truncateName("ééééé", 3)
	if got != "éé…" {
		t.Errorf("truncateName(ééééé, 3) = %q, want %q", got, "éé…")
	}
	if !utf8.ValidString(got) {
		t.Errorf("cut inside a rune: %q", got)
	}
	if got := truncateName("ab", 3); got != "ab" {
		t.Errorf("short name changed: %q", got)
	}
}
