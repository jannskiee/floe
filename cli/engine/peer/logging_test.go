package peer

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/pion/webrtc/v4"
)

// capturedStderr is what reached os.Stderr while captureStderr held it.
type capturedStderr struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (c *capturedStderr) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buf.String()
}

// captureStderr swaps os.Stderr for a pipe until the test ends. peer.New
// hands pion the stderr of the moment, so the swap comes first. The package
// has no t.Parallel, so a process-wide swap is safe.
func captureStderr(t *testing.T) *capturedStderr {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	orig := os.Stderr
	os.Stderr = w
	c := &capturedStderr{}
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		b := make([]byte, 4096)
		for {
			n, err := r.Read(b)
			if n > 0 {
				c.mu.Lock()
				c.buf.Write(b[:n])
				c.mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() {
		os.Stderr = orig
		_ = w.Close()
		<-drained
		_ = r.Close()
	})
	return c
}

// logTestOffer is a remote offer written by hand, so setting it needs no
// second peer: pion checks a trickled candidate's ufrag against it, and every
// candidate below carries another ufrag.
const logTestOffer = "v=0\r\n" +
	"o=- 4215775240449105457 2 IN IP4 127.0.0.1\r\n" +
	"s=-\r\n" +
	"t=0 0\r\n" +
	"a=group:BUNDLE 0\r\n" +
	"m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
	"c=IN IP4 0.0.0.0\r\n" +
	"a=ice-ufrag:floelog\r\n" +
	"a=ice-pwd:floelogfloelogfloelogfloelog\r\n" +
	"a=ice-options:trickle\r\n" +
	"a=fingerprint:sha-256 00:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D:1E:1F\r\n" +
	"a=setup:actpass\r\n" +
	"a=mid:0\r\n" +
	"a=sctp-port:5000\r\n"

// hostileUfrags are what a peer can put in a trickled candidate's ufrag to act
// on the other side's terminal, one candidate each. pion takes an extension
// value of any rune from 0x01 to 0xFF except space, CR and LF (ice
// candidate_base.go), so the first six reach its "dropping candidate with
// ufrag %s" error; the bidi override, the zero-width space and the newline it
// refuses, and they ride along to show nothing raw gets out whatever pion does.
var hostileUfrags = []string{
	"\x1b[2J\x1b[H", // CSI: clear the screen, cursor home
	"\x1b]8;;http://evil.example/\x07CLICK\x1b]8;;\x07", // OSC 8 hyperlink, BEL terminated
	"\x1b]52;c;ZWNobyBwd25lZA==\x07",                    // OSC 52: write the clipboard
	"TXT\x08\x08\x08",                                   // backspaces over the text
	"\u009b2J\u0085\u0090",                              // C1: CSI, NEL, DCS
	"DEL\x7f",                                           // DEL
	"\u202eexe.txt",                                     // RLO, the bidi override
	"zero\u200bwidth",                                   // a zero-width space
	"line\nbreak",                                       // a newline, to forge a line
}

// firstUnsafe names the first thing in s a terminal could act on or hide: a
// C0 control other than the newline that ends a line, DEL, a C1 control, a
// format character (bidi, zero width), a line or paragraph separator, or a
// byte that is not UTF-8. "" when there is none.
func firstUnsafe(s string) string {
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		switch {
		case r == utf8.RuneError && size == 1:
			return fmt.Sprintf("the byte 0x%02x (not UTF-8) at %d", s[i], i)
		case r == '\n':
		case unicode.IsControl(r), unicode.Is(unicode.Cf, r), r == '\u2028', r == '\u2029':
			return fmt.Sprintf("%U at %d", r, i)
		}
		i += size
	}
	return ""
}

// TestPionLogsCarryNoControlCharacters (FU-40, review lens B M2): a peer
// trickles candidates whose ufrag is made of terminal controls, through the
// signaling path a real peer uses (the JSON on sc.Signal, the dispatcher, the
// candidate handler, pion's AddICECandidate), and pion logs every one it can
// parse as "pc ERROR: dropping candidate with ufrag ...". What reaches stderr
// must carry no raw control, format character or stray byte; the values must
// still be there, escaped, so the diagnostic survives.
func TestPionLogsCarryNoControlCharacters(t *testing.T) {
	stderr := captureStderr(t)
	sc := &signaling.Client{Signal: make(chan json.RawMessage, len(hostileUfrags))}
	conn, err := New(nil, sc)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer conn.Close()
	if err := conn.setRemoteDesc(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: logTestOffer}); err != nil {
		t.Fatalf("set the remote offer: %v", err)
	}
	for _, u := range hostileUfrags {
		raw, err := json.Marshal(map[string]any{"candidate": map[string]any{
			"candidate": "candidate:1 1 udp 2130706431 192.0.2.1 5000 typ host ufrag " + u,
			"sdpMid":    "0",
		}})
		if err != nil {
			t.Fatal(err)
		}
		sc.Signal <- raw
	}
	const logged = 6
	for deadline := time.Now().Add(5 * time.Second); strings.Count(stderr.String(), "dropping candidate") < logged && time.Now().Before(deadline); {
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(200 * time.Millisecond) // any straggler
	got := stderr.String()
	if n := strings.Count(got, "dropping candidate"); n < logged {
		t.Fatalf("pion logged %d dropped candidates, want %d; stderr: %q", n, logged, got)
	}
	if bad := firstUnsafe(got); bad != "" {
		t.Fatalf("a pion log line reached stderr with %s raw; stderr: %q", bad, got)
	}
	for _, want := range []string{`\x1b[2J\x1b[H`, `\x1b]52;c;ZWNobyBwd25lZA==\x07`, `TXT\x08\x08\x08`, `\u009b2J\u0085\u0090`, `DEL\x7f`} {
		if !strings.Contains(got, want) {
			t.Errorf("the log lost the value %s; stderr: %q", want, got)
		}
	}
}

// TestEscapeLogLine: every rune a terminal could act on, or that hides text,
// comes out as a visible escape; everything else, non-ASCII text included,
// comes out unchanged.
func TestEscapeLogLine(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"plain ASCII, 0-9 and punctuation: ok.", "plain ASCII, 0-9 and punctuation: ok."},
		{"caf\u00e9 \u4e2d\u6587 \u2713 \ufffd", "caf\u00e9 \u4e2d\u6587 \u2713 \ufffd"},
		{"\x1b[2J\x1b[H", `\x1b[2J\x1b[H`},
		{"\x1b]8;;http://evil.example/\x07CLICK\x1b]8;;\x07", `\x1b]8;;http://evil.example/\x07CLICK\x1b]8;;\x07`},
		{"\x1b]52;c;ZWNobyBwd25lZA==\x07", `\x1b]52;c;ZWNobyBwd25lZA==\x07`},
		{"a\bb\tc\rd\ne\x00f", `a\x08b\x09c\x0dd\x0ae\x00f`},
		{"DEL\x7f", `DEL\x7f`},
		{"\u0085\u009b\u0090", `\u0085\u009b\u0090`},
		{"\x9b is a lone byte", `\x9b is a lone byte`},
		{"\u202eexe.txt \u2066iso\u2069 \u200e\u200f \u061c", `\u202eexe.txt \u2066iso\u2069 \u200e\u200f \u061c`},
		{"zero\u200bwidth\u200c\u200d\u2060\ufeff", `zero\u200bwidth\u200c\u200d\u2060\ufeff`},
		{"line\u2028paragraph\u2029", `line\u2028paragraph\u2029`},
		{"tag\U000e0041", `tag\U000e0041`},
	} {
		if got := string(escapeLogLine([]byte(c.in))); got != c.want {
			t.Errorf("escapeLogLine(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestLogLineWriterKeepsOnlyTheLineEnd: a Write is one log line, so the
// newline the logger ends it with stays, and one a value brought in the
// middle, which would forge a second line, is escaped. The Write reports the
// whole input as written, as io.Writer requires.
func TestLogLineWriterKeepsOnlyTheLineEnd(t *testing.T) {
	var buf bytes.Buffer
	in := "pc ERROR: 2026/10/01 00:00:00 ufrag a\npc ERROR: forged\x1b[2J\n"
	n, err := logLineWriter{w: &buf}.Write([]byte(in))
	if err != nil || n != len(in) {
		t.Fatalf("Write = %d, %v; want %d, nil", n, err, len(in))
	}
	if got, want := buf.String(), `pc ERROR: 2026/10/01 00:00:00 ufrag a\x0apc ERROR: forged\x1b[2J`+"\n"; got != want {
		t.Fatalf("wrote %q, want %q", got, want)
	}
}

// TestLoggerFactoryKeepsPionLevels: the factory reads PION_LOG_* as pion's own
// default does (ERROR when none is set, a scope list, or "all"), so the transfer
// audit's PION_LOG_TRACE=ice route evidence still prints, now escaped; and
// every scope pion asks it for (pc, ice, DTLS, SCTP, data channel, mux, the
// interceptors) writes through the same escape.
func TestLoggerFactoryKeepsPionLevels(t *testing.T) {
	for _, prefix := range []string{"PION_LOG_", "PIONS_LOG_"} {
		for _, level := range []string{"DISABLE", "ERROR", "WARN", "INFO", "DEBUG", "TRACE"} {
			t.Setenv(prefix+level, "")
		}
	}
	t.Setenv("PION_LOG_TRACE", "ice")
	var buf bytes.Buffer
	f := newLoggerFactory(&buf)
	f.NewLogger("ice").Tracef("remote candidate %s", "\x1b[2J")
	f.NewLogger("pc").Tracef("hidden at the default level %s", "x")
	scopes := []string{"pc", "ice", "DTLSTransport", "dtls", "sctp", "datachannel", "ortc", "mux", "api", "nack_generator"}
	for _, scope := range scopes {
		f.NewLogger(scope).Errorf("%s logs %s", scope, "\x1b]52;c;ZWNobyBwd25lZA==\x07")
	}
	got := buf.String()
	if bad := firstUnsafe(got); bad != "" {
		t.Fatalf("the factory wrote %s raw: %q", bad, got)
	}
	if !strings.Contains(got, "ice TRACE: ") || !strings.Contains(got, `remote candidate \x1b[2J`) {
		t.Errorf("PION_LOG_TRACE=ice no longer prints the ice trace line, escaped: %q", got)
	}
	if strings.Contains(got, "hidden at the default level") {
		t.Errorf("pc logged at TRACE with only ice raised: %q", got)
	}
	for _, scope := range scopes {
		if !strings.Contains(got, scope+" ERROR: ") || !strings.Contains(got, scope+` logs \x1b]52;c;ZWNobyBwd25lZA==\x07`) {
			t.Errorf("scope %s did not log its error through the escape: %q", scope, got)
		}
	}
}
