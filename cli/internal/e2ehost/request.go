package main

// Request mode (S1-ENG-09): a request-link host without the Wails app, for
// the Playwright request-link spec. It makes a fresh host token, joins the
// reserved room the token derives through the frozen S1-ENG-07 client, prints
// the link, and then, per visit: waits for user-connected, makes the offer
// (SetupAsSender), seals the room when the channel opens and receives with a
// scripted Decide. It sends request-reopen after a refusal when told to keep
// waiting, and request-close at the end.
//
// Everything that makes it a test peer lives in this file and never in the
// engine: the scripted Decide, the shortened decide window of -fast-timers,
// the socket blip of -blip-after, and -corrupt-hash, which rewrites the
// sender's end-frame digest on its way from the data channel to the engine so
// the engine's own compare refuses the file. The release floe binary cannot
// reach any of it (.goreleaser.yml builds only ./cmd/floe).
//
// Output: the events of main.go's contract plus the link, whose only variable
// parts are the link id and the room id this process generated. The host
// token is never printed; the stats URL is always empty.

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/jannskiee/floe/cli/engine/ice"
	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/jannskiee/floe/cli/engine/transfer"
	"github.com/pion/webrtc/v4"
)

// fastDecideWindow replaces transfer.HostDecisionWindow under -fast-timers,
// so a "never" step answers expired in seconds instead of 9 min 45 s.
const fastDecideWindow = 5 * time.Second

// Liveness the way the desktop's request lane sets it (S1-DSK-03).
const (
	requestPing         = 25 * time.Second
	requestReadDeadline = 60 * time.Second
)

// blipEvents are the events -blip-after may name: the ones a visit passes
// through before its outcome.
var blipEvents = map[string]bool{
	"joined": true, "link": true, "user-connected": true, "offer-sent": true,
	"sealed": true, "deciding": true, "accepted": true, "file-committed": true,
	"refused": true, "reopened": true,
}

// decideStep is one visit's scripted answer.
type decideStep struct {
	kind  transfer.DecisionKind // accept, decline or refuse; unused for never
	code  transfer.RefusalCode  // refuse only
	delay time.Duration         // how long before answering
	never bool                  // never answer: the decide window or the visitor's leaving ends it
}

// parseDecideStep reads one of accept, decline, delay:<ms> (accept after
// that many milliseconds), never, refuse:<code> (a RefusalCode this build
// knows). Anything else is an error, so a typo in a spec fails at start.
func parseDecideStep(s string) (decideStep, error) {
	switch {
	case s == "accept":
		return decideStep{kind: transfer.DecisionAccept}, nil
	case s == "decline":
		return decideStep{kind: transfer.DecisionDecline}, nil
	case s == "never":
		return decideStep{never: true}, nil
	case strings.HasPrefix(s, "delay:"):
		ms, err := strconv.Atoi(strings.TrimPrefix(s, "delay:"))
		if err != nil || ms < 0 {
			return decideStep{}, fmt.Errorf("decide: bad delay in %q", s)
		}
		return decideStep{kind: transfer.DecisionAccept, delay: time.Duration(ms) * time.Millisecond}, nil
	case strings.HasPrefix(s, "refuse:"):
		code, ok := transfer.ParseRefusalCode(strings.TrimPrefix(s, "refuse:"))
		if !ok {
			return decideStep{}, fmt.Errorf("decide: unknown refusal code in %q", s)
		}
		return decideStep{kind: transfer.DecisionRefuse, code: code}, nil
	}
	return decideStep{}, fmt.Errorf("decide: unknown step %q", s)
}

// parseDecideScript reads a comma-separated list of steps, one per visit;
// the last step repeats for every later visit ("decline,accept" declines the
// first visit and accepts the rest, with -keep-waiting between them).
func parseDecideScript(spec string) ([]decideStep, error) {
	var steps []decideStep
	for _, s := range strings.Split(spec, ",") {
		step, err := parseDecideStep(strings.TrimSpace(s))
		if err != nil {
			return nil, err
		}
		steps = append(steps, step)
	}
	return steps, nil
}

// answer waits out the step and returns its Decision. The decide window is
// the host's own deadline, which answers expired the way the desktop does;
// the visitor's channel closing answers decline, because ReceiveOptions.Decide
// must return when Closed fires, and the engine then reports ErrSenderLeft.
func (s decideStep) answer(window time.Duration, closed <-chan struct{}) transfer.Decision {
	var ready <-chan time.Time
	if !s.never {
		t := time.NewTimer(s.delay)
		defer t.Stop()
		ready = t.C
	}
	deadline := time.NewTimer(window)
	defer deadline.Stop()
	select {
	case <-ready:
		return transfer.Decision{Kind: s.kind, Code: s.code}
	case <-deadline.C:
		return transfer.Decision{Kind: transfer.DecisionRefuse, Code: transfer.CodeExpired}
	case <-closed:
		return transfer.Decision{Kind: transfer.DecisionDecline}
	}
}

// requestConfig is request mode's flags.
type requestConfig struct {
	server       string
	web          string
	out          string
	steps        []decideStep
	decideWindow time.Duration
	keepWaiting  bool
	corruptHash  bool
	blipAfter    string
	timeout      time.Duration
}

// parseRequestFlags reads request mode's flags. It never reads FLOE_SERVER:
// the server is -server or the local default, so a harness can never be
// pointed at production by the environment it runs in.
func parseRequestFlags(args []string) (requestConfig, error) {
	fs := flag.NewFlagSet("request", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	server := fs.String("server", "http://127.0.0.1:3001", "signaling server base URL")
	web := fs.String("web", "http://localhost:3000", "web app base URL, for the printed link")
	out := fs.String("out", "", "directory received files are written to (required)")
	decide := fs.String("decide", "accept", "comma-separated Decide steps, one per visit")
	fast := fs.Bool("fast-timers", false, "shorten the decide window to 5s")
	keep := fs.Bool("keep-waiting", false, "send request-reopen after a refused visit and wait for the next")
	corrupt := fs.Bool("corrupt-hash", false, "change one hex digit of each end-frame digest before the engine reads it")
	blip := fs.String("blip-after", "", "drop and reclaim the host socket right after this event")
	timeout := fs.Duration("timeout", 2*time.Minute, "overall deadline for the whole run")
	if err := fs.Parse(args); err != nil {
		return requestConfig{}, err
	}
	if fs.NArg() != 0 || *out == "" || *timeout <= 0 {
		return requestConfig{}, errors.New("request: usage")
	}
	if *blip != "" && !blipEvents[*blip] {
		return requestConfig{}, fmt.Errorf("request: -blip-after names no event: %q", *blip)
	}
	steps, err := parseDecideScript(*decide)
	if err != nil {
		return requestConfig{}, err
	}
	window := transfer.HostDecisionWindow
	if *fast {
		window = fastDecideWindow
	}
	return requestConfig{
		server: *server, web: strings.TrimRight(*web, "/"), out: *out, steps: steps,
		decideWindow: window, keepWaiting: *keep, corruptHash: *corrupt,
		blipAfter: *blip, timeout: *timeout,
	}, nil
}

// corruptEndFrame rewrites the sha256 of an end frame to a digest that is
// well formed and cannot match, the P0-27 hashCorrupt change, and reports
// whether it did. Every other frame, and an end frame without a string
// sha256, comes back untouched.
func corruptEndFrame(data []byte) ([]byte, bool) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil {
		return data, false
	}
	var typ, digest string
	if json.Unmarshal(fields["type"], &typ) != nil || typ != "end" {
		return data, false
	}
	if json.Unmarshal(fields["sha256"], &digest) != nil || digest == "" {
		return data, false
	}
	fields["sha256"], _ = json.Marshal(flipFirstHexDigit(digest))
	out, err := json.Marshal(fields)
	if err != nil {
		return data, false
	}
	return out, true
}

// corruptingPump sits between the data channel's early pump and the engine
// and passes every message on in order, end frames with their digest
// corrupted. It stops when the channel closes, after handing on what was
// already queued.
func corruptingPump(in <-chan webrtc.DataChannelMessage, closed <-chan struct{}) <-chan webrtc.DataChannelMessage {
	out := make(chan webrtc.DataChannelMessage, cap(in))
	pass := func(m webrtc.DataChannelMessage) bool {
		if data, ok := corruptEndFrame(m.Data); ok {
			m.Data = data
		}
		select {
		case out <- m:
			return true
		case <-closed:
			return false
		}
	}
	go func() {
		for {
			select {
			case m := <-in:
				if !pass(m) {
					return
				}
			case <-closed:
				for {
					select {
					case m := <-in:
						select {
						case out <- m:
						default:
							return
						}
					default:
						return
					}
				}
			}
		}
	}()
	return out
}

// requestHost is one request-mode run.
type requestHost struct {
	cfg   requestConfig
	ev    *events
	token string // the host token: memory only, never printed
	room  string
	sc    *signaling.Client
	// blipped is set once the -blip-after cue has fired, so it fires once.
	blipped bool
	// files and verified count committed files for the done event.
	files    int
	verified int
}

// emit writes one event and fires the blip cue when this is its event. Every
// emit runs on the main goroutine (the engine calls Decide and OnFileDone
// synchronously on its receive loop), so the swap of h.sc is never
// concurrent with its use.
func (h *requestHost) emit(name string, fields map[string]interface{}) {
	e := map[string]interface{}{"event": name}
	for k, v := range fields {
		e[k] = v
	}
	h.ev.emit(e)
	if h.cfg.blipAfter == name && !h.blipped {
		h.blipped = true
		h.blip()
	}
}

// connect opens a signaling client and claims the room with the token.
func (h *requestHost) connect() *signaling.Client {
	sc, err := signaling.Connect(h.cfg.server, signaling.WithLiveness(requestPing, requestReadDeadline))
	if err != nil {
		h.ev.fail("connect")
	}
	res, err := sc.JoinRoomWithToken(h.room, h.token)
	if err != nil || res != signaling.HostJoined {
		sc.Close()
		h.ev.emit(map[string]interface{}{"event": "error", "stage": "join", "result": res.String()})
		h.ev.exit(1)
	}
	return sc
}

// blip drops the host socket and claims the room again with the same token,
// the way a laptop's network flap looks to the server; a data channel that is
// already open is not touched.
func (h *requestHost) blip() {
	h.sc.Close()
	h.ev.emit(map[string]interface{}{"event": "blip"})
	h.sc = h.connect()
	h.ev.emit(map[string]interface{}{"event": "rejoined"})
}

// visitOutcome is how one visit ended.
type visitOutcome int

const (
	visitDelivered visitOutcome = iota + 1
	visitRefused
)

// refusalWord is the code a refused visit reports: always a constant this
// side chose or a fixed word, never anything the visitor sent.
func refusalWord(err error) (string, bool) {
	var re *transfer.RefusedError
	switch {
	case errors.As(err, &re):
		if re.Code == "" {
			return string(transfer.CodeStopped), true
		}
		return string(re.Code), true
	case errors.Is(err, transfer.ErrDeclined):
		return string(transfer.CodeDeclined), true
	case errors.Is(err, transfer.ErrSenderLeft):
		return "sender-left", true
	case errors.Is(err, peer.ErrPeerLeft):
		return "peer-left", true
	}
	return "", false
}

// visit runs one visitor from user-connected to its outcome.
func (h *requestHost) visit(step decideStep) visitOutcome {
	select {
	case <-h.sc.PeerConnected:
	case <-h.sc.Refused:
		h.ev.fail("refused-while-waiting")
	case <-h.sc.Down:
		h.ev.fail("signaling")
	}
	h.emit("user-connected", nil)

	servers, _, err := ice.FetchDetail(h.cfg.server)
	if err != nil {
		h.ev.fail("ice")
	}
	conn, err := peer.New(servers, h.sc)
	if err != nil {
		h.ev.fail("peer")
	}
	defer conn.Close()

	// SetupAsSender writes the offer in its first milliseconds and then waits
	// for the answer; the harness cannot see the write itself, so the event
	// marks the call.
	h.emit("offer-sent", nil)
	dc, err := conn.SetupAsSender()
	if err != nil {
		if word, ok := refusalWord(err); ok {
			h.emit("refused", map[string]interface{}{"code": word})
			return visitRefused
		}
		h.ev.fail("setup")
	}
	if err := h.sc.RequestSeal(); err != nil {
		h.ev.fail("seal")
	}
	h.emit("sealed", nil)
	emitRoute(h.ev, conn.ConnectionType)

	early := conn.Early()
	msgs := early.Msgs
	if h.cfg.corruptHash {
		msgs = corruptingPump(early.Msgs, early.Closed)
	}
	err = transfer.ReceiveFilesWithOptions(dc, h.cfg.out, true, "e2ehost", "", transfer.ReceiveOptions{
		OnProgress: func(transfer.Progress) {},
		Decide: func(in transfer.IncomingInfo) transfer.Decision {
			// A count only: the names and sizes are the visitor's.
			h.emit("deciding", map[string]interface{}{"files": in.Files})
			d := step.answer(h.cfg.decideWindow, early.Closed)
			if d.Kind == transfer.DecisionAccept {
				h.emit("accepted", nil)
			}
			return d
		},
		OnFileDone: func(fd transfer.FileDone) {
			h.files++
			if fd.Verified {
				h.verified++
			}
			h.emit("file-committed", map[string]interface{}{"verified": fd.Verified})
		},
		Messages: msgs,
		Closed:   early.Closed,
	})
	if err != nil {
		if word, ok := refusalWord(err); ok {
			h.emit("refused", map[string]interface{}{"code": word})
			return visitRefused
		}
		h.ev.fail("receive")
	}
	return visitDelivered
}

// runRequest is request mode's entry.
func runRequest(ev *events, args []string) {
	cfg, err := parseRequestFlags(args)
	if err != nil {
		ev.usage()
	}
	token, err := signaling.NewHostToken()
	if err != nil {
		ev.fail("token")
	}
	linkID, err := signaling.NewLinkID()
	if err != nil {
		ev.fail("token")
	}
	h := &requestHost{cfg: cfg, ev: ev, token: token, room: signaling.RoomIDFromToken(token)}

	watchdog := time.AfterFunc(cfg.timeout, func() { ev.fail("timeout") })

	h.sc = h.connect()
	h.emit("joined", map[string]interface{}{"role": "host", "roomId": h.room})
	h.emit("link", map[string]interface{}{"link": cfg.web + "/r/" + linkID + "#" + h.room})

	for n := 0; ; n++ {
		step := cfg.steps[len(cfg.steps)-1]
		if n < len(cfg.steps) {
			step = cfg.steps[n]
		}
		if h.visit(step) == visitDelivered || !cfg.keepWaiting {
			break
		}
		// A stale peer-disconnected from the visit that just ended must not
		// end the next visit's setup before it starts.
		select {
		case <-h.sc.PeerLeft:
		default:
		}
		if err := h.sc.RequestReopen(); err != nil {
			ev.fail("reopen")
		}
		h.emit("reopened", nil)
	}

	if err := h.sc.RequestClose(); err != nil {
		ev.fail("close")
	}
	h.emit("closed", nil)
	watchdog.Stop()
	ev.emit(map[string]interface{}{"event": "done", "files": h.files, "verified": h.verified})
	h.sc.Close()
	ev.exit(0)
}
