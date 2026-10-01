package main

// Every error and server string the CLI prints goes through one escape
// (FU-43, the FU-40 review's M2 and L4).

import (
	"bytes"
	"errors"
	"io"
	"strings"
	"testing"
	"unicode"

	"github.com/spf13/cobra"
)

// hostileText carries what a TLS certificate's names, a server's error
// message or a code phrase could: a screen clear, an OSC 52 clipboard write,
// an OSC 8 link, BEL, a C1 CSI, a bidi override and a zero-width space.
const hostileText = "\x1b[2J\x1b]52;c;ZWNobyBwd25lZA==\x07\x1b]8;;http://evil.example/\x1b\\CLICK\x1b]8;;\x1b\\\u009b2J\u202e\u200b"

// requireNoRawControl fails when s holds a rune a terminal could act on or
// that hides text (the newline that ends a line aside).
func requireNoRawControl(t *testing.T, what, s string) {
	t.Helper()
	for i, r := range strings.TrimSuffix(s, "\n") {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			t.Fatalf("%s reached the terminal with %U raw at %d: %q", what, r, i, s)
		}
	}
}

// runFailing adds a hidden subcommand that fails with err, runs it through
// execute and returns what execute printed to the error writer.
func runFailing(t *testing.T, err error) string {
	t.Helper()
	cmd := &cobra.Command{Use: "fu43-fail", Hidden: true, RunE: func(*cobra.Command, []string) error { return err }}
	rootCmd.AddCommand(cmd)
	var printed bytes.Buffer
	rootCmd.SetOut(io.Discard)
	rootCmd.SetErr(&printed)
	rootCmd.SetArgs([]string{"fu43-fail"})
	t.Cleanup(func() {
		rootCmd.RemoveCommand(cmd)
		rootCmd.SetOut(nil)
		rootCmd.SetErr(nil)
		rootCmd.SetArgs(nil)
	})
	if got := execute(); got == nil {
		t.Fatal("execute returned no error for a failing command")
	}
	return printed.String()
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

// TestShortCodeWarningEscapes: the warning send prints when no code comes
// back carries the error's text escaped.
func TestShortCodeWarningEscapes(t *testing.T) {
	line := shortCodeWarning(errors.New("could not register code: " + hostileText))
	if !strings.HasPrefix(line, "  Warning: could not generate short code: could not register code: ") {
		t.Fatalf("the warning lost its words: %q", line)
	}
	requireNoRawControl(t, "the short code warning", line)
}

// TestShareRowsEscapeTheCode: a code phrase is the server's text, so a hostile
// one is escaped; a real one, and the link, come out unchanged.
func TestShareRowsEscapeTheCode(t *testing.T) {
	const link = "https://www.floe.one/#room=7d2c5b0e-9a41-4f7e-8c1d-2b6f0e9a3c55"
	rows := shareRows(hostileText, link)
	if len(rows) != 2 || rows[0][0] != "Code" || rows[1] != [2]string{"Link", link} {
		t.Fatalf("shareRows = %q, want a Code row and the link", rows)
	}
	requireNoRawControl(t, "the code row", rows[0][1])
	if got := shareRows("olive-tiger-castle", link); got[0][1] != "olive-tiger-castle" {
		t.Errorf("a real code phrase changed: %q", got[0][1])
	}
	if got := shareRows("", link); len(got) != 1 || got[0][0] != "Link" {
		t.Errorf("no code should leave the link alone: %q", got)
	}
}
