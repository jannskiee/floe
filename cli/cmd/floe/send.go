package main

// The `floe send` command: flag wiring, path validation, and the send-side
// signaling and transfer sequence.

import (
	"fmt"
	"os"
	"time"

	"github.com/google/uuid"
	"github.com/jannskiee/floe/cli/engine/code"
	"github.com/jannskiee/floe/cli/engine/ice"
	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/serverurl"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/jannskiee/floe/cli/engine/transfer"
	"github.com/spf13/cobra"
)

var sendCmd = &cobra.Command{
	Use:   "send <file|folder> [file|folder...]",
	Short: "Send files or folders to a peer",
	Args:  cobra.MinimumNArgs(1),
	RunE:  runSend,
}

func runSend(cmd *cobra.Command, args []string) error {
	// Validate that all paths exist
	for _, p := range args {
		if _, err := os.Stat(p); err != nil {
			return fmt.Errorf("cannot read %s: %w", p, err)
		}
	}

	// Pre-compute file summary for the share box (same walk as SendFiles).
	summary, err := transfer.Summarize(args)
	if err != nil {
		return err
	}

	fmt.Println()

	// 1. Generate a UUID room ID for this session
	roomId := uuid.New().String()

	// 2. Fetch ICE (STUN/TURN) server credentials
	iceServers, err := ice.Fetch(flagServer)
	if err != nil {
		return fmt.Errorf("failed to fetch ICE credentials: %w", err)
	}
	if flagNoRelay {
		// Keep only STUN servers, drop TURN
		filtered := iceServers[:0]
		for _, s := range iceServers {
			for _, u := range s.URLs {
				if len(u) >= 4 && u[:4] == "stun" {
					filtered = append(filtered, s)
					break
				}
			}
		}
		iceServers = filtered
	}

	// 3. Connect to the signaling server via WebSocket
	sc, err := signaling.Connect(flagServer)
	if err != nil {
		return fmt.Errorf("failed to connect to signaling server: %w", err)
	}
	defer sc.Close()

	// 4. Join the room (we are the first → role = sender)
	if err := sc.JoinRoom(roomId); err != nil {
		return fmt.Errorf("failed to join room: %w", err)
	}

	// PeerLeft and the deadline are what the desktop copy of this block has
	// carried all along. Without them a server that accepts the socket and then
	// goes quiet hangs the command with no output and no way out but Ctrl+C.
	select {
	case role := <-sc.Role:
		if role != "sender" {
			return fmt.Errorf("expected sender role, got %q (room may already have two peers)", role)
		}
	case <-sc.RoomFull:
		return fmt.Errorf("room is full")
	case errMsg := <-sc.Errors:
		return fmt.Errorf("server error: %s", errMsg)
	case <-sc.PeerLeft:
		return fmt.Errorf("connection closed before the server assigned a role")
	case <-time.After(roleAssignTimeout):
		return fmt.Errorf("timed out waiting for the server to assign a role")
	}

	// 5. Register a short code phrase for this room
	codePhrase, err := code.Register(flagServer, roomId)
	if err != nil {
		// Non-fatal: code registration failure still allows link sharing
		fmt.Printf("  Warning: could not generate short code: %v\n", err)
		codePhrase = ""
	}

	// 6. Display sharing info
	// The "link" is for browser receivers — it must point to the web app,
	// NOT the API server. Auto-detect the right URL. The derivation lives in
	// engine/serverurl so the desktop app builds byte-identical links.
	webURL := flagWebURL
	if webURL == "" {
		webURL = serverurl.Web(flagServer)
	}
	// The room id goes in the URL fragment (#room=) so it never reaches the
	// web server or its analytics when a browser opens this link.
	link := webURL + "/#room=" + roomId

	fmt.Printf("  Sending   %s\n", summary.Label)
	var rows [][2]string
	if codePhrase != "" {
		rows = append(rows, [2]string{"Code", codePhrase})
	}
	rows = append(rows, [2]string{"Link", link})
	transfer.PrintBox(rows)
	fmt.Println()
	fmt.Println("  Waiting for peer...")

	// 7. Wait for the receiver to join
	var peerId string
	select {
	case peerId = <-sc.PeerConnected:
	case <-sc.PeerLeft:
		return fmt.Errorf("peer disconnected before connecting")
	case errMsg := <-sc.Errors:
		return fmt.Errorf("server error: %s", errMsg)
	}
	_ = peerId // used internally by signaling routing

	// 8. Set up WebRTC as the initiator (sender creates offer + data channel)
	conn, err := peer.New(iceServers, sc, peerOptions()...)
	if err != nil {
		return fmt.Errorf("failed to create peer connection: %w", err)
	}
	defer conn.Close()

	fmt.Println("  Connecting...")
	dc, err := conn.SetupAsSender()
	if err != nil {
		return fmt.Errorf("WebRTC setup failed: %w", err)
	}

	fmt.Println(connectedLine(conn.ConnectionType()))
	fmt.Println()

	// 9. Send files. The pump comes from the connection, not from SendFiles: see
	// peer.Early for why registering it later can silently lose a message.
	early := conn.Early()
	return transfer.SendFilesWithOptions(dc, args, version, transfer.SendOptions{
		Messages: early.Msgs,
		Closed:   early.Closed,
	})
}
