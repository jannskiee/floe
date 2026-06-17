package transfer

import (
	"os"
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
	valid := `{"type":"metadata","id":"abc","fileName":"a.txt","fileSize":1234,"index":1,"total":3,"totalBytes":98765}`
	info, err := parseMetadata(valid)
	if err != nil {
		t.Fatalf("parseMetadata(valid) error: %v", err)
	}
	if info.ID != "abc" || info.FileName != "a.txt" || info.FileSize != 1234 || info.Index != 1 || info.Total != 3 || info.TotalBytes != 98765 {
		t.Errorf("parseMetadata(valid) = %+v, unexpected fields", info)
	}

	if _, err := parseMetadata(`{"type":"end"}`); err == nil {
		t.Error("parseMetadata(end) should error: not a metadata message")
	}
	if _, err := parseMetadata(`not json`); err == nil {
		t.Error("parseMetadata(invalid json) should error")
	}
}

// TestParseMetadataNoTotalBytes verifies backward compat: a metadata message
// from an older CLI or browser sender (no totalBytes field) parses cleanly
// with TotalBytes == 0, which triggers the graceful "count only" fallback in
// the receiver display.
func TestParseMetadataNoTotalBytes(t *testing.T) {
	old := `{"type":"metadata","id":"x","fileName":"file.txt","fileSize":500,"index":1,"total":2}`
	info, err := parseMetadata(old)
	if err != nil {
		t.Fatalf("parseMetadata(old) error: %v", err)
	}
	if info.TotalBytes != 0 {
		t.Errorf("expected TotalBytes=0 when field absent, got %d", info.TotalBytes)
	}
}

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

// TestLooksLikeJSONObject covers the cheap pre-check used before JSON parsing.
func TestLooksLikeJSONObject(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{`{"type":"end"}`, true},
		{"  \r\n\t{\"a\":1}", true}, // leading whitespace tolerated
		{`[1,2,3]`, false},         // array, not object
		{`"a string"`, false},
		{`123`, false},
		{"", false},
		{"\x00\x01\x02binary", false},
	}
	for _, tc := range cases {
		if got := looksLikeJSONObject([]byte(tc.in)); got != tc.want {
			t.Errorf("looksLikeJSONObject(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

// TestClassifyControl is the regression guard for the framing bug: only genuine
// metadata/end JSON objects are control messages. A small file whose bytes are a
// JSON object must be classified as DATA (isControl=false) so it is never dropped.
func TestClassifyControl(t *testing.T) {
	cases := []struct {
		name        string
		data        string
		isString    bool
		wantType    string
		wantControl bool
	}{
		{"metadata string", `{"type":"metadata","id":"x","fileName":"a","fileSize":1,"index":1,"total":1}`, true, "metadata", true},
		{"end string", `{"type":"end"}`, true, "end", true},
		{"metadata as small binary", `{"type":"metadata","id":"x"}`, false, "metadata", true},
		// A tiny JSON file (its own content) must be treated as DATA, not dropped.
		{"json file content under 1KB", `{"hello":"world","n":42}`, false, "", false},
		// A JSON object whose type is unknown is still data, not control.
		{"unknown type", `{"type":"chat","msg":"hi"}`, false, "", false},
		// Raw binary that isn't JSON is data.
		{"raw binary", "\x89PNG\r\n\x1a\n....", false, "", false},
		// A string that isn't a control message is skipped (not control, not data).
		{"non-control string", "just some text", true, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotType, gotControl := classifyControl([]byte(tc.data), tc.isString)
			if gotType != tc.wantType || gotControl != tc.wantControl {
				t.Errorf("classifyControl(%q, isString=%v) = (%q, %v), want (%q, %v)",
					tc.data, tc.isString, gotType, gotControl, tc.wantType, tc.wantControl)
			}
		})
	}

	// A binary JSON object LARGER than 1000 bytes must be data (control probe is
	// capped at 1000 bytes for binary, matching the browser guard).
	big := `{"type":"metadata",` + `"pad":"` + strings.Repeat("x", 1100) + `"}`
	if _, isControl := classifyControl([]byte(big), false); isControl {
		t.Errorf("classifyControl on >1000-byte binary should be data, got control")
	}
}
