package code

import "testing"

// TestLinkServerMismatch is the rule's table, moved with it from
// cli/cmd/floe/sendto_test.go (TestSendToOtherServerLinkEndsWithoutANetworkCall
// keeps the part that runs the command).
func TestLinkServerMismatch(t *testing.T) {
	room := "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	other := "https://files.example.com/floe/r/Xk3p9Q0aB1c#" + room
	const (
		floeServer = "https://api.floe.one"
		selfHosted = "https://files.example.com"
	)
	floe := "https://floe.one/r/Xk3p9Q0aB1c#" + room
	for _, c := range []struct {
		link   string
		chosen bool
		server string
		want   bool
	}{
		{other, false, floeServer, true},
		{other, true, selfHosted, false},
		{floe, false, floeServer, false},
		{"https://WWW.floe.one/r/Xk3p9Q0aB1c#" + room, false, floeServer, false},
		{"floe.one/r/Xk3p9Q0aB1c#" + room, false, floeServer, false},
		{"https://floe.one./r/Xk3p9Q0aB1c#" + room, false, floeServer, false},
		{"https://floe.one.example.com/r/Xk3p9Q0aB1c#" + room, false, floeServer, true},
		{"http://localhost:3000/r/Xk3p9Q0aB1c#" + room, false, floeServer, true},
		// F5-4: a floe.one link with a server chosen goes through only when
		// that server is api.floe.one once normalized.
		{floe, true, floeServer, false},
		{floe, true, " https://api.floe.one// ", false},
		{floe, true, selfHosted, true},
		{floe, true, "http://127.0.0.1:3001", true},
		{floe, true, "https://floe.one", true},
		{floe, true, "http://api.floe.one", true},
		{floe, true, "https://api.floe.one.example.com", true},
		// N4 (FU-46 review 1): api.floe.one is compared parsed, so every
		// spelling that reaches it goes through (https in any case, the host
		// in any case and with one trailing dot, port 443, no path) and
		// anything else still ends on TL-10.
		{floe, true, "https://API.floe.one", false},
		{floe, true, "HTTPS://Api.Floe.One", false},
		{floe, true, "https://api.floe.one:443", false},
		{floe, true, "https://api.floe.one.", false},
		{floe, true, " https://API.FLOE.ONE.:443/ ", false},
		{floe, true, "http://api.floe.one:443", true},
		{floe, true, "wss://api.floe.one", true},
		{floe, true, "api.floe.one", true},
		{floe, true, "//api.floe.one", true},
		{floe, true, "https://user@api.floe.one", true},
		{floe, true, "https://user:secret@api.floe.one", true},
		{floe, true, "https://api.floe.one:8443", true},
		{floe, true, "https://api.floe.one:80", true},
		{floe, true, "https://api.floe.one:", true},
		{floe, true, "https://api.floe.one/floe", true},
		{floe, true, "https://api.floe.one?x=1", true},
		{floe, true, "https://api.floe.one#x", true},
		{floe, true, "https://api.floe.one..", true},
		{floe, true, "https://xapi.floe.one", true},
		{floe, true, "https://floe.one.api.floe.one", true},
		{"https://www.floe.one/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		{"floe.one/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		{"https://floe.one./r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		// N1 (FU-46 review 1, FU-53): a host a browser maps to floe.one
		// (IDNA: fullwidth letters and dots, the ideographic full stop,
		// circled letters, a soft hyphen, a percent-encoded fullwidth letter)
		// is floe.one: with another server it ends on TL-10, with none it
		// goes to api.floe.one, where its room is.
		{"https://ｆｌｏｅ.one/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		{"https://www.ｆｌｏｅ.one/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		{"https://ＦＬＯＥ．ＯＮＥ/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		{"https://floe。one/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		{"https://ⓕⓛⓞⓔ.one/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		{"https://flo\u00ade.one/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		{"https://%EF%BD%86loe.one/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		{"https://ｆｌｏｅ.one/r/Xk3p9Q0aB1c#" + room, true, floeServer, false},
		{"https://ｆｌｏｅ.one/r/Xk3p9Q0aB1c#" + room, false, floeServer, false},
		{"https://ｆｌｏｅ.one.example.com/r/Xk3p9Q0aB1c#" + room, true, selfHosted, false},
		{"https://ｆｌｏｅ.one.example.com/r/Xk3p9Q0aB1c#" + room, false, floeServer, true},
		// FU-53 review 1 L-2: a link whose host url.Parse cannot read (the
		// slashes a browser reads past) is a mismatch with a server chosen
		// too, never the self-hosted case.
		{"https:///floe.one/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		{"https:/floe.one/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
		{"/floe.one/r/Xk3p9Q0aB1c#" + room, true, selfHosted, true},
	} {
		if got := LinkServerMismatch(c.link, c.chosen, c.server); got != c.want {
			t.Errorf("LinkServerMismatch(%q, %v, %q) = %v, want %v", c.link, c.chosen, c.server, got, c.want)
		}
	}
}

// TestCheckLinkServer is the receive side of the rule: which way a pasted
// link and the chosen server disagree, if they do. A code has no host and is
// never refused here.
func TestCheckLinkServer(t *testing.T) {
	const (
		floeServer = "https://api.floe.one"
		selfHosted = "https://files.example.com"
		room       = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	)
	floe := "https://floe.one/#room=" + room
	other := "https://files.example.com/#room=" + room
	for _, c := range []struct {
		input  string
		chosen bool
		server string
		want   LinkServer
	}{
		{"olive-tiger-castle", false, floeServer, LinkServerOK},
		{"olive-tiger-castle", true, selfHosted, LinkServerOK},
		{floe, false, floeServer, LinkServerOK},
		{floe, true, " https://API.floe.one:443/ ", LinkServerOK},
		{floe, true, selfHosted, LinkFloeOneOtherServer},
		{"https://www.ｆｌｏｅ.one/#room=" + room, true, selfHosted, LinkFloeOneOtherServer},
		{"https:///floe.one/#room=" + room, true, selfHosted, LinkFloeOneOtherServer},
		{other, true, selfHosted, LinkServerOK},
		{other, false, floeServer, LinkOtherNoServer},
		{"http://localhost:3000/#room=" + room, false, floeServer, LinkOtherNoServer},
		{"<" + other + ">", false, floeServer, LinkOtherNoServer},
	} {
		if got := CheckLinkServer(c.input, c.chosen, c.server); got != c.want {
			t.Errorf("CheckLinkServer(%q, %v, %q) = %v, want %v", c.input, c.chosen, c.server, got, c.want)
		}
	}
}

// TestResolveRefusesALinkWhoseHostCannotBeRead: Resolve takes a room id out of
// any input with "://" in it, and a link whose host LinkHost cannot read would
// pass CheckLinkServer as if it were a code, so its room id would go to
// whichever server is chosen. Such a link is refused before the room id is
// taken, with no network call (the server URL here is never dialed).
func TestResolveRefusesALinkWhoseHostCannotBeRead(t *testing.T) {
	const room = "6f1c2b9e-4a5d-4c3b-9f7e-2d1a0b9c8e7f"
	for _, in := range []string{
		"Link: https://floe.one/#room=" + room,
		"file:///floe.one/#room=" + room,
		"floe.one/?r=https://x#room=" + room,
	} {
		if id, err := Resolve("http://127.0.0.1:9", in); err == nil || id != "" {
			t.Errorf("Resolve(%q) = %q, %v; want no room id and an error", in, id, err)
		}
	}
	// Links whose host it can read still resolve, slash-mangled ones included.
	for _, in := range []string{
		"https://floe.one/#room=" + room,
		"https:///floe.one/#room=" + room,
		"files.example.com/?room=" + room,
	} {
		if id, err := Resolve("http://127.0.0.1:9", in); err != nil || id != room {
			t.Errorf("Resolve(%q) = %q, %v; want %q", in, id, err, room)
		}
	}
}
