// Command floe-rlvisitor is a test-only hostile request-link VISITOR, for the
// Floe Desktop QA cells (S1-DSK-08a CELL-07 and CELL-13, D-109 FT-17). Given a
// request link (or a room id and server), it takes the visitor seat through
// the frozen S1-ENG-07 signaling client and sends files the way the engine
// sender does, with hostile flags that drive the host's refusals: the D-033
// metadata fixtures (deep paths, absolute Windows paths, huge sizes, an
// over-cap name), a junk flood, a chosen abort reason, a hostile display name,
// a malformed SDP answer, relay-only ICE, and a skip of the visitor's own
// relay-cap gate so the host's refusal is live-tested.
//
// It never ships: .goreleaser.yml builds only cli/cmd/floe, and
// `go list -deps ./cmd/floe` names no rlvisitor symbol (a package main under
// internal is unimportable), which a manual `go tool nm` of the release binary
// confirms. It never reports stats (there
// is no stats path here at all), never reads FLOE_SERVER (the server is
// -server or the local default), refuses any -server that is not localhost, a
// loopback or a private IP (localServer), and never prints a host token or any
// part of the room fragment beyond what the operator passed on the command line.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/jannskiee/floe/cli/engine/code"
)

// config is the visitor's flags.
type config struct {
	server      string
	room        string
	send        []string // real files to send in the normal and relay-only modes
	relayOnly   bool
	hostileName bool
	junkFlood   bool
	abortReason string
	badSDP      bool
	hostileMeta string // "", or one of f2 f4b f5 f6
	skipGate    bool
	timeout     time.Duration
}

// mode is which single behavior a run performs, decided from the flags. Real
// modes send files; the rest write one crafted thing and observe.
type mode int

const (
	modeSend        mode = iota // real files (relayOnly narrows the ICE policy)
	modeHostileMeta             // one crafted metadata frame, no file
	modeHostileName             // one metadata frame with the hostile display name
	modeAbort                   // one incompatible frame with the chosen reason
	modeJunkFlood               // a flood of junk control frames
	modeBadSDP                  // a malformed SDP answer, no offer accepted
	modeSkipGate                // announce an oversize file past the visitor's own relay gate
)

// mode reports the single behavior these flags select, or an error if they ask
// for more than one hostile behavior at once.
func (c config) mode() (mode, error) {
	var chosen []mode
	if c.hostileMeta != "" {
		chosen = append(chosen, modeHostileMeta)
	}
	if c.hostileName {
		chosen = append(chosen, modeHostileName)
	}
	if c.abortReason != "" {
		chosen = append(chosen, modeAbort)
	}
	if c.junkFlood {
		chosen = append(chosen, modeJunkFlood)
	}
	if c.badSDP {
		chosen = append(chosen, modeBadSDP)
	}
	if c.skipGate {
		chosen = append(chosen, modeSkipGate)
	}
	switch len(chosen) {
	case 0:
		if len(c.send) == 0 {
			return 0, errors.New("nothing to do: pass -send or one hostile flag")
		}
		return modeSend, nil
	case 1:
		return chosen[0], nil
	default:
		return 0, errors.New("choose at most one hostile behavior")
	}
}

const defaultServer = "http://127.0.0.1:3001"

var errNotLocalServer = errors.New("rlvisitor: -server must be http(s)://<localhost, a loopback or a private IP>[:port]")

// localServer refuses any -server that is not on this machine or its private
// network, so this tool can never be aimed at api.floe.one or any public host,
// whatever is typed (S1-DSK-08a: the hostile stub runs only on localhost). The
// host must be localhost, a loopback IP literal, or a private IP literal
// (RFC 1918, or an IPv6 ULA in fc00::/7); a private literal keeps the WSL host
// address of FI-07 working. No other name is accepted, because a name can
// resolve anywhere. The URL must be bare (scheme, host, optional port, at most
// a trailing slash, which is dropped), because signaling.Connect and
// ice.FetchDetail build their URLs by appending to this string.
func localServer(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return "", errNotLocalServer
	}
	if u.User != nil || u.Opaque != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" ||
		(u.Path != "" && u.Path != "/") {
		return "", errNotLocalServer
	}
	host := u.Hostname()
	if !strings.EqualFold(host, "localhost") {
		ip := net.ParseIP(host)
		if ip == nil || !(ip.IsLoopback() || ip.IsPrivate()) {
			return "", errNotLocalServer
		}
	}
	return u.Scheme + "://" + u.Host, nil
}

// parseFlags reads the visitor's flags. It never reads FLOE_SERVER: the server
// comes from a request link, -server, or the local default, so no environment
// can point the stub at production.
func parseFlags(args []string) (config, error) {
	fs := flag.NewFlagSet("rlvisitor", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	link := fs.String("link", "", "request link (floe.one/r/<id>#<roomId>); its server is not used, only its room id")
	server := fs.String("server", defaultServer, "signaling server base URL: localhost, a loopback or a private IP only")
	room := fs.String("room", "", "room id (the link's fragment), if no -link is given")
	send := fs.String("send", "", "comma-separated files or folders to send (normal and relay-only modes)")
	relayOnly := fs.Bool("relay-only", false, "force the TURN relay (Hide my IP)")
	hostileName := fs.Bool("hostile-name", false, "send one file whose name is markup, a shell substitution and a bidi override")
	junkFlood := fs.Bool("junk-flood", false, "flood the host with junk control frames")
	abortReason := fs.String("abort-reason", "", "send one incompatible frame carrying this reason text")
	badSDP := fs.Bool("bad-sdp", false, "answer with a malformed SDP instead of a real one")
	hostileMeta := fs.String("hostile-meta", "", "send one D-033 metadata fixture: f2, f4b, f5 or f6")
	skipGate := fs.Bool("skip-relay-gate", false, "skip the visitor's own relay-cap gate and announce an oversize file")
	// Default past the visitor's own ack clock (10 min 15 s) so a -send whose
	// Accept is held for the full window is never killed as a timeout before the
	// host's decision window closes; CELL-05's idle hold relies on it (review Q7).
	timeout := fs.Duration("timeout", visitorAckTimeout+2*time.Minute, "overall deadline for the run")
	if err := fs.Parse(args); err != nil {
		return config{}, err
	}
	if fs.NArg() != 0 || *timeout <= 0 {
		return config{}, errors.New("rlvisitor: usage")
	}

	roomID := strings.TrimSpace(*room)
	srv, err := localServer(*server)
	if err != nil {
		return config{}, err
	}
	if *link != "" {
		_, r, err := code.ParseRequestLink(*link)
		if err != nil {
			// The error holds no part of the input, so this cannot leak it.
			return config{}, fmt.Errorf("bad -link: %w", err)
		}
		roomID = r
	}
	if roomID == "" {
		return config{}, errors.New("give -link or -room")
	}
	if *hostileMeta != "" && !hostileMetaKinds[*hostileMeta] {
		return config{}, fmt.Errorf("rlvisitor: -hostile-meta names no fixture: %q", *hostileMeta)
	}

	cfg := config{
		server:      srv,
		room:        roomID,
		relayOnly:   *relayOnly,
		hostileName: *hostileName,
		junkFlood:   *junkFlood,
		abortReason: *abortReason,
		badSDP:      *badSDP,
		hostileMeta: *hostileMeta,
		skipGate:    *skipGate,
		timeout:     *timeout,
	}
	if s := strings.TrimSpace(*send); s != "" {
		for _, p := range strings.Split(s, ",") {
			if p = strings.TrimSpace(p); p != "" {
				cfg.send = append(cfg.send, p)
			}
		}
	}
	if _, err := cfg.mode(); err != nil {
		return config{}, err
	}
	return cfg, nil
}

// The exit codes, one per outcome kind, so a QA driver can tell a host's
// refusal from a transport failure without parsing text. usageText documents
// them; TestUsageTextNamesEveryExitCode keeps the two in step.
const (
	exitDelivered   = 0 // -send: the host said received after committing every file
	exitFailed      = 1 // a local, signaling, ICE or transport failure, the -timeout watchdog, or a stop the engine could not name
	exitUsage       = 2 // bad flags, including a -server that is not local or private
	exitPeerRefused = 3 // the host refused with a code (the event's "code" is the parsed code, or "other")
	exitRelayGate   = 4 // -send: the visitor's own relay gate blocked before any file byte moved
	exitHostClosed  = 5 // the host closed without a refusal code: a crafted mode (-bad-sdp: the host left), or -send after the last byte with no received
	exitBound       = 6 // crafted modes: the wait bound ran out and the host had not ended it
	exitNotJoined   = 7 // the server did not seat this visitor (host-absent, room-full, refused, ...): CELL-06 tells it from a transport failure by the code
)

// usageText goes to stderr on a usage error. Stdout carries the JSON event
// lines, plus a few plain lines the engine prints itself (the ICE fetch's
// Warning, and the sender's Peer version line and summary box), so a driver
// skips any line that is not JSON.
const usageText = `floe-rlvisitor: a test-only hostile request-link visitor. It never ships and
refuses any -server that is not localhost, a loopback or a private IP.

  floe-rlvisitor (-link <url> | -room <uuid>) [-server <url>] [-timeout <d>]
                 (-send <a,b> [-relay-only] | one hostile flag)

Hostile flags (one per run): -hostile-meta f2|f4b|f5|f6, -hostile-name,
-abort-reason <text>, -junk-flood, -bad-sdp, -skip-relay-gate.

Exit codes (the last event line names the same word):
  0  delivered: -send, the host said received after committing every file
  1  failed: a local, signaling, ICE or transport failure, the timeout, or an unnamed stop
  2  usage: bad flags, or a -server that is not local or private
  3  peer-refused: the host refused; "code" is its refusal code or other, "sentence" the engine's fixed text
  4  relay-gate: -send, the visitor's own relay gate blocked before any file byte moved
  5  host-closed: the host closed without a code: a crafted mode (-bad-sdp: the host left),
     or -send after the last byte and before the host said received
  6  bound: a crafted mode, the wait ran out and the host had not ended it
  7  not-joined: the server did not seat this visitor; "result" is the client's fixed answer word
`

func main() {
	cfg, err := parseFlags(os.Args[1:])
	if err != nil {
		emit(map[string]interface{}{"event": "error", "stage": "usage"})
		_, _ = os.Stderr.WriteString(usageText)
		os.Exit(exitUsage)
	}
	os.Exit(run(cfg))
}
