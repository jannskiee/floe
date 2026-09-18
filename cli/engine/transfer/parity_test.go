package transfer

// Decoder parity with the browser (DV-FUZZ B0-b). The Go half of a literal
// table of frames, each with the decision this engine makes and the decision
// the browser makes. Twin: client/lib/transfer/parity.test.ts carries the same
// table byte for byte, and each suite fails when the other file's copy
// drifts, the way TestProtocolVersionPinnedToClient ties the protocol
// constants to protocol.ts. A row whose two decisions differ must name a
// finding (recorded in work/14-test-evidence/DV-FUZZ/B0-b, not fixed here).

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// PARITY-TABLE-BEGIN (twin: client/lib/transfer/parity.test.ts, PARITY_TABLE)
const parityTable = `
{"decoder":"refusalCodeOf","name":"write-failed","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"write-failed\"}","go":"accept","ts":"accept"}
{"decoder":"refusalCodeOf","name":"hash-mismatch","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"hash-mismatch\"}","go":"accept","ts":"accept"}
{"decoder":"refusalCodeOf","name":"declined","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"declined\"}","go":"accept","ts":"accept"}
{"decoder":"refusalCodeOf","name":"disk-full","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"disk-full\"}","go":"accept","ts":"accept"}
{"decoder":"refusalCodeOf","name":"expired","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"expired\"}","go":"accept","ts":"accept"}
{"decoder":"refusalCodeOf","name":"file-too-large-for-folder","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"file-too-large-for-folder\"}","go":"accept","ts":"accept"}
{"decoder":"refusalCodeOf","name":"over-approved","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"over-approved\"}","go":"accept","ts":"accept"}
{"decoder":"refusalCodeOf","name":"path-too-long","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"path-too-long\"}","go":"accept","ts":"accept"}
{"decoder":"refusalCodeOf","name":"relay-cap","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"relay-cap\"}","go":"accept","ts":"accept"}
{"decoder":"refusalCodeOf","name":"save-blocked","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"save-blocked\"}","go":"accept","ts":"accept"}
{"decoder":"refusalCodeOf","name":"stopped","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"stopped\"}","go":"accept","ts":"accept"}
{"decoder":"refusalCodeOf","name":"time-limit","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"time-limit\"}","go":"accept","ts":"accept"}
{"decoder":"refusalCodeOf","name":"too-slow-cut","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"too-slow\"}","go":"reject","ts":"reject"}
{"decoder":"refusalCodeOf","name":"upper-case","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"WRITE-FAILED\"}","go":"reject","ts":"reject"}
{"decoder":"refusalCodeOf","name":"empty","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"\"}","go":"reject","ts":"reject"}
{"decoder":"refusalCodeOf","name":"number","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":7}","go":"reject","ts":"reject"}
{"decoder":"refusalCodeOf","name":"null","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":null}","go":"reject","ts":"reject"}
{"decoder":"refusalCodeOf","name":"array","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":[\"write-failed\"]}","go":"reject","ts":"reject"}
{"decoder":"refusalCodeOf","name":"object","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":{\"code\":\"write-failed\"}}","go":"reject","ts":"reject"}
{"decoder":"refusalCodeOf","name":"proto","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"__proto__\"}","go":"reject","ts":"reject"}
{"decoder":"refusalCodeOf","name":"constructor","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"constructor\"}","go":"reject","ts":"reject"}
{"decoder":"refusalCodeOf","name":"absent","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1}","go":"reject","ts":"reject"}
{"decoder":"refusalCodeOf","name":"saved-string","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"write-failed\",\"saved\":\"3\"}","go":"accept","ts":"accept"}
{"decoder":"refusalCodeOf","name":"saved-1e300","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"write-failed\",\"saved\":1e300}","go":"accept","ts":"accept"}
{"decoder":"refusalCodeOf","name":"type-key-case","frame":"{\"TYPE\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"write-failed\"}","go":"reject","ts":"reject"}
{"decoder":"refusalCodeOf","name":"code-key-case","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"CODE\":\"write-failed\"}","go":"reject","ts":"reject"}
{"decoder":"refusalCodeOf","name":"pv-string-with-code","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":\"1\",\"pvMin\":1,\"code\":\"write-failed\"}","go":"accept","ts":"accept"}
{"decoder":"refusalCodeOf","name":"duplicate-code-bad-then-good","frame":"{\"type\":\"incompatible\",\"reason\":\"x\",\"pv\":1,\"pvMin\":1,\"code\":\"nope\",\"code\":\"write-failed\"}","go":"accept","ts":"accept"}
{"decoder":"classifyControl","name":"metadata","frame":"{\"type\":\"metadata\"}","go":"metadata","ts":"metadata"}
{"decoder":"classifyControl","name":"end","frame":"{\"type\":\"end\"}","go":"end","ts":"end"}
{"decoder":"classifyControl","name":"ack","frame":"{\"type\":\"ack\"}","go":"ack","ts":"ack"}
{"decoder":"classifyControl","name":"received","frame":"{\"type\":\"received\"}","go":"received","ts":"received"}
{"decoder":"classifyControl","name":"incompatible","frame":"{\"type\":\"incompatible\"}","go":"incompatible","ts":"incompatible"}
{"decoder":"classifyControl","name":"unknown-type","frame":"{\"type\":\"hello\"}","go":"none","ts":"none"}
{"decoder":"classifyControl","name":"type-number","frame":"{\"type\":7}","go":"none","ts":"none"}
{"decoder":"classifyControl","name":"type-key-case","frame":"{\"TYPE\":\"ack\"}","go":"none","ts":"none"}
{"decoder":"classifyControl","name":"leading-space","frame":" {\"type\":\"end\"}","go":"end","ts":"end"}
{"decoder":"classifyControl","name":"leading-newline","frame":"\n{\"type\":\"end\"}","go":"end","ts":"end"}
{"decoder":"classifyControl","name":"number-overflow","frame":"{\"type\":\"end\",\"x\":1e999}","go":"end","ts":"end"}
{"decoder":"classifyControl","name":"array","frame":"[{\"type\":\"end\"}]","go":"none","ts":"none"}
{"decoder":"classifyControl","name":"json-null","frame":"null","go":"none","ts":"none"}
{"decoder":"classifyControl","name":"trailing-garbage","frame":"{\"type\":\"end\"}x","go":"none","ts":"none"}
{"decoder":"classifyControl","name":"duplicate-type","frame":"{\"type\":\"end\",\"type\":\"hello\"}","go":"none","ts":"none"}
{"decoder":"classifyControl","name":"cap-exact","frame":"{\"type\":\"end\",\"pad\":\"\"}","padTo":1000,"padChar":"x","go":"end","ts":"end"}
{"decoder":"classifyControl","name":"cap-plus-1","frame":"{\"type\":\"end\",\"pad\":\"\"}","padTo":1001,"padChar":"x","go":"none","ts":"none"}
{"decoder":"classifyControl","name":"cap-plus-1-two-byte","frame":"{\"type\":\"end\",\"pad\":\"\"}","padTo":1001,"padChar":"\u00e9","go":"none","ts":"none"}
{"decoder":"metadataGuard","name":"valid","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":4,\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":1,\"pvMin\":1}","go":"accept","ts":"accept"}
{"decoder":"metadataGuard","name":"F1-fileSize-2pow53","frame":"{\"type\":\"metadata\",\"id\":\"f-1\",\"fileName\":\"big.bin\",\"fileSize\":9007199254740992,\"index\":1,\"total\":1,\"totalBytes\":9007199254740992,\"pv\":1,\"pvMin\":1}","go":"reject","ts":"reject"}
{"decoder":"metadataGuard","name":"F5-fileSize-2pow53-minus-1","frame":"{\"type\":\"metadata\",\"id\":\"f-5\",\"fileName\":\"big.bin\",\"fileSize\":9007199254740991,\"index\":1,\"total\":1,\"totalBytes\":9007199254740991,\"pv\":1,\"pvMin\":1}","go":"accept","ts":"accept"}
{"decoder":"metadataGuard","name":"fileSize-minus-1","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":-1,\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":1,\"pvMin\":1}","go":"reject","ts":"reject"}
{"decoder":"metadataGuard","name":"fileSize-fraction","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":1.5,\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":1,\"pvMin\":1}","go":"reject","ts":"reject"}
{"decoder":"metadataGuard","name":"fileSize-string","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":\"4\",\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":1,\"pvMin\":1}","go":"reject","ts":"reject"}
{"decoder":"metadataGuard","name":"fileSize-1e300","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":1e300,\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":1,\"pvMin\":1}","go":"reject","ts":"reject"}
{"decoder":"metadataGuard","name":"index-0","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":4,\"index\":0,\"total\":1,\"totalBytes\":4,\"pv\":1,\"pvMin\":1}","go":"reject","ts":"reject"}
{"decoder":"metadataGuard","name":"total-0","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":4,\"index\":1,\"total\":0,\"totalBytes\":4,\"pv\":1,\"pvMin\":1}","go":"reject","ts":"reject"}
{"decoder":"metadataGuard","name":"totalBytes-below-fileSize","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":4,\"index\":1,\"total\":1,\"totalBytes\":2,\"pv\":1,\"pvMin\":1}","go":"reject","ts":"reject"}
{"decoder":"metadataGuard","name":"totalBytes-absent","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":4,\"index\":1,\"total\":1,\"pv\":1,\"pvMin\":1}","go":"accept","ts":"accept"}
{"decoder":"metadataGuard","name":"pv-disjoint","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":4,\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":2,\"pvMin\":2}","go":"reject","ts":"reject"}
{"decoder":"metadataGuard","name":"pv-absent-legacy","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":4,\"index\":1,\"total\":1,\"totalBytes\":4}","go":"accept","ts":"accept"}
{"decoder":"metadataGuard","name":"pv-string","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":4,\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":\"1\",\"pvMin\":1}","go":"reject","ts":"reject"}
{"decoder":"metadataGuard","name":"name-number","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":7,\"fileSize\":4,\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":1,\"pvMin\":1}","go":"reject","ts":"reject"}
{"decoder":"metadataGuard","name":"F4a-traversal-dotdot","frame":"{\"type\":\"metadata\",\"id\":\"f-4a\",\"fileName\":\"../../escape.txt\",\"fileSize\":4,\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":1,\"pvMin\":1}","go":"accept","ts":"accept"}
{"decoder":"metadataGuard","name":"F3-bidi-override-name","frame":"{\"type\":\"metadata\",\"id\":\"f-3\",\"fileName\":\"photo\u202egnp.exe\",\"fileSize\":4,\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":1,\"pvMin\":1}","go":"accept","ts":"accept"}
{"decoder":"metadataGuard","name":"leading-space","frame":" {\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":4,\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":1,\"pvMin\":1}","go":"accept","ts":"accept"}
{"decoder":"metadataGuard","name":"over-cap","frame":"{\"type\":\"metadata\",\"id\":\"a\",\"fileName\":\"a.bin\",\"fileSize\":4,\"index\":1,\"total\":1,\"totalBytes\":4,\"pv\":1,\"pvMin\":1,\"pad\":\"\"}","padTo":1001,"padChar":"x","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"valid","frame":"{\"type\":\"end\",\"sha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"}","go":"accept","ts":"accept"}
{"decoder":"endSha256","name":"absent","frame":"{\"type\":\"end\"}","go":"absent","ts":"absent"}
{"decoder":"endSha256","name":"uppercase","frame":"{\"type\":\"end\",\"sha256\":\"0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF\"}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"63-chars","frame":"{\"type\":\"end\",\"sha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\"}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"65-chars","frame":"{\"type\":\"end\",\"sha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0\"}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"non-hex","frame":"{\"type\":\"end\",\"sha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg\"}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"empty","frame":"{\"type\":\"end\",\"sha256\":\"\"}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"padded","frame":"{\"type\":\"end\",\"sha256\":\" 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"number","frame":"{\"type\":\"end\",\"sha256\":3}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"null","frame":"{\"type\":\"end\",\"sha256\":null}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"true","frame":"{\"type\":\"end\",\"sha256\":true}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"object","frame":"{\"type\":\"end\",\"sha256\":{}}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"array","frame":"{\"type\":\"end\",\"sha256\":[\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"]}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"escaped-valid","frame":"{\"type\":\"end\",\"sha256\":\"\\u0030123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"}","go":"accept","ts":"accept"}
{"decoder":"endSha256","name":"duplicate-good-then-bad","frame":"{\"type\":\"end\",\"sha256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\",\"sha256\":\"x\"}","go":"reject","ts":"reject"}
{"decoder":"endSha256","name":"key-case","frame":"{\"type\":\"end\",\"SHA256\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"zero","frame":"{\"type\":\"received\",\"verified\":0}","go":"0","ts":"0"}
{"decoder":"receivedVerified","name":"equal","frame":"{\"type\":\"received\",\"verified\":3}","go":"3","ts":"3"}
{"decoder":"receivedVerified","name":"absent","frame":"{\"type\":\"received\"}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"above","frame":"{\"type\":\"received\",\"verified\":4}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"negative","frame":"{\"type\":\"received\",\"verified\":-1}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"minus-zero","frame":"{\"type\":\"received\",\"verified\":-0}","go":"0","ts":"0"}
{"decoder":"receivedVerified","name":"integer-fraction","frame":"{\"type\":\"received\",\"verified\":3.0}","go":"3","ts":"3"}
{"decoder":"receivedVerified","name":"exponent-one","frame":"{\"type\":\"received\",\"verified\":1e0}","go":"1","ts":"1"}
{"decoder":"receivedVerified","name":"exponent-above","frame":"{\"type\":\"received\",\"verified\":1e2}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"fraction","frame":"{\"type\":\"received\",\"verified\":2.5}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"string","frame":"{\"type\":\"received\",\"verified\":\"3\"}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"null","frame":"{\"type\":\"received\",\"verified\":null}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"true","frame":"{\"type\":\"received\",\"verified\":true}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"array","frame":"{\"type\":\"received\",\"verified\":[3]}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"object","frame":"{\"type\":\"received\",\"verified\":{}}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"2pow53-minus-1","frame":"{\"type\":\"received\",\"verified\":9007199254740991}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"2pow53","frame":"{\"type\":\"received\",\"verified\":9007199254740992}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"overflow","frame":"{\"type\":\"received\",\"verified\":1e999}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"duplicate-3-then-string","frame":"{\"type\":\"received\",\"verified\":3,\"verified\":\"x\"}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"duplicate-string-then-2","frame":"{\"type\":\"received\",\"verified\":\"x\",\"verified\":2}","go":"2","ts":"2"}
{"decoder":"receivedVerified","name":"key-case","frame":"{\"type\":\"received\",\"Verified\":3}","go":"absent","ts":"absent"}
{"decoder":"receivedVerified","name":"type-key-case","frame":"{\"TYPE\":\"received\",\"verified\":3}","go":"none","ts":"none"}
{"decoder":"receivedVerified","name":"not-received","frame":"{\"type\":\"ack\",\"verified\":3}","go":"none","ts":"none"}
`

// PARITY-TABLE-END

type parityRow struct {
	Decoder string `json:"decoder"`
	Name    string `json:"name"`
	Frame   string `json:"frame"`
	PadTo   int    `json:"padTo"`
	PadChar string `json:"padChar"`
	Go      string `json:"go"`
	TS      string `json:"ts"`
	Finding string `json:"finding"`
}

// parityLines returns the table's lines exactly as written between the
// markers of a source file.
func parityLines(source string) []string {
	var out []string
	inside := false
	for _, line := range strings.Split(source, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "// PARITY-TABLE-BEGIN"):
			inside = true
		case strings.HasPrefix(line, "// PARITY-TABLE-END"):
			inside = false
		case inside && strings.HasPrefix(line, "{"):
			out = append(out, line)
		}
	}
	return out
}

// paddedFrame grows a frame that ends in an empty "pad" string to exactly
// PadTo bytes with PadChar.
func paddedFrame(t *testing.T, row parityRow) string {
	t.Helper()
	if row.PadTo == 0 || row.PadChar == "" {
		return row.Frame
	}
	missing := row.PadTo - len(row.Frame)
	if missing < 0 || missing%len(row.PadChar) != 0 {
		t.Fatalf("row %s cannot be padded to %d bytes", row.Name, row.PadTo)
	}
	return row.Frame[:len(row.Frame)-2] + strings.Repeat(row.PadChar, missing/len(row.PadChar)) + row.Frame[len(row.Frame)-2:]
}

// goMetadataDecision models the receive loop's order for a first string
// frame (receiver.go): over the control cap is rejected, a frame that is not
// control or not metadata is ignored (an incompatible ends the receive, which
// counts as a rejection), a parseMetadata error is rejected, a protocol range
// that misses ours is rejected, and anything else is acked. A model of the
// loop's order built from the loop's own functions, because a data channel
// per literal would make this a network test.
func goMetadataDecision(frame string) string {
	if len(frame) > controlMsgMax {
		return "reject"
	}
	msgType, isControl := classifyControl([]byte(frame))
	switch {
	case !isControl:
		return "ignore"
	case msgType == "incompatible":
		return "reject"
	case msgType != "metadata":
		return "ignore"
	}
	info, err := parseMetadata(frame)
	if err != nil {
		return "reject"
	}
	if ok, _ := CheckCompat(MinProtocolVersion, ProtocolVersion, info.PvMin, info.Pv); !ok {
		return "reject"
	}
	return "accept"
}

// goEndSha256Decision is parseEnd in the table's vocabulary: accept a readable
// digest, reject an unreadable one, absent when there is none. The browser twin
// reads the parsed field, not the frame, so FND-1 and FND-2 do not leak in.
func goEndSha256Decision(frame []byte) string {
	sha, err := parseEnd(frame)
	switch {
	case err != nil:
		return "reject"
	case sha == "":
		return "absent"
	}
	return "accept"
}

// goReceivedVerifiedDecision is parseReceived for a three-file batch: none when
// the frame is not a received, absent when its count is unusable, else the count.
func goReceivedVerifiedDecision(frame []byte) string {
	ok, verified, has := parseReceived(frame, 3)
	switch {
	case !ok:
		return "none"
	case !has:
		return "absent"
	}
	return strconv.Itoa(verified)
}

func loadParityRows(t *testing.T) []parityRow {
	t.Helper()
	var rows []parityRow
	for _, line := range parityLines(parityTableSource(t)) {
		var row parityRow
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			t.Fatalf("parity line does not parse: %v: %s", err, line)
		}
		rows = append(rows, row)
	}
	if len(rows) < 40 {
		t.Fatalf("parity table has %d rows, want at least 40", len(rows))
	}
	return rows
}

// parityTableSource is this file's text, read back so the rows are parsed
// from the same lines the twin comparison reads.
func parityTableSource(t *testing.T) string {
	t.Helper()
	return "// PARITY-TABLE-BEGIN\n" + parityTable + "\n// PARITY-TABLE-END\n"
}

// TestDecoderParityGoDecisions: the engine decides every row as the table's
// go column says, and a row may differ from the browser only with a finding.
func TestDecoderParityGoDecisions(t *testing.T) {
	for _, row := range loadParityRows(t) {
		frame := paddedFrame(t, row)
		var got string
		switch row.Decoder {
		case "refusalCodeOf":
			got = goRefusalDecision([]byte(frame))
		case "classifyControl":
			if msgType, ok := classifyControl([]byte(frame)); ok {
				got = msgType
			} else {
				got = "none"
			}
		case "metadataGuard":
			got = goMetadataDecision(frame)
		case "endSha256":
			got = goEndSha256Decision([]byte(frame))
		case "receivedVerified":
			got = goReceivedVerifiedDecision([]byte(frame))
		default:
			t.Fatalf("row %s names an unknown decoder %q", row.Name, row.Decoder)
		}
		if got != row.Go {
			t.Errorf("row %s/%s: Go decides %q, the table says %q", row.Decoder, row.Name, got, row.Go)
		}
		if (row.Go != row.TS) != (row.Finding != "") {
			t.Errorf("row %s/%s: go %q, ts %q, finding %q: a difference needs a finding and a finding needs a difference",
				row.Decoder, row.Name, row.Go, row.TS, row.Finding)
		}
	}
}

// TestDecoderParityTableMatchesTS: the browser twin pins the same lines.
func TestDecoderParityTableMatchesTS(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "..", "client", "lib", "transfer", "parity.test.ts"))
	if err != nil {
		t.Fatalf("read the browser twin: %v", err)
	}
	ours := parityLines(parityTableSource(t))
	theirs := parityLines(string(src))
	if len(ours) != len(theirs) {
		t.Fatalf("Go table has %d lines, client/lib/transfer/parity.test.ts has %d", len(ours), len(theirs))
	}
	for i := range ours {
		if ours[i] != theirs[i] {
			t.Errorf("line %d differs:\n  go: %s\n  ts: %s", i+1, ours[i], theirs[i])
		}
	}
}
