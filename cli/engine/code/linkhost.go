package code

// The link-host rules: whether a pasted link was made on the server this run
// is pointed at. Moved here from cli/cmd/floe/sendto.go so the request-link
// send, floe receive and Floe Desktop decide by one rule.

import (
	"net/url"
	"strings"

	"golang.org/x/net/idna"

	"github.com/jannskiee/floe/cli/engine/serverurl"
)

// LinkServerMismatch reports whether a link was made on a server this run is
// not pointed at, so that joining would hand the room id to a server that has
// never seen the room. Either way the send ends first with TL-10 (D-144.8)
// and no network call at all:
//   - a floe.one or www.floe.one link (IsFloeOneLinkHost), whose room lives
//     only on api.floe.one, with a server that is not api.floe.one
//     (IsFloeOneServer; FLOE_SERVER, a self-hoster's standing setting, or
//     --server). That server's operator could request-join api.floe.one with
//     the room id while the link is open and take its one seat (FU-46, FU-32
//     F5-4);
//   - a link on any other host with no server chosen, which would ask
//     api.floe.one.
//
// A link on another host with a server chosen goes through: the self-hosted
// case. A link typed without its scheme is read as https, and one whose host
// cannot be read is a mismatch, a server chosen or not: https:///floe.one/r/...,
// https:/floe.one/... and /floe.one/... parse with no host, and a browser
// reads each as floe.one (FU-53 review 1 L-2).
func LinkServerMismatch(link string, serverChosen bool, server string) bool {
	link = strings.TrimSpace(link)
	u, err := url.Parse(link)
	if err == nil && u.Scheme == "" && u.Host == "" {
		u, err = url.Parse("https://" + link)
	}
	if err != nil || u.Hostname() == "" {
		return true
	}
	if IsFloeOneLinkHost(u.Hostname()) {
		return !IsFloeOneServer(server)
	}
	return !serverChosen
}

// IsFloeOneLinkHost reports whether a link's host is floe.one or
// www.floe.one, the web app whose links hold rooms on api.floe.one alone, as
// a browser reads the host: through IDNA's lookup mapping (UTS 46, what a
// browser applies before it resolves a name), so fullwidth letters and dots,
// the ideographic full stop, circled letters and a soft hyphen all read as
// the ASCII they map to (FU-46 review 1 N1), then in any case and with one
// trailing dot (a fully qualified name reaches the same host). A host the
// mapping refuses is compared as written, lower-cased; none of those maps to
// floe.one. The request-link send (LinkServerMismatch) and receive
// (runReceive) both decide by it.
func IsFloeOneLinkHost(host string) bool {
	h := strings.ToLower(host)
	if ascii, err := idna.Lookup.ToASCII(host); err == nil {
		h = ascii
	}
	switch strings.TrimSuffix(h, ".") {
	case "floe.one", "www.floe.one":
		return true
	}
	return false
}

// IsFloeOneServer reports whether server is floe.one's signaling server, the
// --server default and the only server that holds the room of a link made on
// floe.one, in any spelling that reaches it: once normalized, https (url.Parse
// lower-cases the scheme), the host api.floe.one in any case and with one
// trailing dot, port empty or 443, path empty or "/", and no userinfo, query
// or fragment (FU-46 review 1 N4; an exact string compare refused
// https://API.floe.one and https://api.floe.one:443, which used to work).
// Anything else, http, another port, a path the requests would be appended
// to, is not, and a floe.one link with it ends on TL-10.
func IsFloeOneServer(server string) bool {
	s := serverurl.Normalize(server)
	if strings.ContainsAny(s, "?#") {
		return false
	}
	u, err := url.Parse(s)
	if err != nil || u.Scheme != "https" || u.Opaque != "" || u.User != nil {
		return false
	}
	if u.Path != "" && u.Path != "/" {
		return false
	}
	if strings.HasSuffix(u.Host, ":") {
		return false
	}
	if port := u.Port(); port != "" && port != "443" {
		return false
	}
	return strings.TrimSuffix(strings.ToLower(u.Hostname()), ".") == "api.floe.one"
}

// LinkServer is CheckLinkServer's answer.
type LinkServer int

const (
	// LinkServerOK: a code, or a link the chosen server can hold.
	LinkServerOK LinkServer = iota
	// LinkFloeOneOtherServer: a floe.one link with another server chosen,
	// which never held the link's room.
	LinkFloeOneOtherServer
	// LinkOtherNoServer: a link on another host with no server chosen, so the
	// room id would go to api.floe.one, which never held it.
	LinkOtherNoServer
)

// CheckLinkServer is LinkServerMismatch for an input that may be a code: the
// receive side of the rule, for floe receive and Floe Desktop, before any
// network call. It reads the host as LinkHost does (a code has none and is
// never refused here), and names which way the two disagree so each caller
// can show its own line. A link on another host with a server chosen goes
// through, the self-hosted case, as it does for the request-link send.
func CheckLinkServer(input string, serverChosen bool, server string) LinkServer {
	host := LinkHost(input)
	switch {
	case host == "":
		return LinkServerOK
	case IsFloeOneLinkHost(host):
		if IsFloeOneServer(server) {
			return LinkServerOK
		}
		return LinkFloeOneOtherServer
	case !serverChosen:
		return LinkOtherNoServer
	}
	return LinkServerOK
}
