package transfer

// The refusal vocabulary: the closed code list, its parser, the wire reasons
// and the fixed sentences a sender prints for each code.

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"testing"
	"unicode"
	"unicode/utf8"
)

// TestIsDiskFull: the classifier finds the OS's own "no room" inside the
// wrapped errors the receive loop hands it, and nothing else reads as full.
func TestIsDiskFull(t *testing.T) {
	full := []error{
		syscall.ENOSPC,
		&os.PathError{Op: "write", Path: "x.part", Err: syscall.ENOSPC},
		fmt.Errorf("cannot create directory: %w", &os.PathError{Op: "mkdir", Path: "d", Err: syscall.ENOSPC}),
	}
	notFull := []error{
		nil,
		errors.New("simulated I/O failure"),
		&os.PathError{Op: "write", Path: "x.part", Err: syscall.EACCES},
		&os.PathError{Op: "open", Path: "x.part", Err: syscall.ENAMETOOLONG},
	}
	if runtime.GOOS == "windows" {
		full = append(full, &os.PathError{Op: "write", Path: "x.part", Err: syscall.Errno(112)}, &os.PathError{Op: "write", Path: "x.part", Err: syscall.Errno(39)})
	} else {
		notFull = append(notFull, &os.PathError{Op: "write", Path: "x.part", Err: syscall.Errno(112)})
	}
	for _, err := range full {
		if !isDiskFull(err) {
			t.Errorf("isDiskFull(%v) = false, want true", err)
		}
	}
	for _, err := range notFull {
		if isDiskFull(err) {
			t.Errorf("isDiskFull(%v) = true, want false", err)
		}
	}
}

// TestRefusalCodesRoundTrip: every constant parses back to itself, and the
// near misses a case-folding or trimming decoder would accept all fail, as
// they do in the browser's REFUSAL_CODES.has.
func TestRefusalCodesRoundTrip(t *testing.T) {
	if len(RefusalCodes) != 12 {
		t.Fatalf("RefusalCodes has %d entries, want 12", len(RefusalCodes))
	}
	seen := map[RefusalCode]bool{}
	for _, c := range RefusalCodes {
		if seen[c] {
			t.Errorf("%q appears twice", c)
		}
		seen[c] = true
		got, ok := ParseRefusalCode(string(c))
		if !ok || got != c {
			t.Errorf("ParseRefusalCode(%q) = (%q, %v), want (%q, true)", c, got, ok, c)
		}
	}
	for _, s := range []string{
		"", "WRITE-FAILED", "Write-Failed", "write-failed ", " write-failed", "write_failed",
		"too-slow", "__proto__", "constructor", "declined\x00", "hash-mismatch\n", "disk-full\u202e",
	} {
		if got, ok := ParseRefusalCode(s); ok {
			t.Errorf("ParseRefusalCode(%q) = (%q, true), want a miss", s, got)
		}
	}
}

// TestRefusalCodeListMatchesTS pins the literal list, in order, that
// client/lib/transfer/protocol.test.ts pins for REFUSAL_CODES ("REFUSAL_CODES
// pins the twelve codes in the same order as refusal.go"). The order is the
// byte order of the wire values, so the two lists can be compared whole.
func TestRefusalCodeListMatchesTS(t *testing.T) {
	want := []string{
		"declined",
		"disk-full",
		"expired",
		"file-too-large-for-folder",
		"hash-mismatch",
		"over-approved",
		"path-too-long",
		"relay-cap",
		"save-blocked",
		"stopped",
		"time-limit",
		"write-failed",
	}
	got := make([]string, 0, len(RefusalCodes))
	for _, c := range RefusalCodes {
		got = append(got, string(c))
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("RefusalCodes = %v, want %v (the literal REFUSAL_CODES pins)", got, want)
	}
	if !sort.StringsAreSorted(got) {
		t.Fatalf("RefusalCodes is not in byte order: %v", got)
	}
}

// TestRefusalWireReasons: the stock reason for every code is something a peer
// without code can print verbatim: non-empty, plain ASCII, short, receiver-
// voiced, and naming no path, no file and no surface. The two that shipped
// before the list existed are pinned byte for byte, because tests on both
// sides and the transfer audit match them.
func TestRefusalWireReasons(t *testing.T) {
	surfaces := []string{"cli", "desktop", "browser", "terminal", "app", "web", "floe"}
	for _, c := range RefusalCodes {
		r := c.WireReason()
		if r == "" {
			t.Errorf("%s: empty wire reason", c)
			continue
		}
		if n := utf8.RuneCountInString(r); n >= 120 {
			t.Errorf("%s: wire reason is %d runes, want under 120", c, n)
		}
		for _, ch := range r {
			if ch > unicode.MaxASCII || !unicode.IsPrint(ch) {
				t.Errorf("%s: wire reason has a non-ASCII or non-printable rune %U", c, ch)
			}
		}
		if !strings.HasPrefix(r, "receiver") {
			t.Errorf("%s: wire reason %q is not receiver-voiced", c, r)
		}
		if strings.ContainsAny(r, `/\:%`) {
			t.Errorf("%s: wire reason %q looks like it names a path or a verb", c, r)
		}
		lower := strings.ToLower(r)
		for _, s := range surfaces {
			for _, w := range strings.Fields(lower) {
				if strings.Trim(w, ".,'") == s {
					t.Errorf("%s: wire reason %q names a surface (%q)", c, r, s)
				}
			}
		}
	}
	if got := CodeWriteFailed.WireReason(); got != "receiver could not finish writing a file" {
		t.Errorf("write-failed wire reason = %q", got)
	}
	if got := CodeHashMismatch.WireReason(); got != "receiver discarded a file because its SHA-256 did not match" {
		t.Errorf("hash-mismatch wire reason = %q", got)
	}
	if got := RefusalCode("nope").WireReason(); got != CodeStopped.WireReason() {
		t.Errorf("unknown code wire reason = %q, want the stopped sentence", got)
	}
}

// TestPeerStoppedErrorSentencesAreFixed: one approved sentence per code, no
// count, no peer text, and a code the switch does not know prints a fixed
// fallback rather than its value.
func TestPeerStoppedErrorSentencesAreFixed(t *testing.T) {
	want := map[RefusalCode]string{
		CodeDeclined:              "They declined. Nothing was sent.",
		CodeDiskFull:              "Their computer ran out of space.",
		CodeExpired:               "They did not answer in time. Nothing was sent.",
		CodeFileTooLargeForFolder: "A file is too large for the drive they save to.",
		CodeHashMismatch:          "A file changed or was damaged on the way, so their Floe deleted it.",
		CodeOverApproved:          "More data arrived than they accepted. If files changed after you chose them, ask them for a new link.",
		CodePathTooLong:           "A folder path is too long for their computer. Zip deeply nested folders first.",
		CodeRelayCap:              "Relayed drops are capped at 2 GB.",
		CodeSaveBlocked:           "A file arrived but their computer blocked saving it.",
		CodeStopped:               "They stopped this drop.",
		CodeTimeLimit:             "This drop reached the 24-hour limit, so their Floe stopped it.",
		CodeWriteFailed:           "Their computer could not save a file.",
	}
	if len(want) != len(RefusalCodes) {
		t.Fatalf("the sentence table has %d rows for %d codes", len(want), len(RefusalCodes))
	}
	for _, c := range RefusalCodes {
		for _, saved := range []int{0, 4, 12} {
			err := &PeerStoppedError{Code: c, Saved: saved}
			if got := err.Error(); got != want[c] {
				t.Errorf("%s (saved %d): Error() = %q, want %q", c, saved, got, want[c])
			}
		}
		if strings.Contains(want[c], "%") {
			t.Errorf("%s: sentence %q has a format verb", c, want[c])
		}
	}
	hostile := &PeerStoppedError{Code: RefusalCode("\x1b[2K\u202e$(calc)"), Saved: 1}
	if got := hostile.Error(); got != "The drop stopped on their computer." {
		t.Errorf("unknown code Error() = %q, want the fixed fallback", got)
	}
	var stopped *PeerStoppedError
	if !errors.As(error(&PeerStoppedError{Code: CodeStopped}), &stopped) || stopped.Code != CodeStopped {
		t.Error("errors.As does not find a PeerStoppedError")
	}
}

// TestRefusedErrorSentencesAreFixed pins the receive-side sentence for every
// code, byte for byte: RX-01 to RX-09 of the approved CLI copy (D-123) for the
// nine codes that print "receive stopped: " and a fixed sentence, and the
// unchanged write-failed, disk-full and hash-mismatch sentences. Err never
// leaks into any of them, and neither does the code's own slug.
func TestRefusedErrorSentencesAreFixed(t *testing.T) {
	cause := errors.New("open C:\\Users\\someone\\secret.part: The device is not ready.")
	want := map[RefusalCode]string{
		CodePathTooLong:           "receive stopped: a file's path is too deep or too long to save in this folder", // RX-01
		CodeFileTooLargeForFolder: "receive stopped: a file is larger than the save drive can hold",                // RX-02
		CodeOverApproved:          "receive stopped: more data arrived than this transfer announced",               // RX-03
		CodeRelayCap:              "receive stopped: relayed transfers are capped at 2 GB",                         // RX-04
		CodeTimeLimit:             "receive stopped: the transfer reached its 24-hour limit",                       // RX-05
		CodeExpired:               "receive stopped: nobody answered in time",                                      // RX-06
		CodeDeclined:              "receive stopped: the transfer was declined",                                    // RX-07
		CodeStopped:               "receive stopped: the transfer was stopped on this computer",                    // RX-08
		CodeSaveBlocked:           "receive stopped: a finished file could not be moved into place",                // RX-09
		// Unchanged by D-123: the desktop maps the "write error" prefix to its
		// save-folder sentence, and the hash sentences pass through.
		CodeWriteFailed:  "write error: could not finish writing a file, so it was not kept",
		CodeDiskFull:     "write error: the drive ran out of space, so the file was not kept",
		CodeHashMismatch: "a file did not match the SHA-256 the sender computed, so it was not kept",
	}
	if len(want) != len(RefusalCodes) {
		t.Fatalf("the sentence table has %d rows for %d codes", len(want), len(RefusalCodes))
	}
	for _, c := range RefusalCodes {
		err := &RefusedError{Code: c, Saved: 3, Err: cause}
		got := err.Error()
		if got != want[c] {
			t.Errorf("%s: Error() = %q, want %q", c, got, want[c])
		}
		if strings.Contains(got, "secret") || strings.Contains(got, "device") {
			t.Errorf("%s: Error() leaks the cause: %q", c, got)
		}
		if strings.Contains(string(c), "-") && strings.Contains(got, string(c)) {
			t.Errorf("%s: Error() prints the code's slug: %q", c, got)
		}
		for _, ch := range got {
			if ch > unicode.MaxASCII || !unicode.IsPrint(ch) {
				t.Errorf("%s: Error() has a non-ASCII or non-printable rune %U", c, ch)
			}
		}
		if !errors.Is(err, cause) {
			t.Errorf("%s: the cause is not reachable with errors.Is", c)
		}
	}
	// An empty code, and any code this build does not know (only a hand-built
	// value can carry one), print the bare sentence and never the value.
	for _, c := range []RefusalCode{"", "too-slow", "\x1b[2K\u202e$(calc)", "C:\\Users\\someone\\secret"} {
		if got := (&RefusedError{Code: c, Err: cause}).Error(); got != "receive stopped" {
			t.Errorf("%q: Error() = %q, want the bare %q", c, got, "receive stopped")
		}
	}
	unreadable := &RefusedError{Code: CodeHashMismatch, Err: errSHA256Unreadable}
	if got := unreadable.Error(); got != "the sender's SHA-256 for a file could not be read, so the file was not kept" {
		t.Errorf("unreadable digest Error() = %q", got)
	}
	if ErrDeclined.Error() != "transfer declined" {
		t.Errorf("ErrDeclined = %q, want the accept prompt's sentence", ErrDeclined)
	}
}

// TestCommitErrorSentenceIsFixed pins RX-10 of the approved CLI copy (D-123)
// byte for byte: it says the .part was kept, and names no path, no file and
// no cause, although every field it carries holds one.
func TestCommitErrorSentenceIsFixed(t *testing.T) {
	cause := errors.New("rename C:\\Users\\someone\\secret.part: The process cannot access the file because it is being used by another process.")
	commit := &CommitError{PartPath: "C:\\x\\secret.part", Dest: "C:\\x\\secret", Base: "C:\\x\\secret", Err: cause}
	const rx10 = "received a file in full but could not finish saving it; the complete file was kept in the save folder with a .part ending"
	got := commit.Error()
	if got != rx10 {
		t.Errorf("CommitError.Error() = %q, want %q", got, rx10)
	}
	if strings.Contains(got, "secret") || strings.Contains(got, "process") || strings.Contains(got, `\`) {
		t.Errorf("CommitError.Error() leaks a path or the cause: %q", got)
	}
	if !errors.Is(commit, cause) {
		t.Error("CommitError does not unwrap to its cause")
	}
	var ce *CommitError
	if !errors.As(fmt.Errorf("wrapped: %w", commit), &ce) || ce.PartPath != commit.PartPath {
		t.Error("errors.As does not find a CommitError, so a caller cannot reach the .part")
	}
}
