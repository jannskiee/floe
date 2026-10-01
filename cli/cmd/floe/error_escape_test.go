package main

// Every error and server string the CLI prints goes through one escape
// (FU-43, the FU-40 review's M2 and L4).

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"unicode"
	"unicode/utf8"

	"github.com/spf13/cobra"
)

// hostileText carries what a TLS certificate's names, a server's error
// message or a code phrase could: a screen clear, an OSC 52 clipboard write,
// an OSC 8 link, BEL, a C1 CSI, a bidi override, a zero-width space, a line
// separator and a byte that is not UTF-8.
const hostileText = "\x1b[2J\x1b]52;c;ZWNobyBwd25lZA==\x07\x1b]8;;http://evil.example/\x1b\\CLICK\x1b]8;;\x1b\\\u009b2J\u202e\u200b\u2028\xff"

// requireNoRawControl fails when s holds a rune a terminal could act on or
// that hides text, a line or paragraph separator, or a byte that is not UTF-8
// (the newlines between lines aside).
func requireNoRawControl(t *testing.T, what, s string) {
	t.Helper()
	if !utf8.ValidString(s) {
		t.Fatalf("%s reached the terminal with a byte that is not UTF-8: %q", what, s)
	}
	for i, r := range s {
		if r == '\n' {
			continue
		}
		if unicode.IsControl(r) || unicode.In(r, unicode.Cf, unicode.Zl, unicode.Zp) {
			t.Fatalf("%s reached the terminal with %U raw at %d: %q", what, r, i, s)
		}
	}
}

// runArgs runs the command tree through execute with args and returns what
// execute and cobra printed to the error writer.
func runArgs(t *testing.T, args ...string) string {
	t.Helper()
	var printed bytes.Buffer
	rootCmd.SetOut(io.Discard)
	rootCmd.SetErr(&printed)
	rootCmd.SetArgs(args)
	t.Cleanup(func() {
		rootCmd.SetOut(nil)
		rootCmd.SetErr(nil)
		rootCmd.SetArgs(nil)
	})
	if err := execute(); err == nil {
		t.Fatalf("floe %s succeeded", strings.Join(args, " "))
	}
	return printed.String()
}

// runFailing adds a hidden subcommand that fails with err, runs it through
// execute and returns what execute printed.
func runFailing(t *testing.T, err error) string {
	t.Helper()
	cmd := &cobra.Command{Use: "fu43-fail", Hidden: true, RunE: func(*cobra.Command, []string) error { return err }}
	// Removed as soon as it has run: a second call in the same test adds its
	// own, which cobra would not find behind the first.
	rootCmd.AddCommand(cmd)
	defer rootCmd.RemoveCommand(cmd)
	return runArgs(t, "fu43-fail")
}

// TestExecuteEscapesTheErrorItPrints: an error carrying terminal controls
// prints on one line with every control escaped and its printable parts kept.
func TestExecuteEscapesTheErrorItPrints(t *testing.T) {
	printed := runFailing(t, errors.New("failed to connect to signaling server: x509: certificate is valid for "+hostileText+", not api.floe.one"))
	if !strings.HasPrefix(printed, "Error: failed to connect to signaling server: ") {
		t.Fatalf("execute did not print the error in cobra's form: %q", printed)
	}
	if strings.Count(printed, "\n") != 1 {
		t.Errorf("the error took %d lines, want one: %q", strings.Count(printed, "\n"), printed)
	}
	requireNoRawControl(t, "the error line", printed)
	for _, want := range []string{"[2J", "52;c;ZWNobyBwd25lZA==", "8;;http://evil.example/", "CLICK", "not api.floe.one"} {
		if !strings.Contains(printed, want) {
			t.Errorf("the error line lost %q: %q", want, printed)
		}
	}
}

// TestExecutePrintsAPlainErrorAsCobraDid: an error with nothing to escape
// prints byte for byte as cobra printed it before execute took over.
func TestExecutePrintsAPlainErrorAsCobraDid(t *testing.T) {
	const msg = `code "olive-tiger-castle" not found or expired (codes expire after 10 minutes)`
	if got := runFailing(t, errors.New(msg)); got != "Error: "+msg+"\n" {
		t.Fatalf("execute printed %q, want %q", got, "Error: "+msg+"\n")
	}
}

// TestExecuteKeepsFloesOwnLinesAndIndentsAnyOther (review 1 L1): Floe's own
// multi-line errors print as before; a newline in other text only adds an
// indented line, never one that passes for separate output.
func TestExecuteKeepsFloesOwnLinesAndIndentsAnyOther(t *testing.T) {
	const remedy = "Cannot transfer: your floe is too old for this peer.\n  You: protocol 1 (dev)  Peer: protocol 9\n  Run `floe update` to upgrade."
	if got := runFailing(t, errors.New(remedy)); got != "Error: "+remedy+"\n" {
		t.Fatalf("Floe's own multi-line error changed: %q", got)
	}
	got := runFailing(t, errors.New("x509: certificate is valid for a\nError: transfer complete\n\x1b[2Jb"))
	lines := strings.Split(strings.TrimSuffix(got, "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("got %d lines, want 3: %q", len(lines), got)
	}
	for _, l := range lines[1:] {
		if !strings.HasPrefix(l, "  ") {
			t.Errorf("a line from inside the error starts at the margin: %q", l)
		}
	}
	requireNoRawControl(t, "the multi-line error", got)
}

// TestExecuteCutsALongError (review 1 L5): a server message of any length
// prints as a bounded line.
func TestExecuteCutsALongError(t *testing.T) {
	got := runFailing(t, errors.New("server error: "+strings.Repeat("\x1b", 1<<20)))
	if n, max := len(got), len("Error: ")+4*errorMax+8; n > max {
		t.Fatalf("execute printed %d bytes for a 1 MiB message, want at most %d", n, max)
	}
	requireNoRawControl(t, "the cut error", got)
}

// TestExecuteKeepsCobrasOwnOutput (review 1 M1): what fails before a Floe
// subcommand runs (an unknown command with its hint and suggestions, a flag of
// the root) still prints exactly as cobra prints it.
func TestExecuteKeepsCobrasOwnOutput(t *testing.T) {
	want := "Error: unknown command \"nope\" for \"floe\"\nRun 'floe --help' for usage.\n"
	if got := runArgs(t, "nope"); got != want {
		t.Errorf("floe nope printed %q, want %q", got, want)
	}
	if got := runArgs(t, "recieve"); !strings.Contains(got, "Did you mean this?\n\treceive\n") {
		t.Errorf("floe recieve lost cobra's suggestion block: %q", got)
	}
	if got := runArgs(t, "--bogus"); got != "Error: unknown flag: --bogus\n" {
		t.Errorf("floe --bogus printed %q", got)
	}
}

// TestShortCodeWarningEscapes: the warning send prints when no code comes
// back carries the error's text escaped, on one line.
func TestShortCodeWarningEscapes(t *testing.T) {
	line := shortCodeWarning(errors.New("could not register code: " + hostileText + "\nsecond"))
	if !strings.HasPrefix(line, "  Warning: could not generate short code: could not register code: ") {
		t.Fatalf("the warning lost its words: %q", line)
	}
	if strings.Contains(line, "\n") {
		t.Errorf("the warning took more than one line: %q", line)
	}
	requireNoRawControl(t, "the short code warning", line)
}

// TestShareRowsEscapeTheCode: a code phrase is the server's text, so a hostile
// one is bounded and escaped; a real one, and the link, come out unchanged.
func TestShareRowsEscapeTheCode(t *testing.T) {
	const link = "https://www.floe.one/#room=7d2c5b0e-9a41-4f7e-8c1d-2b6f0e9a3c55"
	rows := shareRows(hostileText+strings.Repeat("a", 500), link)
	if len(rows) != 2 || rows[0][0] != "Code" || rows[1] != [2]string{"Link", link} {
		t.Fatalf("shareRows = %q, want a Code row and the link", rows)
	}
	requireNoRawControl(t, "the code row", rows[0][1])
	if n := len(rows[0][1]); n > 4*codePhraseMax+8 {
		t.Errorf("the code row is %d bytes, want at most %d", n, 4*codePhraseMax+8)
	}
	if got := shareRows("olive-tiger-castle", link); got[0][1] != "olive-tiger-castle" {
		t.Errorf("a real code phrase changed: %q", got[0][1])
	}
	if got := shareRows("", link); len(got) != 1 || got[0][0] != "Link" {
		t.Errorf("no code should leave the link alone: %q", got)
	}
}

// captureStdout swaps os.Stdout for a pipe while fn runs and returns what fn
// printed there.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	orig := os.Stdout
	os.Stdout = w
	var buf bytes.Buffer
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); _, _ = io.Copy(&buf, r) }()
	fn()
	os.Stdout = orig
	_ = w.Close()
	wg.Wait()
	_ = r.Close()
	return buf.String()
}

// TestSendEscapesAHostileCodePhrase (review 1 L2): the real floe send prints
// the box with the server's hostile code escaped.
func TestSendEscapesAHostileCodePhrase(t *testing.T) {
	serverCodePhrase = hostileText
	t.Cleanup(func() { serverCodePhrase = "olive-tiger-castle" })
	file := filepath.Join(t.TempDir(), "hello.txt")
	if err := os.WriteFile(file, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	url := hostilePeer(t, "sender")
	out := captureStdout(t, func() { _ = runAgainst(t, url, "send", file) })
	if !strings.Contains(out, "Code") || !strings.Contains(out, "[2J") {
		t.Fatalf("send printed no code row with the server's code: %q", out)
	}
	requireNoRawControl(t, "send's output", out)
}
