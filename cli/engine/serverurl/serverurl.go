// Package serverurl normalizes a Floe signaling-server origin and derives the
// matching web-app origin.
//
// Both the CLI and the desktop app print a share link after a send, and a link
// is only useful if it points at a web app rather than at the signaling API.
// Keeping that derivation in one place stops the two surfaces from drifting
// apart and printing different links for the same server.
package serverurl

import "strings"

const (
	// prodServer and prodWeb are Floe's own deployment, where the signaling API
	// and the browser app live on separate hosts.
	prodServer = "https://api.floe.one"
	prodWeb    = "https://floe.one"

	// devServer and devWeb are the local development pair that docker-compose
	// and the e2e suite bring up.
	devServer = "http://localhost:3001"
	devWeb    = "http://localhost:3000"
)

// Normalize trims surrounding whitespace and every trailing slash.
//
// Callers append paths directly to the result (serverURL + "/api/code"), so one
// stray slash yields "//api/code", which servers route as a different path and
// answer with 404. Some of those 404s are silent: ice.Fetch swallows them and
// falls back to public STUN, so a relayed transfer dies with no message.
//
// TrimRight rather than TrimSuffix on purpose: it removes a run of slashes, not
// just the last one.
//
// An http or https address also has its scheme and host lower-cased and its
// default port (:443 on https, :80 on http) dropped, so every spelling of one
// server is one string. Web and the signaling client's Origin compare that
// string exactly, and https://API.floe.one or https://api.floe.one:443 used to
// print a share link at the API host (A4-B20). Userinfo, any other port and
// the path stay as typed: a path is case-sensitive.
func Normalize(s string) string {
	s = strings.TrimRight(strings.TrimSpace(s), "/")
	i := strings.Index(s, "://")
	if i < 0 {
		return s
	}
	scheme := strings.ToLower(s[:i])
	if scheme != "http" && scheme != "https" {
		return s
	}
	rest := s[i+3:]
	end := strings.IndexAny(rest, "/?#")
	if end < 0 {
		end = len(rest)
	}
	authority, tail := rest[:end], rest[end:]
	user := ""
	if at := strings.LastIndexByte(authority, '@'); at >= 0 {
		user, authority = authority[:at+1], authority[at+1:]
	}
	host := strings.ToLower(authority)
	switch {
	case scheme == "https" && strings.HasSuffix(host, ":443"):
		host = strings.TrimSuffix(host, ":443")
	case scheme == "http" && strings.HasSuffix(host, ":80"):
		host = strings.TrimSuffix(host, ":80")
	}
	return scheme + "://" + user + host + tail
}

// Web returns the web-app origin for share links, given a signaling origin.
//
// Floe's own deployment and the local dev stack both split the API and the web
// app across two origins, so each is special-cased. Anything else is assumed to
// be a self-hosted instance served from a single origin, which is the layout the
// reverse-proxy guide recommends. Split self-hosted deployments override this.
//
// Callers pass an already-resolved server, so an empty input returns empty
// rather than guessing a default.
//
// The match reads the host with one trailing dot taken off: the fully
// qualified spelling https://api.floe.one. names the same server, and
// code.IsFloeOneServer reads it as floe.one's, so it gets floe.one's links
// rather than links at the API host (CLI-05). What a self-hosted server gets
// back keeps its dot, as Normalize does.
//
// Floe Desktop's Settings has a copy of this derivation (webPlaceholder in
// desktop/frontend/src/settings.ts); TestWebMatchesTheDesktopPlaceholder runs
// both over one table.
func Web(server string) string {
	s := Normalize(server)
	switch withoutRootDot(s) {
	case prodServer:
		return prodWeb
	case devServer:
		return devWeb
	default:
		return s
	}
}

// withoutRootDot is a normalized http or https address with one trailing dot
// taken off its host, for comparison only: dropping it from an address a
// request goes to would change the host asked for.
func withoutRootDot(s string) string {
	i := strings.Index(s, "://")
	if i < 0 {
		return s
	}
	rest := s[i+3:]
	end := strings.IndexAny(rest, "/?#")
	if end < 0 {
		end = len(rest)
	}
	host, tail := rest[:end], rest[end:]
	port := ""
	if c := strings.LastIndexByte(host, ':'); c >= 0 && !strings.Contains(host[c:], "]") {
		host, port = host[:c], host[c:]
	}
	return s[:i+3] + strings.TrimSuffix(host, ".") + port + tail
}
