package peer

// Every setup failure site returns a *SetupError or passes through the one
// setRemoteDesc built: a source-shape check, because nine of the seventeen
// original return sites cannot be driven in-process (pion refusing valid
// input, the 30 s waits), and a wrap dropped at CreateAnswer would hand
// pion's text, which can quote the peer's SDP, to a terminal unsanitized.
// S1-ENG-11 added twelve more, three in each of the four waits (peer left,
// signaling lost, closed), which the setup tests in connection_test.go drive,
// and review A R2 six more, the same three in each of the two grace waits.
// Two of the original nineteen, for an offer or answer channel that closed,
// are gone: nothing closes those channels. The peer-left and signaling-lost
// pair of each of the six waits is one return of leftError, so the six waits
// count one site each for it, and leftError's own returns are checked too.

import (
	"os"
	"strings"
	"testing"
)

// setupReturnSites lists every "return nil," line from SetupAsSender to the
// first function after SetupAsReceiver, each with the line before it, so the
// shape rule can be checked on the source itself.
func setupReturnSites(src string) (sites [][2]string) {
	lines := strings.Split(src, "\n")
	in := false
	for i, line := range lines {
		if strings.HasPrefix(line, "func (conn *Connection) SetupAsSender()") {
			in = true
		}
		if in && strings.HasPrefix(line, "func ") && !strings.Contains(line, "SetupAs") {
			break
		}
		if in && strings.Contains(line, "return nil,") {
			prev := ""
			if i > 0 {
				prev = lines[i-1]
			}
			sites = append(sites, [2]string{prev, line})
		}
	}
	return sites
}

// untypedSetupReturns is every site that is neither a *SetupError literal,
// leftError's answer, nor the bare passthrough of the error setRemoteDesc
// built on the line before.
func untypedSetupReturns(sites [][2]string) (bad []string) {
	for _, s := range sites {
		line := strings.TrimSpace(s[1])
		if strings.Contains(line, "&SetupError{") || line == "return nil, conn.leftError()" {
			continue
		}
		if line == "return nil, err" && strings.Contains(s[0], "setRemoteDesc(") {
			continue
		}
		bad = append(bad, line)
	}
	return bad
}

func TestEverySetupReturnIsTyped(t *testing.T) {
	src, err := os.ReadFile("connection.go")
	if err != nil {
		t.Fatal(err)
	}
	sites := setupReturnSites(string(src))
	if len(sites) != 29 {
		t.Fatalf("expected 29 return sites across SetupAsSender and SetupAsReceiver, found %d: a new site needs its SetupError and this count", len(sites))
	}
	if bad := untypedSetupReturns(sites); len(bad) != 0 {
		t.Fatalf("setup return sites that are neither a *SetupError nor the setRemoteDesc passthrough: %q", bad)
	}
	// leftError, the answer at every PeerLeft, returns only *SetupError literals.
	start := strings.Index(string(src), "func (conn *Connection) leftError() error {")
	if start < 0 {
		t.Fatal("leftError is gone, and the six PeerLeft sites return it")
	}
	// A Windows checkout with core.autocrlf (CI's windows-latest) reads CRLF.
	body := strings.ReplaceAll(string(src)[start:], "\r\n", "\n")
	end := strings.Index(body, "\n}\n")
	if end < 0 {
		t.Fatal("leftError has no closing brace at the start of a line")
	}
	body = body[:end]
	if n := strings.Count(body, "return "); n == 0 || n != strings.Count(body, "return &SetupError{") {
		t.Fatalf("leftError must return only *SetupError literals:\n%s", body)
	}

	// The rule itself catches a dropped wrap: over a snippet with one bare
	// return and one passthrough it must flag exactly the bare return.
	snippet := "func (conn *Connection) SetupAsSender() (*webrtc.DataChannel, error) {\n" +
		"\tif err != nil {\n\t\treturn nil, fmt.Errorf(\"failed to create answer: %w\", err)\n\t}\n" +
		"\tif err := conn.setRemoteDesc(answer); err != nil {\n\t\treturn nil, err\n\t}\n" +
		"}\n\nfunc (conn *Connection) Close() {}\n"
	bad := untypedSetupReturns(setupReturnSites(snippet))
	if len(bad) != 1 || !strings.Contains(bad[0], "fmt.Errorf") {
		t.Fatalf("the shape rule must flag exactly the bare return in the snippet, flagged %q", bad)
	}
}
