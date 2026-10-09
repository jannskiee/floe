package main

// Host mode: the Stage 1 pairing's host half, in the order the baseline
// pairing spike proved through a real server.js and peer/hostreceive_test.go
// keeps proving against a fake relay. The host joins the room FIRST, waits for
// the peer, makes the offer (SetupAsSender) and then RECEIVES.

import (
	"flag"
	"io"
	"time"

	"github.com/google/uuid"
	"github.com/jannskiee/floe/cli/engine/ice"
	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/jannskiee/floe/cli/engine/transfer"
)

func runHost(ev *events, args []string) {
	fs := flag.NewFlagSet("host", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	server := fs.String("server", "http://localhost:3001", "signaling server base URL")
	room := fs.String("room", "", "room UUID (generated when empty)")
	out := fs.String("out", "", "directory received files are written to (required)")
	hold := fs.Duration("hold", 0, "how long OnIncoming blocks before the ack is sent")
	timeout := fs.Duration("timeout", 2*time.Minute, "overall deadline for the whole run")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 || *out == "" || *hold < 0 || *timeout <= 0 {
		ev.usage()
	}
	if *room == "" {
		*room = uuid.New().String()
	} else if _, err := uuid.Parse(*room); err != nil {
		ev.usage()
	}

	// A wedged pairing or receive must end the process with an event rather
	// than leave the spec to kill it.
	watchdog := time.AfterFunc(*timeout, func() { ev.fail("timeout") })

	sc, err := signaling.Connect(*server)
	if err != nil {
		ev.fail("connect")
	}
	defer sc.Close()
	if err := sc.JoinRoom(*room); err != nil {
		ev.fail("join")
	}

	// Whatever role the server assigns is reported, never required: today's
	// server calls the first joiner "sender" whatever its WebRTC role.
	select {
	case role := <-sc.Role:
		ev.emit(map[string]interface{}{"event": "joined", "role": role, "roomId": *room})
	case <-sc.RoomFull:
		ev.fail("role")
	case <-sc.Errors:
		ev.fail("role")
	case <-sc.PeerLeft:
		ev.fail("role")
	}

	select {
	case <-sc.PeerConnected:
	case <-sc.PeerLeft:
		ev.fail("peer-wait")
	}

	servers, _, err := ice.FetchDetail(*server)
	if err != nil {
		ev.fail("ice")
	}
	conn, err := peer.New(servers, sc)
	if err != nil {
		ev.fail("peer")
	}
	defer conn.Close()

	dc, err := conn.SetupAsSender()
	if err != nil {
		ev.fail("setup")
	}
	// SetupAsSender returns only after the data channel opened (the offer left
	// earlier and the answer came back), so the event names that moment.
	ev.emit(map[string]interface{}{"event": "channel-open"})

	early := conn.Early()
	err = transfer.ReceiveFilesWithOptions(dc, *out, true, "e2ehost", "", transfer.ReceiveOptions{
		OnProgress: func(transfer.Progress) {},
		OnIncoming: func(in transfer.IncomingInfo) {
			// A count only: the name and sizes are the peer's and never reach stdout.
			ev.emit(map[string]interface{}{"event": "incoming", "files": in.Files})
			if *hold > 0 {
				time.Sleep(*hold)
			}
		},
		Messages: early.Msgs,
		Closed:   early.Closed,
	})
	if err != nil {
		ev.fail("receive")
	}
	watchdog.Stop()
	ev.emit(map[string]interface{}{"event": "done"})
	conn.Close()
	sc.Close()
	ev.exit(0)
}
