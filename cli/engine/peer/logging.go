package peer

// pion's log lines and setup errors, made safe for the terminal they reach
// (FU-40).

import (
	"fmt"
	"io"
	"unicode"
	"unicode/utf8"

	"github.com/pion/logging"
)

// newLoggerFactory is the factory New hands pion: pion's own default, with its
// levels read from PION_LOG_ERROR, PION_LOG_TRACE and the rest exactly as pion
// reads them (ERROR when none is set), writing to w through escapeLogLine.
//
// Every logger pion/webrtc builds comes from this factory, the setting
// engine's: pc, ice, DTLS, SCTP, the data channel, mux, api and the
// interceptors. Several print values the remote peer chose. A trickled
// candidate's ufrag reaches "pc ERROR: dropping candidate with ufrag %s" as it
// came, and PION_LOG_TRACE lines carry whole remote candidates. pion's default
// factory wrote them straight to stderr, so a peer could clear the screen,
// plant an OSC 8 link or write the clipboard with OSC 52 on the other side's
// terminal (review lens B M2, in every CLI release since v1.1.0 moved to
// pion/webrtc v4, floe send and floe receive alike).
//
// Three loggers still skip it. pion/ice v4.4.0's WithLoggerFactory sets only
// the agent's own logger, so the agent hands pion's default factory to its
// mDNS server, its TURN client and the DTLS client for TURN over DTLS, and
// those write to stderr unescaped. None of them prints a value the peer chose,
// and logging_bypass_test.go fails if any other logger starts taking that
// route. mDNS stays on all the same: the CLI needs it to resolve the .local
// host candidates browsers send. pion/ice v4.4.3 fixes this (pion/ice#976);
// pion/webrtc v4.2.21 is the first release that requires a fixed pion/ice.
func newLoggerFactory(w io.Writer) logging.LoggerFactory {
	f := logging.NewDefaultLoggerFactory()
	f.Writer = logLineWriter{w: w}
	return f
}

// logLineWriter hands each log line to w with escapeLogLine applied. The
// standard library logger pion uses writes one whole line per Write and ends
// it with a newline of its own, so a Write is a line: that last newline is
// kept, and any other, which only a value can have brought, is escaped. An
// error is w's own, never the line's.
type logLineWriter struct{ w io.Writer }

func (l logLineWriter) Write(p []byte) (int, error) {
	line, newline := p, false
	if n := len(line); n > 0 && line[n-1] == '\n' {
		line, newline = line[:n-1], true
	}
	out := escapeLogLine(line)
	if newline {
		out = append(out, '\n')
	}
	if _, err := l.w.Write(out); err != nil {
		return 0, err
	}
	return len(p), nil
}

// EscapeText returns s as escapeLogLine writes a log line: every rune a
// terminal could act on, or that hides text, as a visible escape, newlines
// included. A WebRTC setup error can quote the remote peer's SDP, since
// pion/sdp puts the token it refused in the message ("sdp: invalid value"),
// so floe send and floe receive print theirs through this.
func EscapeText(s string) string {
	return string(escapeLogLine([]byte(s)))
}

// escapeLogLine returns line with every rune a terminal could act on, or that
// hides text, written as a visible escape: the C0 controls (ESC, BEL, BS, CR,
// LF, TAB and the rest) and DEL as \xNN, the C1 controls (a terminal may take
// U+009B as CSI), the format characters (the bidi embeddings, overrides and
// isolates, the zero-width characters, U+FEFF) and the line and paragraph
// separators as \uNNNN, and a byte that is not UTF-8 as \xNN. Everything else
// passes unchanged, so a diagnostic still reads as itself.
func escapeLogLine(line []byte) []byte {
	out := make([]byte, 0, len(line))
	for len(line) > 0 {
		r, size := utf8.DecodeRune(line)
		switch {
		case r == utf8.RuneError && size == 1:
			out = fmt.Appendf(out, `\x%02x`, line[0])
		case r < 0x20 || r == 0x7f:
			out = fmt.Appendf(out, `\x%02x`, r)
		case unicode.IsControl(r), unicode.Is(unicode.Cf, r), r == '\u2028', r == '\u2029':
			if r > 0xffff {
				out = fmt.Appendf(out, `\U%08x`, r)
			} else {
				out = fmt.Appendf(out, `\u%04x`, r)
			}
		default:
			out = append(out, line[:size]...)
		}
		line = line[size:]
	}
	return out
}
