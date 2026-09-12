package transfer

// Control-frame parsing (control.go): what counts as a control message and
// what is file data, and the validation at the one place peer numbers enter.

import (
	"strings"
	"testing"
)

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

// TestLooksLikeJSONObject covers the cheap pre-check used before JSON parsing.
func TestLooksLikeJSONObject(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{`{"type":"end"}`, true},
		{"  \r\n\t{\"a\":1}", true}, // leading whitespace tolerated
		{`[1,2,3]`, false},          // array, not object
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
		wantType    string
		wantControl bool
	}{
		{"metadata string", `{"type":"metadata","id":"x","fileName":"a","fileSize":1,"index":1,"total":1}`, "metadata", true},
		{"end string", `{"type":"end"}`, "end", true},
		{"metadata as small binary", `{"type":"metadata","id":"x"}`, "metadata", true},
		// Protocol-direction messages are control so they are never written as file data.
		{"ack type is control", `{"type":"ack","id":"x","offset":0}`, "ack", true},
		{"received type is control", `{"type":"received"}`, "received", true},
		{"incompatible type is control", `{"type":"incompatible","reason":"too old"}`, "incompatible", true},
		// A tiny JSON file (its own content) must be treated as DATA, not dropped.
		{"json file content under 1KB", `{"hello":"world","n":42}`, "", false},
		// A JSON object whose type is unknown is still data, not control.
		{"unknown type", `{"type":"chat","msg":"hi"}`, "", false},
		// Raw binary that isn't JSON is data.
		{"raw binary", "\x89PNG\r\n\x1a\n....", "", false},
		// A string that isn't a control message is skipped (not control, not data).
		{"non-control string", "just some text", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotType, gotControl := classifyControl([]byte(tc.data))
			if gotType != tc.wantType || gotControl != tc.wantControl {
				t.Errorf("classifyControl(%q) = (%q, %v), want (%q, %v)",
					tc.data, gotType, gotControl, tc.wantType, tc.wantControl)
			}
		})
	}

	// Past controlMsgMax the framing no longer matters. A binary JSON object
	// larger than the cap is file data (matching the browser guard), and the
	// same shape arriving as a string, which is how a Floe sender frames its
	// metadata, is declined here too: the old gate was binary-only, so a
	// string was bounded by nothing but pion's default message size. The
	// message loop rejects an over-cap string with an error before it ever
	// asks this function; TestReceiverRejectsOversizeStringControl covers that.
	big := `{"type":"metadata",` + `"pad":"` + strings.Repeat("x", 1100) + `"}`
	if _, isControl := classifyControl([]byte(big)); isControl {
		t.Errorf("classifyControl on >1000-byte binary should be data, got control")
	}
	bigString := `{"type":"metadata","id":"x","fileName":"` + strings.Repeat("n", 1100) + `","fileSize":1,"index":1,"total":1}`
	if _, isControl := classifyControl([]byte(bigString)); isControl {
		t.Errorf("classifyControl on a >1000-byte string metadata should not be control")
	}
}

// TestParseMetadataProtocolFields verifies that pv/pvMin/ver are parsed from
// new-format metadata, and that legacy metadata (no such fields) returns zeros.
func TestParseMetadataProtocolFields(t *testing.T) {
	// New sender with pv/pvMin/ver
	withProto := `{"type":"metadata","id":"a","fileName":"f.txt","fileSize":1,"index":1,"total":1,"totalBytes":1,"pv":2,"pvMin":1,"ver":"v1.6.0"}`
	info, err := parseMetadata(withProto)
	if err != nil {
		t.Fatalf("parseMetadata with proto fields error: %v", err)
	}
	if info.Pv != 2 || info.PvMin != 1 || info.Ver != "v1.6.0" {
		t.Errorf("got Pv=%d PvMin=%d Ver=%q, want Pv=2 PvMin=1 Ver=v1.6.0", info.Pv, info.PvMin, info.Ver)
	}

	// Legacy sender without pv/pvMin/ver — fields default to zero/empty
	legacy := `{"type":"metadata","id":"b","fileName":"old.txt","fileSize":10,"index":1,"total":1}`
	info2, err := parseMetadata(legacy)
	if err != nil {
		t.Fatalf("parseMetadata legacy error: %v", err)
	}
	if info2.Pv != 0 || info2.PvMin != 0 || info2.Ver != "" {
		t.Errorf("legacy metadata should have zero pv fields, got Pv=%d PvMin=%d Ver=%q", info2.Pv, info2.PvMin, info2.Ver)
	}
	// And CheckCompat treats zero as v1 — must be compatible with current build
	ok, _ := CheckCompat(MinProtocolVersion, ProtocolVersion, info2.PvMin, info2.Pv)
	if !ok {
		t.Error("legacy peer (zero pv fields) must be compatible with current protocol")
	}
}

// TestParseMetadataRejectsImpossibleNumbers pins the validation at the one
// place peer numbers enter: a size that is negative, fractional or beyond the
// range JSON can carry exactly, and a batch position of zero, are refused
// with an error rather than handed to formatBytes and claimPart.
func TestParseMetadataRejectsImpossibleNumbers(t *testing.T) {
	frame := func(fields string) string {
		return `{"type":"metadata","id":"x","fileName":"a.bin",` + fields + `}`
	}
	reject := []struct{ name, fields string }{
		{"negative size", `"fileSize":-1,"index":1,"total":1`},
		{"size past int64", `"fileSize":1e300,"index":1,"total":1`},
		{"fractional size", `"fileSize":1.5,"index":1,"total":1`},
		{"size past float64", `"fileSize":1e999,"index":1,"total":1`}, // json.Unmarshal range error
		{"negative batch size", `"fileSize":1,"index":1,"total":1,"totalBytes":-1`},
		{"index zero", `"fileSize":1,"index":0,"total":1`},
		{"total zero", `"fileSize":1,"index":1,"total":0`},
		{"batch smaller than its own file", `"fileSize":10,"index":1,"total":1,"totalBytes":5`},
	}
	for _, tc := range reject {
		t.Run("rejects "+tc.name, func(t *testing.T) {
			if info, err := parseMetadata(frame(tc.fields)); err == nil {
				t.Errorf("parseMetadata accepted %s: %+v", tc.fields, info)
			}
		})
	}
	accept := []struct {
		name   string
		fields string
		size   int64
	}{
		{"zero size", `"fileSize":0,"index":1,"total":1`, 0},
		{"absent batch size", `"fileSize":1,"index":1,"total":1`, 1},
		{"batch equal to its single file", `"fileSize":10,"index":1,"total":1,"totalBytes":10`, 10},
		{"largest exact size", `"fileSize":9007199254740991,"index":1,"total":1`, 9007199254740991},
	}
	for _, tc := range accept {
		t.Run("accepts "+tc.name, func(t *testing.T) {
			info, err := parseMetadata(frame(tc.fields))
			if err != nil {
				t.Fatalf("parseMetadata rejected %s: %v", tc.fields, err)
			}
			if info.FileSize != tc.size {
				t.Errorf("FileSize = %d, want %d", info.FileSize, tc.size)
			}
		})
	}
}
