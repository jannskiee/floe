package main

// The network wiring. It mirrors the request-mode visitor of e2ehost and the
// browser visitor: request-join through the frozen S1-ENG-07 client, build the
// peer (relay-only when asked), then either send real files through the engine
// sender or write one crafted thing and observe. The crafted modes are how the
// host's refusals are driven; the real modes prove a legitimate relay drop.
//
// Everything the operator sees is a JSON event line. No file byte, token or
// room fragment beyond the operator's own input is ever printed.

import (
	"encoding/json"
	"errors"
	"os"
	"time"

	"github.com/jannskiee/floe/cli/engine/ice"
	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/jannskiee/floe/cli/engine/transfer"
	"github.com/pion/webrtc/v4"
)

// visitorAckTimeout is the wait the visitor gives the host's ack: the same
// clock as the CLI visitor and the /r page, so the host's own decision window
// (9 min 45 s) always ends first (M-04).
var visitorAckTimeout = transfer.VisitorAckTimeout + transfer.VisitorAckGrace

var stdout = os.Stdout

// emit writes one event line to stdout as JSON.
func emit(fields map[string]interface{}) {
	b, err := json.Marshal(fields)
	if err != nil {
		return
	}
	b = append(b, '\n')
	_, _ = stdout.Write(b)
}

// fail emits an error event at a stage and exits non-zero. The stage is a
// fixed word; no peer text or path is ever attached.
func fail(stage string) int {
	emit(map[string]interface{}{"event": "error", "stage": stage})
	return exitFailed
}

// run performs the one behavior the flags selected and returns the process
// exit code.
func run(cfg config) int {
	m, err := cfg.mode()
	if err != nil {
		return fail("usage")
	}

	sc, err := signaling.Connect(cfg.server)
	if err != nil {
		return fail("connect")
	}
	defer sc.Close()

	res, err := sc.RequestJoin(cfg.room)
	if err != nil || res != signaling.VisitorJoined {
		// The result word is the client's own fixed enum, never server text.
		emit(map[string]interface{}{"event": "not-joined", "result": res.String()})
		return exitFailed
	}
	emit(map[string]interface{}{"event": "joined"})

	watchdog := time.AfterFunc(cfg.timeout, func() {
		emit(map[string]interface{}{"event": "error", "stage": "timeout"})
		os.Exit(exitFailed)
	})
	defer watchdog.Stop()

	// -bad-sdp answers before any peer is built: it waits for the host's offer,
	// sends a malformed answer in its place, and holds the socket open so the
	// host's SetRemoteDescription runs against it and reports its own fixed
	// setup error. Sending before the offer let the host's E-39 signal drain
	// swallow the answer, so the host reached SetRemoteDescription only some of
	// the time (review Q4).
	if m == modeBadSDP {
		ended, sent, err := badSDPExchange(sc.Signal, func() error { return sc.SendSignal(badSDPSignal()) }, sc.PeerLeft, craftedWait, craftedWait)
		if err != nil {
			return fail("signal")
		}
		emit(map[string]interface{}{"event": "bad-sdp-sent", "ended": ended, "sent": sent})
		switch ended {
		case "no-offer":
			return exitFailed
		case "host-left":
			return exitHostClosed
		}
		return exitBound
	}

	var opts []peer.Option
	if cfg.relayOnly || m == modeSkipGate {
		opts = append(opts, peer.WithRelayOnly())
	}
	var servers []webrtc.ICEServer
	if cfg.relayOnly || m == modeSkipGate {
		// A relay path needs the server's ICE list; a direct drop uses none,
		// as the loopback tests do. The credentials are never printed.
		s, degraded, ferr := ice.FetchDetail(cfg.server)
		if ferr != nil {
			return fail("ice")
		}
		// Refuse now if the list cannot carry a relay, as the desktop's
		// requireRelay does, rather than letting the run die at the connect
		// timeout, which reads like a host defect (review Q6).
		if !usableRelay(s, degraded) {
			return fail("no-relay")
		}
		servers = s
	}
	conn, err := peer.New(servers, sc, opts...)
	if err != nil {
		return fail("peer")
	}
	defer conn.Close()

	dc, err := conn.SetupAsReceiver()
	if err != nil {
		return fail("setup")
	}
	early := conn.Early()
	emit(map[string]interface{}{"event": "connected", "route": routeWord(conn)})

	switch m {
	case modeSend:
		return runSend(dc, cfg, early)
	case modeHostileMeta:
		frame, _ := hostileMetaFrame(cfg.hostileMeta)
		return runCraftedFrame(dc, early, "hostile-meta", frame)
	case modeHostileName:
		return runCraftedFrame(dc, early, "hostile-name", oneFileMeta(hostileDisplayName(), 4))
	case modeSkipGate:
		return runCraftedFrame(dc, early, "skip-relay-gate", oversizeRelayMeta())
	case modeAbort:
		return runCraftedFrame(dc, early, "abort-reason", abortFrame(cfg.abortReason))
	case modeJunkFlood:
		return runJunkFlood(dc, early)
	}
	return fail("mode")
}

// usableRelay reports whether a fetched ICE list can carry a relay-only run:
// it is the server's own list (not the STUN-only fallback, degraded) and
// offers a TURN relay. The relay modes need one.
func usableRelay(servers []webrtc.ICEServer, degraded bool) bool {
	return !degraded && ice.HasRelay(servers)
}

// routeWord is the selected ICE path, "relay" or "direct", read from the
// connection.
func routeWord(conn *peer.Connection) string {
	route, err := conn.ConnectionType()
	if err != nil {
		return "unknown"
	}
	return route
}

// runSend sends real files as the engine sender does, through the visitor's ack
// clock. relay-only narrowed the ICE policy above.
func runSend(dc *webrtc.DataChannel, cfg config, early *peer.Early) int {
	emit(map[string]interface{}{"event": "sending", "files": len(cfg.send)})
	err := transfer.SendFilesWithOptions(dc, cfg.send, "rlvisitor", transfer.SendOptions{
		OnProgress: func(transfer.Progress) {},
		AckTimeout: visitorAckTimeout,
		Messages:   early.Msgs,
		Closed:     early.Closed,
	})
	ev, exit := sendOutcome(err)
	emit(ev)
	return exit
}

// sendOutcome is the send-ended event and exit code for the error the engine
// sender returned. The host's refusal arrives as a *PeerStoppedError whose Code
// the engine already passed through ParseRefusalCode; it is checked again here
// (anything unknown prints "other") and printed with PeerStoppedError.Error(),
// one fixed sentence per code with no peer text in it (refusal.go). The
// visitor's own relay gate prints that gate's sentence, which holds only local
// numbers (TL-11). Any other error prints the word "failed" and never its text,
// which can carry a local path or a peer's version string.
func sendOutcome(err error) (map[string]interface{}, int) {
	ev := map[string]interface{}{"event": "send-ended"}
	var stopped *transfer.PeerStoppedError
	switch {
	case err == nil:
		ev["outcome"] = "delivered"
		return ev, exitDelivered
	case errors.As(err, &stopped):
		code := "other"
		if c, ok := transfer.ParseRefusalCode(string(stopped.Code)); ok {
			code = string(c)
		}
		ev["outcome"] = "peer-refused"
		ev["code"] = code
		ev["sentence"] = (&transfer.PeerStoppedError{Code: transfer.RefusalCode(code)}).Error()
		return ev, exitPeerRefused
	case errors.Is(err, transfer.ErrRelayOverLimit):
		ev["outcome"] = "relay-gate"
		ev["sentence"] = err.Error()
		return ev, exitRelayGate
	}
	ev["outcome"] = "failed"
	return ev, exitFailed
}

// craftedWait bounds how long a crafted mode waits for the host to end it.
const craftedWait = 30 * time.Second

// runCraftedFrame writes one crafted text frame and waits for the host to end
// the drop: its refusal code, a close without one, or the bound.
func runCraftedFrame(dc *webrtc.DataChannel, early *peer.Early, name string, frame []byte) int {
	if err := dc.SendText(string(frame)); err != nil {
		return fail("send")
	}
	emit(map[string]interface{}{"event": "frame-sent", "which": name})
	return emitEnd(name, early)
}

// runJunkFlood floods the host with junk control frames, then waits for the
// host to end it (the junk-frame deadline).
func runJunkFlood(dc *webrtc.DataChannel, early *peer.Early) int {
	for _, f := range junkFrames(2000) {
		if err := dc.SendText(string(f)); err != nil {
			break
		}
	}
	emit(map[string]interface{}{"event": "junk-sent"})
	return emitEnd("junk-flood", early)
}

// emitEnd waits for the host to end a crafted mode and reports how, with the
// exit code for it.
func emitEnd(name string, early *peer.Early) int {
	ended, code := hostEnd(early.Msgs, early.Closed, craftedWait)
	ev := map[string]interface{}{"event": "ended", "which": name, "ended": ended}
	switch ended {
	case "host-refused":
		ev["code"] = code
		emit(ev)
		return exitPeerRefused
	case "host-closed":
		emit(ev)
		return exitHostClosed
	}
	emit(ev)
	return exitBound
}

// hostEnd waits until the host refuses (its code, allowlisted), closes the
// channel, or the bound passes. A refusal is the last frame a host sends
// before it closes, and both can be ready at once, so a close first drains
// what is already queued for a refusal, as the engine's stopBeforeClose does.
// Every other frame (an ack, for one) is read and dropped.
func hostEnd(msgs <-chan webrtc.DataChannelMessage, closed <-chan struct{}, bound time.Duration) (ended, code string) {
	timer := time.NewTimer(bound)
	defer timer.Stop()
	for {
		select {
		case m := <-msgs:
			if c, ok := hostRefusalCode(m.Data); ok {
				return "host-refused", c
			}
		case <-closed:
			for {
				select {
				case m := <-msgs:
					if c, ok := hostRefusalCode(m.Data); ok {
						return "host-refused", c
					}
				default:
					return "host-closed", ""
				}
			}
		case <-timer.C:
			return "bound", ""
		}
	}
}

// refusalFrameMax bounds what hostRefusalCode will parse; a refusal frame is
// under the engine's 1000-byte control cap, and a file chunk is never parsed.
const refusalFrameMax = 4096

// hostRefusalCode reads the host's refusal code off an incompatible frame. type
// and code are read by exact key from a raw map (a struct tag would accept
// {"CODE":...}); only a code ParseRefusalCode knows passes through, anything
// else, a missing code included, is the fixed word "other". No other field of
// the frame is read, so no host text reaches stdout.
func hostRefusalCode(raw []byte) (string, bool) {
	if len(raw) == 0 || len(raw) > refusalFrameMax || raw[0] != '{' {
		return "", false
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return "", false
	}
	var typ string
	if json.Unmarshal(fields["type"], &typ) != nil || typ != "incompatible" {
		return "", false
	}
	var code string
	if json.Unmarshal(fields["code"], &code) == nil {
		if c, ok := transfer.ParseRefusalCode(code); ok {
			return string(c), true
		}
	}
	return "other", true
}

// badSDPExchange is the -bad-sdp flow: wait for the host's offer (bounded by
// wait, ignoring candidates and anything that is not an offer), send the
// malformed answer once, then hold the socket open until the host leaves or
// hold passes. Factored from run so the ordering is a unit test: nothing is
// sent before an offer, exactly one send follows it, and the exchange returns
// only on the host leaving or the hold timer. It reports how it ended, whether
// the answer was sent, and any send error.
func badSDPExchange(signals <-chan json.RawMessage, send func() error, peerLeft <-chan struct{}, wait, hold time.Duration) (ended string, sent bool, err error) {
	waitTimer := time.NewTimer(wait)
	defer waitTimer.Stop()
Wait:
	for {
		select {
		case raw := <-signals:
			if !isOffer(raw) {
				continue // a candidate, or anything that is not the offer
			}
			if e := send(); e != nil {
				return "send-failed", false, e
			}
			break Wait
		case <-peerLeft:
			return "host-left", false, nil
		case <-waitTimer.C:
			return "no-offer", false, nil
		}
	}
	holdTimer := time.NewTimer(hold)
	defer holdTimer.Stop()
	select {
	case <-peerLeft:
		return "host-left", true, nil
	case <-holdTimer.C:
		return "held", true, nil
	}
}

// isOffer reports whether a raw signal payload is the host's SDP offer. Only
// the type is read; a candidate has none, and neither is ever printed.
func isOffer(raw json.RawMessage) bool {
	var p struct {
		Type string `json:"type"`
	}
	return json.Unmarshal(raw, &p) == nil && p.Type == "offer"
}
