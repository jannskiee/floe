package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/jannskiee/floe/cli/engine/code"
	"github.com/jannskiee/floe/cli/engine/ice"
	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/jannskiee/floe/cli/engine/transfer"
)

// defaultServer is the production Floe signaling server. The desktop app talks to
// the same infrastructure as the browser and CLI, so transfers interoperate.
const defaultServer = "https://api.floe.one"

// App struct
type App struct {
	ctx context.Context
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts. The context is saved so we can call the
// runtime methods.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// EngineProtocolVersion returns the wire protocol version of the embedded engine.
// It proves the shared engine is linked into the desktop binary.
func (a *App) EngineProtocolVersion() int {
	return transfer.ProtocolVersion
}

// ReceiveByCode connects to a peer using a Floe room code (or link) and receives
// the incoming files into outputDir. It reuses the exact same engine the CLI uses
// (signaling, Pion WebRTC, the transfer protocol), so it interoperates with both
// browser senders and CLI senders. WebRTC and all file bytes run in Go here; the
// webview never touches the data channel.
//
// Returns the absolute output directory on success.
func (a *App) ReceiveByCode(codeOrLink string, outputDir string) (string, error) {
	if outputDir == "" {
		outputDir = "."
	}
	absOutput, err := filepath.Abs(outputDir)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(absOutput, 0o755); err != nil {
		return "", fmt.Errorf("cannot create output directory: %w", err)
	}

	// 1. Resolve the code/link to a room ID.
	roomID, err := code.Resolve(defaultServer, codeOrLink)
	if err != nil {
		return "", fmt.Errorf("could not resolve %q: %w", codeOrLink, err)
	}

	// 2. Fetch STUN/TURN credentials.
	iceServers, err := ice.Fetch(defaultServer)
	if err != nil {
		return "", fmt.Errorf("failed to fetch ICE credentials: %w", err)
	}

	// 3. Connect to the signaling server and join as the receiver.
	sc, err := signaling.Connect(defaultServer)
	if err != nil {
		return "", fmt.Errorf("failed to connect to signaling server: %w", err)
	}
	defer sc.Close()

	if err := sc.JoinRoom(roomID); err != nil {
		return "", fmt.Errorf("failed to join room: %w", err)
	}

	select {
	case role := <-sc.Role:
		if role != "receiver" {
			return "", fmt.Errorf("expected receiver role, got %q (is the code correct?)", role)
		}
	case <-sc.RoomFull:
		return "", fmt.Errorf("room is full (someone else may already be receiving)")
	case errMsg := <-sc.Errors:
		return "", fmt.Errorf("server error: %s", errMsg)
	}

	// 4. Set up WebRTC as the responder and receive.
	conn, err := peer.New(iceServers, sc)
	if err != nil {
		return "", fmt.Errorf("failed to create peer connection: %w", err)
	}
	defer conn.Close()

	dc, err := conn.SetupAsReceiver()
	if err != nil {
		return "", fmt.Errorf("WebRTC setup failed: %w", err)
	}

	// autoAccept=true: a GUI cannot answer a terminal prompt. statsURL="" so the
	// Phase 1 skeleton does not report to the global counter.
	if err := transfer.ReceiveFiles(dc, absOutput, true, "desktop-dev", ""); err != nil {
		return "", fmt.Errorf("transfer failed: %w", err)
	}

	return absOutput, nil
}
