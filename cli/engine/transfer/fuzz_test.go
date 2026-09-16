package transfer

// Fuzz targets for the decoders that read what the other machine chose
// (DV-FUZZ). Each target is pure: it never touches the disk or the network,
// and FuzzSafeJoin only builds path strings under a directory nobody creates.
//
// The seeds are the pairing spike's hostile metadata (F1 to F6, baseline
// 02-pairing-spike) and the boundary set of the DV-FUZZ inventory. They are
// added with f.Add, and the same values are committed as files under
// testdata/fuzz/Fuzz<Name>/seed-* so the corpus directories exist in git:
// FLOE_WRITE_FUZZ_SEEDS=1 go test -run '^Fuzz' . rewrites those files, and
// nothing else in this file ever writes.
//
// Control and bidi characters are built with ch() rather than written as
// escapes or pasted, so this file stays plain ASCII and a reader can see
// exactly which code point each seed carries.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"
)

// ch returns the one-rune string for code point n.
func ch(n rune) string { return string(n) }

// fuzzSeed is one named seed. Exactly one of text and data is used, by the
// target's input type.
type fuzzSeed struct {
	name string
	text string
	data []byte
}

// addSeeds registers the seeds with f and, when FLOE_WRITE_FUZZ_SEEDS=1,
// writes each one as a corpus file in the go test fuzz v1 encoding.
func addSeeds(f *testing.F, target string, seeds []fuzzSeed, asBytes bool) {
	f.Helper()
	write := os.Getenv("FLOE_WRITE_FUZZ_SEEDS") == "1"
	dir := filepath.Join("testdata", "fuzz", target)
	if write {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			f.Fatalf("seed dir: %v", err)
		}
	}
	for _, s := range seeds {
		var line string
		if asBytes {
			f.Add(s.data)
			line = "[]byte(" + strconv.Quote(string(s.data)) + ")"
		} else {
			f.Add(s.text)
			line = "string(" + strconv.Quote(s.text) + ")"
		}
		if write {
			body := "go test fuzz v1\n" + line + "\n"
			if err := os.WriteFile(filepath.Join(dir, "seed-"+s.name), []byte(body), 0o644); err != nil {
				f.Fatalf("seed %s: %v", s.name, err)
			}
		}
	}
}

// jsonString encodes s as a JSON string literal, quotes included.
func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// metaFrame builds a metadata frame around a file name and the numeric fields
// written as raw JSON, so a seed can carry a number no Go type would produce.
func metaFrame(name, numbers string) string {
	return `{"type":"metadata","id":"fz","fileName":` + jsonString(name) + `,` + numbers + `,"pv":1,"pvMin":1,"ver":"spike-raw"}`
}

const okNumbers = `"fileSize":4,"index":1,"total":1,"totalBytes":4`

// padFrame grows a metadata frame's name until the frame is exactly n bytes.
func padFrame(n int) string {
	base := metaFrame("", okNumbers)
	return metaFrame(strings.Repeat("p", n-len(base)), okNumbers)
}

func metadataSeeds() []fuzzSeed {
	deep := strings.Repeat("d/", 40) + "deep.txt"
	seeds := []fuzzSeed{
		// The pairing spike's F rows, byte for byte (zz_spike_hostoffer_test.go:963-969).
		{name: "F1-fileSize-2pow53", text: `{"type":"metadata","id":"f-1","fileName":"big.bin","fileSize":9007199254740992,"index":1,"total":1,"totalBytes":9007199254740992,"pv":1,"pvMin":1,"ver":"spike-raw"}`},
		{name: "F2-path-40-levels", text: `{"type":"metadata","id":"f-2","fileName":"` + deep + `","fileSize":4,"index":1,"total":1,"totalBytes":4,"pv":1,"pvMin":1,"ver":"spike-raw"}`},
		{name: "F3-bidi-override-name", text: `{"type":"metadata","id":"f-3","fileName":"photo` + ch(0x202e) + `gnp.exe","fileSize":4,"index":1,"total":1,"totalBytes":4,"pv":1,"pvMin":1,"ver":"spike-raw"}`},
		{name: "F4a-traversal-dotdot", text: `{"type":"metadata","id":"f-4a","fileName":"../../escape.txt","fileSize":4,"index":1,"total":1,"totalBytes":4,"pv":1,"pvMin":1,"ver":"spike-raw"}`},
		{name: "F4b-absolute-windows-path", text: `{"type":"metadata","id":"f-4b","fileName":"C:\\Windows\\System32\\evil.dll","fileSize":4,"index":1,"total":1,"totalBytes":4,"pv":1,"pvMin":1,"ver":"spike-raw"}`},
		{name: "F5-fileSize-2pow53-minus-1", text: `{"type":"metadata","id":"f-5","fileName":"big.bin","fileSize":9007199254740991,"index":1,"total":1,"totalBytes":9007199254740991,"pv":1,"pvMin":1,"ver":"spike-raw"}`},
		{name: "F6-name-704-bytes", text: `{"type":"metadata","id":"f-6","fileName":"` + strings.Repeat("n", 700) + `.txt","fileSize":4,"index":1,"total":1,"totalBytes":4,"pv":1,"pvMin":1,"ver":"spike-raw"}`},

		// Numbers at and past their edges.
		{name: "fileSize-minus-1", text: metaFrame("a.bin", `"fileSize":-1,"index":1,"total":1,"totalBytes":4`)},
		{name: "fileSize-0", text: metaFrame("a.bin", `"fileSize":0,"index":1,"total":1,"totalBytes":0`)},
		{name: "fileSize-1e300", text: metaFrame("a.bin", `"fileSize":1e300,"index":1,"total":1,"totalBytes":4`)},
		{name: "index-0", text: metaFrame("a.bin", `"fileSize":4,"index":0,"total":1,"totalBytes":4`)},
		{name: "index-10001", text: metaFrame("a.bin", `"fileSize":4,"index":10001,"total":10001,"totalBytes":4`)},
		{name: "total-0", text: metaFrame("a.bin", `"fileSize":4,"index":1,"total":0,"totalBytes":4`)},
		{name: "total-10001", text: metaFrame("a.bin", `"fileSize":4,"index":1,"total":10001,"totalBytes":4`)},
		{name: "totalBytes-absent", text: metaFrame("a.bin", `"fileSize":4,"index":1,"total":1`)},
		{name: "pv-0", text: `{"type":"metadata","id":"fz","fileName":"a.bin","fileSize":4,"index":1,"total":1,"totalBytes":4,"pv":0,"pvMin":0}`},

		// Names at the display cap (200 runes) and one past it.
		{name: "name-200-runes", text: metaFrame(strings.Repeat("r", 196)+".txt", okNumbers)},
		{name: "name-201-runes", text: metaFrame(strings.Repeat("r", 197)+".txt", okNumbers)},

		// Paths at the S1-ENG-03 limits: depth 32 and 33, and 240 and 241 UTF-16
		// units counting the ".part" suffix the staging file adds.
		{name: "depth-32", text: metaFrame(strings.Repeat("d/", 31)+"f.txt", okNumbers)},
		{name: "depth-33", text: metaFrame(strings.Repeat("d/", 32)+"f.txt", okNumbers)},
		{name: "units-240-with-part", text: metaFrame(strings.Repeat("u", 240-len(partSuffix)), okNumbers)},
		{name: "units-241-with-part", text: metaFrame(strings.Repeat("u", 241-len(partSuffix)), okNumbers)},

		// Shapes and the control frame cap.
		{name: "empty-object", text: `{}`},
		{name: "frame-1000-bytes", text: padFrame(controlMsgMax)},
		{name: "frame-1001-bytes", text: padFrame(controlMsgMax + 1)},
	}
	return seeds
}

// FuzzParseMetadata: parseMetadata never panics, and whatever it accepts has
// numbers the rest of the receiver can trust (metadataInvariant in
// control_test.go). The S1-ENG-03 limits (depth, path units, file count) are
// not properties yet: today's parser accepts those inputs by design, and the
// seeds that will prove the limits are already here.
func FuzzParseMetadata(f *testing.F) {
	addSeeds(f, "FuzzParseMetadata", metadataSeeds(), false)
	f.Fuzz(func(t *testing.T, text string) {
		info, err := parseMetadata(text)
		if err != nil {
			return
		}
		if bad := metadataInvariant(info); bad != "" {
			t.Fatalf("parseMetadata accepted %q: %s", text, bad)
		}
	})
}

var controlTypes = []string{"metadata", "end", "ack", "received", "incompatible"}

// sizedControl builds a control frame of exactly n bytes with the given type.
func sizedControl(typ string, n int) []byte {
	base := `{"type":"` + typ + `","pad":""}`
	return []byte(`{"type":"` + typ + `","pad":"` + strings.Repeat("x", n-len(base)) + `"}`)
}

func classifySeeds() []fuzzSeed {
	var seeds []fuzzSeed
	ws := " " + ch(9) + ch(13) + ch(10)
	for _, typ := range controlTypes {
		frame := `{"type":"` + typ + `"}`
		seeds = append(seeds,
			fuzzSeed{name: typ, data: []byte(frame)},
			fuzzSeed{name: typ + "-leading-whitespace", data: []byte(ws + frame)},
			fuzzSeed{name: typ + "-binary-prefix", data: append([]byte{0x00, 0xff, 0x01}, frame...)},
			fuzzSeed{name: typ + "-exactly-cap", data: sizedControl(typ, controlMsgMax)},
			fuzzSeed{name: typ + "-cap-plus-1", data: sizedControl(typ, controlMsgMax+1)},
		)
	}
	seeds = append(seeds,
		fuzzSeed{name: "unknown-type", data: []byte(`{"type":"hello"}`)},
		fuzzSeed{name: "type-number", data: []byte(`{"type":7}`)},
		fuzzSeed{name: "bom-prefix", data: append([]byte{0xef, 0xbb, 0xbf}, `{"type":"end"}`...)},
		fuzzSeed{name: "array", data: []byte(`[{"type":"end"}]`)},
		fuzzSeed{name: "null", data: []byte(`null`)},
		fuzzSeed{name: "duplicate-type-key", data: []byte(`{"type":"end","type":"hello"}`)},
		fuzzSeed{name: "file-bytes-14", data: []byte(`{"type":"end"}`)},
		fuzzSeed{name: "empty", data: []byte{}},
	)
	return seeds
}

// FuzzClassifyControl: classifyControl never panics, calls a frame control
// only for the five known types, never parses a frame past controlMsgMax,
// and agrees with an independent decode on every frame within the cap.
func FuzzClassifyControl(f *testing.F) {
	addSeeds(f, "FuzzClassifyControl", classifySeeds(), true)
	known := map[string]bool{}
	for _, typ := range controlTypes {
		known[typ] = true
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		msgType, isControl := classifyControl(data)
		if len(data) > controlMsgMax {
			if isControl {
				t.Fatalf("a %d-byte frame (over the %d cap) classified as control %q", len(data), controlMsgMax, msgType)
			}
			return
		}
		if isControl && !known[msgType] {
			t.Fatalf("classified as control with unknown type %q", msgType)
		}
		if !isControl && msgType != "" {
			t.Fatalf("not control, yet returned type %q", msgType)
		}
		// Independent decode: a JSON object whose "type" is one of the five
		// is control, and nothing else is.
		var obj map[string]interface{}
		want := ""
		if looksLikeJSONObject(data) && json.Unmarshal(data, &obj) == nil {
			if typ, _ := obj["type"].(string); known[typ] {
				want = typ
			}
		}
		if (want != "") != isControl || want != msgType {
			t.Fatalf("classifyControl(%q) = %q, %v; an independent decode says %q", data, msgType, isControl, want)
		}
	})
}

func safeJoinSeeds() []fuzzSeed {
	return []fuzzSeed{
		{name: "F2-path-40-levels", text: strings.Repeat("d/", 40) + "deep.txt"},
		{name: "F3-bidi-override-name", text: "photo" + ch(0x202e) + "gnp.exe"},
		{name: "F4a-traversal-dotdot", text: "../../escape.txt"},
		{name: "F4b-absolute-windows-path", text: `C:\Windows\System32\evil.dll`},
		{name: "dotdot", text: ".."},
		{name: "dot", text: "."},
		{name: "three-dots", text: "..."},
		{name: "empty", text: ""},
		{name: "dotdot-backslash", text: `..\..\x`},
		{name: "mixed-separators", text: `a/..\../b`},
		{name: "drive-letter", text: "C:"},
		{name: "drive-relative", text: `C:..\x`},
		{name: "unc", text: `\\server\share\x`},
		{name: "unc-forward", text: "//server/share/x"},
		{name: "device-namespace", text: `\\?\C:\x`},
		{name: "dos-device", text: `\\.\PhysicalDrive0`},
		{name: "rooted", text: "/etc/passwd"},
		{name: "nul-byte", text: "a" + ch(0) + "b.txt"},
		{name: "reserved-con", text: "CON"},
		{name: "reserved-nul-txt", text: "NUL.txt"},
		{name: "reserved-in-folder", text: "sub/aux"},
		{name: "trailing-space-dot", text: "evil.exe . "},
		{name: "only-spaces-dots", text: " . . "},
		{name: "component-255-bytes", text: strings.Repeat("c", 255)},
		{name: "ads-colon", text: "file.txt:stream"},
		{name: "c1-next-line", text: "a" + ch(0x85) + "b"},
	}
}

// FuzzSafeJoin: safeJoin never panics, the path it returns stays under the
// output directory, and no component of what it adds is empty, "." or "..".
func FuzzSafeJoin(f *testing.F) {
	addSeeds(f, "FuzzSafeJoin", safeJoinSeeds(), false)
	// Never created: safeJoin only builds a string.
	outputDir := filepath.Join(f.TempDir(), "out")
	f.Fuzz(func(t *testing.T, name string) {
		got := safeJoin(outputDir, name)
		rel, err := filepath.Rel(outputDir, got)
		if err != nil {
			t.Fatalf("safeJoin(%q) = %q, not relative to the output dir: %v", name, got, err)
		}
		if rel == "." || filepath.IsAbs(rel) || filepath.VolumeName(rel) != "" {
			t.Fatalf("safeJoin(%q) = %q, which is not strictly inside the output dir (rel %q)", name, got, rel)
		}
		for _, part := range strings.Split(rel, string(filepath.Separator)) {
			if part == "" || part == "." || part == ".." {
				t.Fatalf("safeJoin(%q) = %q has a %q component (rel %q)", name, got, part, rel)
			}
		}
	})
}

// refusalFrame builds an incompatible frame from raw JSON field text.
func refusalFrame(fields string) []byte {
	return []byte(`{"type":"incompatible",` + fields + `}`)
}

func abortSeeds() []fuzzSeed {
	hostile := strings.Repeat("a", 200) +
		ch(0x202e) + ch(0x2066) + ch(0x200f) + ch(0x061c) +
		ch(0) + ch(7) + ch(27) + "[2J" + ch(10) + ch(13) + ch(0x85) + ch(0x9b) +
		"$(calc)]]><" + strings.Repeat("z", 80)
	reason := `"reason":` + jsonString(hostile)
	return []fuzzSeed{
		{name: "code-write-failed", data: refusalFrame(`"reason":"receiver could not finish writing a file","pv":1,"pvMin":1,"code":"write-failed","saved":1`)},
		{name: "code-hash-mismatch", data: refusalFrame(`"reason":"a file did not match","pv":1,"pvMin":1,"code":"hash-mismatch","saved":0`)},
		{name: "code-unknown", data: refusalFrame(`"reason":"stopped","pv":1,"pvMin":1,"code":"too-slow","saved":3`)},
		{name: "code-number", data: refusalFrame(`"reason":"stopped","pv":1,"pvMin":1,"code":7`)},
		{name: "saved-minus-1", data: refusalFrame(`"reason":"stopped","pv":1,"pvMin":1,"code":"write-failed","saved":-1`)},
		{name: "saved-10000", data: refusalFrame(`"reason":"stopped","pv":1,"pvMin":1,"code":"write-failed","saved":10000`)},
		{name: "saved-1e300", data: refusalFrame(`"reason":"stopped","pv":1,"pvMin":1,"code":"write-failed","saved":1e300`)},
		{name: "saved-string", data: refusalFrame(`"reason":"stopped","pv":1,"pvMin":1,"code":"write-failed","saved":"3"`)},
		{name: "pv-overlapping-hostile-reason", data: refusalFrame(reason + `,"pv":1,"pvMin":1,"code":"write-failed","saved":2`)},
		{name: "pv-disjoint-hostile-ver", data: refusalFrame(`"reason":"x","pv":2,"pvMin":2,"ver":` + jsonString(hostile))},
		{name: "pv-legacy-absent", data: refusalFrame(reason)},
		{name: "pv-huge-negative", data: refusalFrame(`"reason":"x","pv":-9223372036854775808,"pvMin":9223372036854775807`)},
		{name: "reason-empty", data: refusalFrame(`"reason":"","pv":1,"pvMin":1`)},
		{name: "over-cap", data: refusalFrame(`"reason":"` + strings.Repeat("o", controlMsgMax) + `","pv":1,"pvMin":1,"code":"write-failed"`)},
		{name: "not-incompatible", data: []byte(`{"type":"ack","id":"x","offset":0}`)},
		{name: "not-json", data: []byte(`{"type":"incompatible"`)},
	}
}

// forbiddenRune reports whether r is a C0 or C1 control, DEL, or a Unicode
// bidi control. Written out here rather than borrowed from sanitizeRune, so
// the property does not grade the code with its own answer key.
func forbiddenRune(r rune) bool {
	switch {
	case r < 0x20, r >= 0x7f && r <= 0x9f:
		return true
	case r == 0x061c, r == 0x200e, r == 0x200f,
		r >= 0x202a && r <= 0x202e, r >= 0x2066 && r <= 0x2069:
		return true
	}
	return false
}

// FuzzAbortFromPeer: the Go sender's reader of a receiver's incompatible
// frame. Properties for the P0-17 slice (code and saved exist, nothing reads
// them yet): never panics; a frame over controlMsgMax returns nothing; the
// text it returns carries no control or bidi rune from the peer and stays
// within the 300-rune reason cap. The one control rune allowed is the line
// break in the LOCAL version-mismatch template (compatErrorMessage), which a
// peer cannot reach: displayText turns a peer's own line break into "_".
// The PeerStoppedError properties arrive with S1-ENG-01.
func FuzzAbortFromPeer(f *testing.F) {
	addSeeds(f, "FuzzAbortFromPeer", abortSeeds(), true)
	f.Fuzz(func(t *testing.T, raw []byte) {
		got := abortFromPeer(raw, "v1.10.10", "")
		if len(raw) > controlMsgMax && got != "" {
			t.Fatalf("a %d-byte frame (over the %d cap) returned %q", len(raw), controlMsgMax, got)
		}
		if !utf8.ValidString(got) {
			t.Fatalf("abortFromPeer(%q) returned invalid UTF-8 %q", raw, got)
		}
		if n := utf8.RuneCountInString(got); n > maxDisplayReason {
			t.Fatalf("abortFromPeer(%q) returned %d runes, over the %d cap", raw, n, maxDisplayReason)
		}
		for i, r := range got {
			if r == '\n' {
				continue
			}
			if forbiddenRune(r) {
				t.Fatalf("abortFromPeer(%q) returned %s at byte %d: %q", raw, fmt.Sprintf("U+%04X", r), i, got)
			}
		}
	})
}
