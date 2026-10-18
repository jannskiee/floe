package main

// Telling a link typed where it does not belong (in a command's place, as a
// path, as a receive input) without ever printing it back: the room id in
// such a link is the key to a seat. main.go, send.go, receive.go and
// sendto.go all ask.

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
)

// firstWord is the index of the first argument that is neither a root flag nor
// a root flag's value, the word cobra reads as the command, or -1. A flag
// that takes a value (--server, --web, --iface) consumes the next argument
// unless it is written as --name=value.
func firstWord(args []string) int {
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			if i+1 < len(args) {
				return i + 1
			}
			return -1
		}
		if a == "" || a == "-" {
			// cobra drops both before it looks for the command, so the word
			// after them is the one it runs (W3 R5-08).
			continue
		}
		if !strings.HasPrefix(a, "-") {
			return i
		}
		name := strings.TrimLeft(a, "-")
		if strings.Contains(name, "=") {
			continue
		}
		if f := rootCmd.PersistentFlags().Lookup(name); f != nil && f.Value.Type() != "bool" {
			i++
		}
	}
	return -1
}

// errRoomLinkTypedAsCommand ends `floe <room link>`, the subcommand
// forgotten (A4-B21): cobra's unknown-command error quoted the link and its
// room id. execute prints it as an outcome, alone on the indent, and main
// exits 1. Fixed text in the form of errLinkTypedAsPath.
var errRoomLinkTypedAsCommand = errors.New("That looks like a link to receive from. To receive, use: floe receive <link>")

// linkTypedAsCommand is the outcome for a run that cobra would end on an
// unknown command whose name, the first argument that is not a root flag or
// a flag's value, is a link that carries a room id: errLinkTypedAsPath for a
// request link (looksLikeRequestLink), errRoomLinkTypedAsCommand for a room
// link (looksLikeRoomLink), nil for every other run. It asks cobra's own
// Find, which parses no flag and makes no network call; a run Find does not
// refuse, or refuses for another name, goes to cobra unchanged.
//
// `floe help <link>` is the same slip one word later: cobra adds its help
// command inside ExecuteC, and help answers an unknown topic with "Unknown
// help topic" and the link quoted, room id and all (deep QA A3-07). Find
// cannot see help yet, so the first word is read here.
func linkTypedAsCommand(args []string) error {
	if i := firstWord(args); i >= 0 && args[i] == "help" {
		for _, a := range args[i+1:] {
			if typed := linkAsCommand(a); typed != nil {
				return typed
			}
		}
	}
	cmd, _, err := rootCmd.Find(args)
	if err == nil || cmd != rootCmd {
		return nil
	}
	for _, a := range args {
		if typed := linkAsCommand(a); typed != nil && strings.Contains(err.Error(), strconv.Quote(a)) {
			return typed
		}
	}
	return nil
}

// linkAsCommand is linkTypedAsCommand's outcome for one argument. A request
// link is asked first: its fragment holds no room=, but a query can.
func linkAsCommand(a string) error {
	switch {
	case looksLikeRequestLink(a):
		return errLinkTypedAsPath
	case looksLikeRoomLink(a):
		return errRoomLinkTypedAsCommand
	}
	return nil
}

// looksLikeRoomLink reports whether arg is a room link, whole or cut short:
// "room=" after a # or a ? or an &, in any letter case, in arg as typed or
// with its percent escapes decoded, up to three times over (inAnyDecoding).
// A room id is not required after it, so a link cut short is caught too; a
// file name with "room=" in it is a command cobra would refuse anyway, and
// only the words of that refusal change.
func looksLikeRoomLink(arg string) bool {
	return inAnyDecoding(arg, func(s string) bool {
		l := strings.ToLower(s)
		for _, mark := range []string{"#room=", "?room=", "&room="} {
			if strings.Contains(l, mark) {
				return true
			}
		}
		return false
	})
}

// roomIDLead is a room id as the server's UUID_REGEX takes it (engine/code's
// uuidShape), anchored at the start only.
var roomIDLead = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)

// looksLikeRequestLink reports whether a path that could not be read is a
// request link, so that the send ends on a fixed line instead of the stat
// sentence, which quotes the path: a request link's fragment is its room id,
// the key to its one seat (FU-46, FU-32 F5-3). It is wider than
// code.ParseRequestLink, which takes only the exact /r/<link id> path, and
// takes every link that does: as code.Resolve refuses a request link in any
// shape, a room id after a # counts whatever comes before it, so a link id a
// character short or long, an extra path segment, or angle brackets or
// quotes around the link (they sit before the # and after the room id) still
// carry the key. Wider still, a # followed by a room id counts:
//   - wherever it is (a doubled #), and after spaces (a space typed after it);
//   - when only the start of what follows is a room id (a bad escape or
//     stray text after it);
//   - in the argument with its percent escapes decoded, up to three times
//     over, every valid one even beside a bad one: a # sent as %23, the shape
//     of a link inside a mail-safety redirector's ?url=, %2523 when that
//     redirector's link is wrapped again (FU-46 review 1 L2).
//
// A room link spells its fragment #room=, so none matches.
func looksLikeRequestLink(arg string) bool {
	return inAnyDecoding(arg, hashBeforeRoomID)
}

// inAnyDecoding reports whether match holds for arg as typed or with its
// percent escapes decoded, up to three times over: the decoding both link
// matchers apply (looksLikeRequestLink, looksLikeRoomLink).
func inAnyDecoding(arg string, match func(string) bool) bool {
	s := arg
	for range 4 {
		if match(s) {
			return true
		}
		decoded := percentDecodeLoose(s)
		if decoded == s {
			return false
		}
		s = decoded
	}
	return false
}

// hashBeforeRoomID reports whether any # in s is followed, after spaces or
// tabs, by a room id.
func hashBeforeRoomID(s string) bool {
	for {
		_, after, ok := strings.Cut(s, "#")
		if !ok {
			return false
		}
		if roomIDLead.MatchString(strings.TrimLeft(after, " \t")) {
			return true
		}
		s = after
	}
}

// percentDecodeLoose decodes every valid %XX escape in s and keeps every
// other byte as it is, so a bad escape does not hide the rest the way it
// makes url.PathUnescape fail.
func percentDecodeLoose(s string) string {
	if !strings.Contains(s, "%") {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+3], 16, 8); err == nil {
				b.WriteByte(byte(v))
				i += 2
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}
