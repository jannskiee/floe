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
