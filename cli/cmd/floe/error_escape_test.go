package main

// Every error and server string the CLI prints goes through one escape
// (FU-43, the FU-40 review's M2 and L4).

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
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
	t.Cleanup(func() {
		rootCmd.SetOut(nil)
		rootCmd.SetErr(nil)
		rootCmd.SetArgs(nil)
	})
	if err := execute(args); err == nil {
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

// TestExecuteKeepsOnlyFloesOwnLines (review 1 L1, review 2 M3):
// an error marked as Floe's own lines prints them as before; a newline in any
// other text, or in text wrapped around Floe's own lines, prints on one line.
func TestExecuteKeepsOnlyFloesOwnLines(t *testing.T) {
	const remedy = "Cannot transfer: your floe is too old for this peer.\n  You: protocol 1 (dev)  Peer: protocol 9\n  Run `floe update` to upgrade."
	if got := runFailing(t, testOwnLines(remedy)); got != "Error: "+remedy+"\n" {
		t.Fatalf("Floe's own multi-line error changed: %q", got)
	}
	got := runFailing(t, errors.New("x509: certificate is valid for a\nError: transfer complete\n\x1b[2Jb"))
	if n := strings.Count(got, "\n"); n != 1 {
		t.Fatalf("a foreign newline printed %d lines, want 1: %q", n, got)
	}
	if got := runFailing(t, fmt.Errorf("server error: a\n  Run x: %w", testOwnLines("b"))); strings.Count(got, "\n") != 1 {
		t.Errorf("foreign text wrapped around Floe's own lines printed as lines: %q", got)
	}
	requireNoRawControl(t, "the multi-line error", got)
}

// testOwnLines stands in for the engine's OwnLines errors.
type testOwnLines string

func (e testOwnLines) Error() string { return string(e) }
func (testOwnLines) OwnLines()       {}

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
	// Byte for byte as cobra printed them before execute looked for a request
	// link in the command's place (FU-53, FU-46 review 1 L4): a suggestion
	// block, a hash with no room id after it, a room id in a name, and an
	// unknown command beside a request link, which cobra names alone.
	room := uuid.New().String()
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"recieve"}, "Error: unknown command \"recieve\" for \"floe\"\n\nDid you mean this?\n\treceive\n\nRun 'floe --help' for usage.\n"},
		{[]string{"notes#1.txt"}, "Error: unknown command \"notes#1.txt\" for \"floe\"\nRun 'floe --help' for usage.\n"},
		{[]string{room + ".bin"}, "Error: unknown command \"" + room + ".bin\" for \"floe\"\nRun 'floe --help' for usage.\n"},
		{[]string{"nope", "https://floe.one/r/Xk3p9Q0aB1c#" + room}, "Error: unknown command \"nope\" for \"floe\"\nRun 'floe --help' for usage.\n"},
	} {
		if got := runArgs(t, c.args...); got != c.want {
			t.Errorf("floe %s printed %q, want %q", strings.Join(c.args, " "), got, c.want)
		}
	}
	// help keeps cobra's own answer for a topic that is not a request link.
	if stdout, stderr, _ := runArgsAll(t, "help", "nope"); !strings.Contains(stdout+stderr, "Unknown help topic") {
		t.Errorf("floe help nope lost cobra's answer:\nstdout:\n%s\nstderr:\n%s", stdout, stderr)
	}
}

// TestRequestLinkTypedAsTheCommandIsNeverPrintedBack (FU-53, FU-46 review 1
// L4): `floe <request link>`, the subcommand forgotten, ended on cobra's
// unknown-command error, which quotes the link, room id and all, into
// scrollback. It now ends on the plain send's line (D-153), alone on the
// indent and on nothing else, in every shape looksLikeRequestLink takes,
// after a root flag too; main exits 1 on the error. An unknown command with
// no request link in its place keeps cobra's text
// (TestExecuteKeepsCobrasOwnOutput).
func TestRequestLinkTypedAsTheCommandIsNeverPrintedBack(t *testing.T) {
	room := uuid.New().String()
	shapes := linkAsPathShapes(room)
	type run struct {
		name string
		args []string
	}
	var runs []run
	for name, link := range shapes {
		runs = append(runs, run{name, []string{link}})
	}
	runs = append(runs,
		run{"after a root flag", []string{"--no-relay", shapes["a whole link"]}},
		run{"after --server and its value", []string{"--server", closedServer, shapes["a whole link"]}},
		run{"with --help after it", []string{shapes["a whole link"], "--help"}},
		// deep QA A3-07: cobra's help answers an unknown topic with the link quoted.
		run{"after help", []string{"help", shapes["a whole link"]}},
		run{"after --server, its value and help", []string{"--server", closedServer, "help", shapes["a whole link"]}},
		// W3 R5-08: cobra drops a lone dash and an empty argument before it
		// looks for the command.
		run{"after a lone dash and help", []string{"-", "help", shapes["a whole link"]}},
		run{"after an empty argument and help", []string{"", "help", shapes["a whole link"]}},
	)
	for _, r := range runs {
		t.Run(r.name, func(t *testing.T) {
			stdout, stderr, err := runArgsAll(t, r.args...)
			all := strings.ToLower(stdout + stderr)
			for _, leak := range []string{strings.ToLower(room[1:]), strings.ToLower("Xk3p9Q0aB1"), "unknown command"} {
				if strings.Contains(all, leak) {
					t.Fatalf("%q was printed:\nstdout:\n%s\nstderr:\n%s", leak, stdout, stderr)
				}
			}
			if !errors.Is(err, errLinkTypedAsPath) {
				t.Fatalf("execute returned %v, want the link-as-path outcome (main exits 1 on it)", err)
			}
			if stdout != "" || stderr != "  "+lineLinkAsPath+"\n" {
				t.Fatalf("want the one line %q on stderr and nothing on stdout\nstdout:\n%q\nstderr:\n%q", lineLinkAsPath, stdout, stderr)
			}
		})
	}
}

// runArgsAll runs the command tree through execute with args, as main runs
// it, and returns what reached stdout (cobra's writer and the process's) and
// the error writer, with the error main turns into exit 1.
func runArgsAll(t *testing.T, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	var out, errOut bytes.Buffer
	rootCmd.SetOut(&out)
	rootCmd.SetErr(&errOut)
	t.Cleanup(func() {
		rootCmd.SetOut(nil)
		rootCmd.SetErr(nil)
		rootCmd.SetArgs(nil)
	})
	stdout = captureStdout(t, func() { err = execute(args) })
	return stdout + out.String(), errOut.String(), err
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
