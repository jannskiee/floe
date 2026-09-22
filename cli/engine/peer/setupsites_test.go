package peer

// Every setup failure site returns a *SetupError or passes through the one
// setRemoteDesc built: a source-shape check, because nine of the nineteen
// return sites cannot be driven in-process (pion refusing valid input, the
// 30 s waits), and a wrap dropped at CreateAnswer would hand pion's text,
// which can quote the peer's SDP, to a terminal unsanitized.

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

// untypedSetupReturns is every site that is neither a *SetupError literal nor
// the bare passthrough of the error setRemoteDesc built on the line before.
func untypedSetupReturns(sites [][2]string) (bad []string) {
	for _, s := range sites {
		line := strings.TrimSpace(s[1])
		if strings.Contains(line, "&SetupError{") {
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
	if len(sites) != 19 {
		t.Fatalf("expected 19 return sites across SetupAsSender and SetupAsReceiver, found %d: a new site needs its SetupError and this count", len(sites))
	}
	if bad := untypedSetupReturns(sites); len(bad) != 0 {
		t.Fatalf("setup return sites that are neither a *SetupError nor the setRemoteDesc passthrough: %q", bad)
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
