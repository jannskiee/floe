package serverurl

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestNormalize guards the property every caller depends on: the result can have
// a path appended to it without producing a doubled slash. A doubled slash is
// routed as a different path and 404s, and ice.Fetch turns that 404 into a
// silent fallback to public STUN, so the failure is invisible to the user.
func TestNormalize(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"already clean", "https://api.floe.one", "https://api.floe.one"},
		{"one trailing slash", "https://api.floe.one/", "https://api.floe.one"},
		// TrimSuffix would leave one of these behind; TrimRight takes the run.
		{"several trailing slashes", "https://api.floe.one///", "https://api.floe.one"},
		{"surrounding whitespace", "  https://api.floe.one  ", "https://api.floe.one"},
		{"whitespace and slash", " https://api.floe.one/ ", "https://api.floe.one"},
		{"empty", "", ""},
		{"only slashes", "///", ""},
		{"path preserved", "https://example.com/floe/", "https://example.com/floe"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Normalize(tc.input); got != tc.want {
				t.Fatalf("Normalize(%q) = %q, want %q", tc.input, got, tc.want)
			}
		})
	}
}

// TestWeb covers the three derivation branches. The slash-suffixed cases matter
// most: before normalization moved in here, an exact-match switch missed them
// and a production URL with a trailing slash produced a link pointing at the
// signaling API instead of the web app.
func TestWeb(t *testing.T) {
	cases := []struct {
		name   string
		server string
		want   string
	}{
		{"production", "https://api.floe.one", "https://floe.one"},
		{"production with trailing slash", "https://api.floe.one/", "https://floe.one"},
		{"local dev", "http://localhost:3001", "http://localhost:3000"},
		{"local dev with trailing slash", "http://localhost:3001/", "http://localhost:3000"},
		// One-domain self-hosting: the web app and the API share an origin, so
		// the server address is already the right link base.
		{"self-hosted one domain", "https://floe.example.com", "https://floe.example.com"},
		{"self-hosted with trailing slash", "https://floe.example.com/", "https://floe.example.com"},
		{"empty stays empty", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Web(tc.server); got != tc.want {
				t.Fatalf("Web(%q) = %q, want %q", tc.server, got, tc.want)
			}
		})
	}
}

// TestWebIsNormalized asserts the composed property the share-link builders rely
// on: whatever Web returns can have "/?s=..." appended without a double slash.
func TestWebIsNormalized(t *testing.T) {
	for _, server := range []string{
		"https://api.floe.one/",
		"http://localhost:3001//",
		"https://floe.example.com///",
		"  https://floe.example.com/  ",
	} {
		if got := Web(server); got != Normalize(got) {
			t.Fatalf("Web(%q) = %q, which is not normalized", server, got)
		}
	}
}

// TestNormalizeFoldsHostCaseAndTheDefaultPort (A4-B20): a scheme and a host
// are case-insensitive, and :443 on https (:80 on http) is the port a request
// goes to anyway, so each spelling of one server comes out as one string.
// Web and the signaling Origin compare that string exactly, and
// https://API.floe.one or https://api.floe.one:443 used to print a share link
// at the API host. The path, userinfo and any other port stay as typed.
func TestNormalizeFoldsHostCaseAndTheDefaultPort(t *testing.T) {
	cases := []struct{ input, want string }{
		{"https://API.floe.one", "https://api.floe.one"},
		{"HTTPS://Api.Floe.One/", "https://api.floe.one"},
		{"https://api.floe.one:443", "https://api.floe.one"},
		{"https://API.FLOE.ONE:443/", "https://api.floe.one"},
		{"http://LOCALHOST:3001", "http://localhost:3001"},
		{"http://files.example.com:80", "http://files.example.com"},
		{"https://Files.Example.com:8443/Floe", "https://files.example.com:8443/Floe"},
		{"http://files.example.com:443", "http://files.example.com:443"},
		{"https://files.example.com:80", "https://files.example.com:80"},
		{"https://[2001:DB8::1]:443", "https://[2001:db8::1]"},
		{"https://User@Files.Example.com", "https://User@files.example.com"},
		{"wss://API.floe.one", "wss://API.floe.one"},
		{"API.floe.one", "API.floe.one"},
	}
	for _, c := range cases {
		if got := Normalize(c.input); got != c.want {
			t.Errorf("Normalize(%q) = %q, want %q", c.input, got, c.want)
		}
	}
	for _, server := range []string{"https://API.floe.one", "https://api.floe.one:443", "HTTPS://Api.Floe.One:443/"} {
		if got := Web(server); got != prodWeb {
			t.Errorf("Web(%q) = %q, want %q", server, got, prodWeb)
		}
	}
	if got := Web("http://LocalHost:3001"); got != devWeb {
		t.Errorf("Web(http://LocalHost:3001) = %q, want %q", got, devWeb)
	}
}

// TestWebMatchesTheDesktopPlaceholder (CLI-05): Floe Desktop's Settings shows
// what a blank Share link address field falls back to with webPlaceholder
// (desktop/frontend/src/settings.ts), its own copy of Web, so the field says
// where share links will point. The two used to drift: Web learned host case
// and default ports while the placeholder kept comparing the raw string. Both
// now run over one table, the rows between WEB-VECTORS-BEGIN and
// WEB-VECTORS-END in settings.test.ts, which runs webPlaceholder over them.
// The rows include the root-dot spelling (https://api.floe.one.), which
// IsFloeOneServer reads as floe.one's server and Web now does too.
func TestWebMatchesTheDesktopPlaceholder(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "..", "desktop", "frontend", "src", "settings.test.ts"))
	if err != nil {
		t.Fatal(err)
	}
	text := strings.ReplaceAll(string(src), "\r\n", "\n")
	_, rest, ok := strings.Cut(text, "// WEB-VECTORS-BEGIN")
	if !ok {
		t.Fatal("settings.test.ts has no WEB-VECTORS-BEGIN marker")
	}
	block, _, ok := strings.Cut(rest, "// WEB-VECTORS-END")
	if !ok {
		t.Fatal("settings.test.ts has no WEB-VECTORS-END marker")
	}
	row := regexp.MustCompile(`(?m)^\s*\['([^']*)', '([^']*)', '([^']*)'\],\s*$`)
	rows := row.FindAllStringSubmatch(block, -1)
	if len(rows) < 10 {
		t.Fatalf("read %d rows from settings.test.ts, want the whole table", len(rows))
	}
	for _, r := range rows {
		if got := Web(r[2]); got != r[3] {
			t.Errorf("%s: Web(%q) = %q, and webPlaceholder is pinned to %q", r[1], r[2], got, r[3])
		}
	}
}
