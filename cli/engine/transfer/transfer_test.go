package transfer

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"unicode/utf8"
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

// TestCheckCompat covers the full matrix of protocol version range comparisons.
func TestCheckCompat(t *testing.T) {
	cases := []struct {
		name                 string
		localMin, localMax   int
		remoteMin, remoteMax int
		wantOk               bool
		wantLocalTooOld      bool
	}{
		{"equal v1", 1, 1, 1, 1, true, false},
		{"legacy remote (zeros treated as v1)", 1, 1, 0, 0, true, false},
		{"overlap: local 1-2 remote 2-3", 1, 2, 2, 3, true, false},
		{"local too old: local 1-1 remote 2-2", 1, 1, 2, 2, false, true},
		{"remote too old: local 2-2 remote 1-1", 2, 2, 1, 1, false, false},
		{"no overlap: local 3-4 remote 1-2", 3, 4, 1, 2, false, false},
		{"wide local range", 1, 5, 3, 3, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ok, localTooOld := CheckCompat(tc.localMin, tc.localMax, tc.remoteMin, tc.remoteMax)
			if ok != tc.wantOk || localTooOld != tc.wantLocalTooOld {
				t.Errorf("CheckCompat(%d,%d,%d,%d) = (ok=%v,localTooOld=%v), want (ok=%v,localTooOld=%v)",
					tc.localMin, tc.localMax, tc.remoteMin, tc.remoteMax,
					ok, localTooOld, tc.wantOk, tc.wantLocalTooOld)
			}
		})
	}
}

// TestCompatErrorMessage verifies the user-facing error strings.
func TestCompatErrorMessage(t *testing.T) {
	// Local too old: should suggest running floe update locally
	msg := CompatErrorMessage(true, "v1.5.5", "v2.0.0", 1, 1, 2, 2)
	if !strings.Contains(msg, "floe update") {
		t.Errorf("local-too-old message should mention 'floe update', got: %s", msg)
	}
	if !strings.Contains(msg, "v1.5.5") || !strings.Contains(msg, "v2.0.0") {
		t.Errorf("message should contain both version strings, got: %s", msg)
	}

	// Remote too old: should ask the other side to update
	msg2 := CompatErrorMessage(false, "v2.0.0", "v1.5.5", 2, 2, 1, 1)
	if !strings.Contains(msg2, "other side") {
		t.Errorf("remote-too-old message should mention 'other side', got: %s", msg2)
	}

	// Empty ver strings omitted from ranges
	msg3 := CompatErrorMessage(true, "", "", 1, 1, 2, 2)
	if strings.Contains(msg3, "()") {
		t.Errorf("empty ver should not produce '()' in message, got: %s", msg3)
	}

	// GUI callers can replace the CLI-only local remedy.
	const appHint = "Update Floe from your app store or floe.one/download."
	msg4 := compatErrorMessage(true, "v1.5.5", "v2.0.0", 1, 1, 2, 2, appHint)
	if !strings.Contains(msg4, appHint) || strings.Contains(msg4, "floe update") {
		t.Errorf("custom local update hint not applied, got: %s", msg4)
	}

	// The local app cannot know which surface the peer uses, so the remote
	// remedy stays surface-neutral when a custom local hint is configured.
	msg5 := compatErrorMessage(false, "v2.0.0", "v1.5.5", 2, 2, 1, 1, appHint)
	if !strings.Contains(msg5, "Ask the other side to update Floe.") || strings.Contains(msg5, "app store") {
		t.Errorf("custom peer update hint should be surface-neutral, got: %s", msg5)
	}

	// A current receiver's reason is written from the receiver's perspective.
	// The sender must reconstruct it from its own protocol range and hint.
	msg6 := compatErrorFromIncompatible("v1.5.5", appHint, incompatibleMsg{
		Reason: "receiver-perspective message",
		Pv:     2,
		PvMin:  2,
		Ver:    "v2.0.0",
	})
	if !strings.Contains(msg6, appHint) || strings.Contains(msg6, "receiver-perspective") {
		t.Errorf("sender did not rebuild incompatibility message, got: %s", msg6)
	}

	// Legacy peers supplied only a prebuilt reason.
	const legacyReason = "legacy incompatibility reason"
	if got := compatErrorFromIncompatible("v1.5.5", appHint, incompatibleMsg{Reason: legacyReason}); got != legacyReason {
		t.Errorf("legacy reason = %q, want %q", got, legacyReason)
	}

	// When this receiver is newer, the sender-facing fallback must say that the
	// sender itself is old and must not leak this receiver's app-store hint.
	peerMsg := peerCompatErrorMessage(false, "v2.0.0", "v1.5.5", 2, 2, 1, 1)
	if !strings.Contains(peerMsg, "your floe is too old") ||
		!strings.Contains(peerMsg, "You: protocol 1 (v1.5.5)  Peer: protocol 2 (v2.0.0)") ||
		!strings.Contains(peerMsg, "Update Floe to continue.") {
		t.Errorf("newer receiver produced wrong sender-facing message: %s", peerMsg)
	}

	// When this receiver is older, the newer sender should be told neutrally
	// that the peer needs an update.
	peerMsg2 := peerCompatErrorMessage(true, "v1.5.5", "v2.0.0", 1, 1, 2, 2)
	if !strings.Contains(peerMsg2, "peer's floe is too old") ||
		!strings.Contains(peerMsg2, "You: protocol 2 (v2.0.0)  Peer: protocol 1 (v1.5.5)") ||
		!strings.Contains(peerMsg2, "Ask the other side to update Floe.") {
		t.Errorf("older receiver produced wrong sender-facing message: %s", peerMsg2)
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

// TestReportBytesToServer verifies the stats report is posted correctly and
// that passing an empty serverURL skips the request entirely (the opt-out path).
func TestReportBytesToServer(t *testing.T) {
	t.Run("posts byte count when URL is set", func(t *testing.T) {
		var got int64
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api/stats/report" || r.Method != http.MethodPost {
				t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
				w.WriteHeader(http.StatusNotFound)
				return
			}
			body, _ := io.ReadAll(r.Body)
			var payload map[string]int64
			if err := json.Unmarshal(body, &payload); err != nil {
				t.Errorf("body is not valid JSON: %v", err)
			}
			got = payload["bytes"]
			w.WriteHeader(http.StatusOK)
		}))
		defer srv.Close()

		reportBytesToServer(srv.URL, 12345)

		if got != 12345 {
			t.Errorf("reported bytes = %d, want 12345", got)
		}
	})

	t.Run("skips request when URL is empty (opt-out)", func(t *testing.T) {
		called := false
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			called = true
			w.WriteHeader(http.StatusOK)
		}))
		defer srv.Close()

		// Empty URL is the opt-out signal; the real server URL is irrelevant.
		reportBytesToServer("", 99999)

		if called {
			t.Error("reportBytesToServer should not make any request when serverURL is empty")
		}
	})
}

// TestCreateUnique verifies the receiver never overwrites: repeated creates of
// the same name de-collide as "name (1).ext", "name (2).ext", and a name with
// no extension gets the suffix appended at the end.
// TestClaimPart pins the de-collision sequence across repeated claims. Each
// claim leaves its .part in place, which is what blocks the candidate for the
// next claim (the final names do not exist yet), so the pinned sequence proves
// a live .part reserves its final name.
func TestClaimPart(t *testing.T) {
	dir := t.TempDir()

	base := filepath.Join(dir, "shot.png")
	for _, want := range []string{"shot.png", "shot (1).png", "shot (2).png"} {
		f, dest, err := claimPart(base)
		if err != nil {
			t.Fatalf("claimPart(%q): %v", base, err)
		}
		if got := filepath.Base(dest); got != want {
			t.Errorf("claimPart dest = %q, want %q", got, want)
		}
		if f.Name() != dest+partSuffix {
			t.Errorf("staging file = %q, want %q", f.Name(), dest+partSuffix)
		}
		f.Close()
	}

	// No extension: the suffix goes at the end.
	noExt := filepath.Join(dir, "NOTES")
	f1, _, err := claimPart(noExt)
	if err != nil {
		t.Fatal(err)
	}
	f1.Close()
	f2, dest2, err := claimPart(noExt)
	if err != nil {
		t.Fatal(err)
	}
	defer f2.Close()
	if got := filepath.Base(dest2); got != "NOTES (1)" {
		t.Errorf("no-ext de-collision = %q, want %q", got, "NOTES (1)")
	}

	// A completed file (final name on disk, no .part) blocks its candidate
	// the same way a live claim does.
	done := filepath.Join(dir, "done.txt")
	if err := os.WriteFile(done, []byte("x"), 0666); err != nil {
		t.Fatal(err)
	}
	f3, dest3, err := claimPart(done)
	if err != nil {
		t.Fatal(err)
	}
	defer f3.Close()
	if got := filepath.Base(dest3); got != "done (1).txt" {
		t.Errorf("existing-file de-collision = %q, want %q", got, "done (1).txt")
	}
}

// TestCommitPart pins the publish step: the verified bytes land at the claimed
// name with no .part left behind, and a name taken between claim and commit
// advances through the BASE candidate sequence (never "shot (1) (1).png"),
// without ever overwriting the intruder.
func TestCommitPart(t *testing.T) {
	dir := t.TempDir()

	// Plain path: claim, write, commit.
	base := filepath.Join(dir, "doc.pdf")
	f, dest, err := claimPart(base)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte("payload")); err != nil {
		t.Fatal(err)
	}
	f.Close()
	final, err := commitPart(f.Name(), dest, base)
	if err != nil {
		t.Fatalf("commitPart: %v", err)
	}
	if final != dest {
		t.Errorf("commit landed at %q, want the claimed %q", final, dest)
	}
	if b, err := os.ReadFile(final); err != nil || string(b) != "payload" {
		t.Fatalf("final content = %q, %v", b, err)
	}
	if _, err := os.Lstat(f.Name()); !os.IsNotExist(err) {
		t.Errorf("staging file %q survived the commit", f.Name())
	}

	// Interference path: something claims the final name mid-transfer. The
	// intruder must survive byte-identical and the payload must land at the
	// next BASE candidate.
	base2 := filepath.Join(dir, "clash.bin")
	f2, dest2, err := claimPart(base2)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f2.Write([]byte("mine")); err != nil {
		t.Fatal(err)
	}
	f2.Close()
	if err := os.WriteFile(dest2, []byte("INTRUDER"), 0666); err != nil {
		t.Fatal(err)
	}
	final2, err := commitPart(f2.Name(), dest2, base2)
	if err != nil {
		t.Fatalf("commitPart with occupied dest: %v", err)
	}
	if got := filepath.Base(final2); got != "clash (1).bin" {
		t.Errorf("re-collision landed at %q, want %q", got, "clash (1).bin")
	}
	if b, _ := os.ReadFile(dest2); string(b) != "INTRUDER" {
		t.Errorf("intruder was overwritten: %q", b)
	}
	if b, _ := os.ReadFile(final2); string(b) != "mine" {
		t.Errorf("payload content = %q, want %q", b, "mine")
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

// TestCompatErrorMessageSanitizesPeerStrings: the peer's version string and
// its legacy reason are printed by the CLI and shown on the desktop status
// line, so they arrive there cleaned and capped no matter which path built
// the message.
func TestCompatErrorMessageSanitizesPeerStrings(t *testing.T) {
	msg := CompatErrorMessage(false, "v1", "v2\x1b[2K\u202e", 1, 1, 2, 2)
	if !strings.Contains(msg, "v2_[2K_") || strings.Contains(msg, "\x1b") {
		t.Errorf("remote version not cleaned: %q", msg)
	}
	msg = compatErrorMessage(true, "v1", "v2\x1b[2K\u202e", 1, 1, 2, 2, "hint")
	if !strings.Contains(msg, "v2_[2K_") || strings.Contains(msg, "\x1b") {
		t.Errorf("remote version not cleaned on the GUI path: %q", msg)
	}

	// A legacy peer's reason is the only prose the sender prints verbatim.
	legacy := compatErrorFromIncompatible("v1", "", incompatibleMsg{Reason: strings.Repeat("evil\n", 1000)})
	if n := utf8.RuneCountInString(legacy); n > 300 {
		t.Errorf("legacy reason is %d runes, want at most 300", n)
	}
	if strings.Contains(legacy, "\n") {
		t.Errorf("a newline survived in the legacy reason: %q", legacy)
	}

	// A current peer's ver is capped before it is embedded in the rebuilt message.
	rebuilt := compatErrorFromIncompatible("v1", "", incompatibleMsg{Ver: strings.Repeat("v", 10*1024), Pv: 2, PvMin: 2})
	if n := utf8.RuneCountInString(rebuilt); n >= 500 {
		t.Errorf("rebuilt message is %d runes for a 10 KB ver, want under 500", n)
	}
}
