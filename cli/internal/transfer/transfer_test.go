package transfer

import (
	"path/filepath"
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

// TestParseMetadata covers valid and invalid metadata payloads.
func TestParseMetadata(t *testing.T) {
	valid := `{"type":"metadata","id":"abc","fileName":"a.txt","fileSize":1234,"index":1,"total":3}`
	info, err := parseMetadata(valid)
	if err != nil {
		t.Fatalf("parseMetadata(valid) error: %v", err)
	}
	if info.ID != "abc" || info.FileName != "a.txt" || info.FileSize != 1234 || info.Index != 1 || info.Total != 3 {
		t.Errorf("parseMetadata(valid) = %+v, unexpected fields", info)
	}

	if _, err := parseMetadata(`{"type":"end"}`); err == nil {
		t.Error("parseMetadata(end) should error: not a metadata message")
	}
	if _, err := parseMetadata(`not json`); err == nil {
		t.Error("parseMetadata(invalid json) should error")
	}
}
