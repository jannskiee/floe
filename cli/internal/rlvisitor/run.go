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
	return 1
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
		return 1
	}
	emit(map[string]interface{}{"event": "joined"})

	watchdog := time.AfterFunc(cfg.timeout, func() {
		emit(map[string]interface{}{"event": "error", "stage": "timeout"})
		os.Exit(1)
	})
	defer watchdog.Stop()

	// -bad-sdp answers before any peer is built: a malformed signal in place of
	// a real SDP answer, then the run ends. The host's SetRemoteDescription
	// refuses it and the host reports its own fixed setup error.
	if m == modeBadSDP {
		if err := sc.SendSignal(badSDPSignal()); err != nil {
			return fail("signal")
		}
		emit(map[string]interface{}{"event": "bad-sdp-sent"})
		return 0
	}

	var opts []peer.Option
	if cfg.relayOnly || m == modeSkipGate {
		opts = append(opts, peer.WithRelayOnly())
	}
	var servers []webrtc.ICEServer
	if cfg.relayOnly || m == modeSkipGate {
		// A relay path needs the server's ICE list; a direct drop uses none,
		// as the loopback tests do. The credentials are never printed.
		s, _, ferr := ice.FetchDetail(cfg.server)
		if ferr != nil {
			return fail("ice")
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
	if err != nil {
		emit(map[string]interface{}{"event": "send-ended", "ok": false})
		return 0
	}
	emit(map[string]interface{}{"event": "send-ended", "ok": true})
	return 0
}

// runCraftedFrame writes one crafted text frame and gives the host a moment to
// refuse before closing. The host's refusal is what the cell reads; the
// visitor only needs to have sent the frame.
func runCraftedFrame(dc *webrtc.DataChannel, early *peer.Early, name string, frame []byte) int {
	if err := dc.SendText(string(frame)); err != nil {
		return fail("send")
	}
	emit(map[string]interface{}{"event": "frame-sent", "which": name})
	waitForClose(early, 30*time.Second)
	return 0
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
	waitForClose(early, 30*time.Second)
	return 0
}

// waitForClose blocks until the data channel closes or the bound passes.
func waitForClose(early *peer.Early, bound time.Duration) {
	select {
	case <-early.Closed:
	case <-time.After(bound):
	}
}
