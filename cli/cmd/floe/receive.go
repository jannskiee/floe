package main

// The `floe receive` command, including its own flags. Cobra registers them
// from the init below; Go runs a package's init functions in file-name order,
// and receive.go still sorts after main.go, so the root flags are still
// registered first.

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/jannskiee/floe/cli/engine/code"
	"github.com/jannskiee/floe/cli/engine/ice"
	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/transfer"
	"github.com/spf13/cobra"
)

var (
	flagOutput     string
	flagAutoAccept bool
	flagNoReport   bool
)

// errFloeLinkOtherServer ends a receive of a room link made on floe.one while
// another server is chosen (runReceive). execute prints it as an outcome,
// alone on the indent, and main exits 1. New copy (FU-53), pending the
// owner's approval: approved-copy-cli.txt has no line for this case.
var errFloeLinkOtherServer = errors.New("That link is for floe.one, but this Floe is set to use another server. Unset FLOE_SERVER or use --server https://api.floe.one, then try again.")

var receiveCmd = &cobra.Command{
	Use:   "receive <code | link>",
	Short: "Receive files from a peer",
	Long: `Receive files from a peer using a code or link.

After a successful transfer the receiver posts only the total byte count to
Floe's signaling server to power the public global-transfer counter. No file
names, contents, or identities are included. To opt out of this report, use
--no-report or set FLOE_NO_STATS=1 in your environment.`,
	Args: cobra.ExactArgs(1),
	RunE: runReceive,
}

func init() {
	receiveCmd.Flags().StringVarP(&flagOutput, "output", "o", ".",
		"directory to save received files")
	receiveCmd.Flags().BoolVarP(&flagAutoAccept, "yes", "y", false,
		"auto-accept incoming files without confirmation")
	receiveCmd.Flags().BoolVar(&flagNoReport, "no-report", false,
		"do not report transferred bytes to Floe's public global counter")
}

func runReceive(cmd *cobra.Command, args []string) error {
	input := args[0]

	fmt.Println()

	// 1. Resolve the input to a room ID
	//    Input can be: "olive-tiger-castle" (code) or a full URL
	roomId, err := code.Resolve(flagServer, input)
	if err != nil {
		// A request or drop link (TL-33, E-10) comes back as the engine's
		// sentinel, whose text is the approved sentence. Never put in the
		// wrapper below: it quotes the pasted input, which for a request link
		// is the room id in the fragment (desktop/transfer.go does the same).
		//
		// It prints in the approved form (approved-copy-cli.txt, TL-33): the
		// sentence alone on the two-space indent, without "Error: ", because
		// a refusal is an outcome and not a usage mistake. execute prints an
		// outcomeError that way, once, and main still exits 1 on it.
		if errors.Is(err, code.ErrRequestLink) || errors.Is(err, code.ErrDropLink) {
			return outcomeError{err}
		}
		return fmt.Errorf("could not resolve %q: %w", input, err)
	}
	// A room link made on floe.one has its room on api.floe.one alone. With
	// another server chosen (FLOE_SERVER, a self-hoster's standing setting,
	// or --server), join-room would hand that room's id to a server that
	// never held the room, and whoever runs it could take the receiver's
	// seat, and the files, on api.floe.one (FU-53, FU-46 review 1 L5). The
	// request-link send's host rule decides (linkServerMismatch, FU-32 F5-4),
	// before any network call: Resolve reads a link without one, and only a
	// code, which has no host, goes to the server.
	if isFloeOneLinkHost(code.LinkHost(input)) && !isFloeOneServer(flagServer) {
		return outcomeError{errFloeLinkOtherServer}
	}

	// 2. Ensure output directory exists
	if err := os.MkdirAll(flagOutput, 0755); err != nil {
		return fmt.Errorf("cannot create output directory %s: %w", flagOutput, err)
	}
	absOutput, _ := filepath.Abs(flagOutput)

	// 3. Fetch ICE credentials
	iceServers, degraded, err := fetchICE(flagServer)
	if err != nil {
		return fmt.Errorf("failed to fetch ICE credentials: %w", err)
	}
	// Before the room is joined, so a receiver that cannot connect does not take
	// up the sender's second slot in a two-peer room.
	if err := requireRelay(ice.HasRelay(iceServers), degraded); err != nil {
		return err
	}
	if flagNoRelay {
		iceServers = ice.StunOnly(iceServers)
	}

	// 4. Connect to signaling server
	sc, err := connectSignaling(flagServer)
	if err != nil {
		return fmt.Errorf("failed to connect to signaling server: %w", err)
	}
	defer sc.Close()

	// 5. Join the room (we are the second → role = receiver)
	if err := sc.JoinRoom(roomId); err != nil {
		return fmt.Errorf("failed to join room: %w", err)
	}

	// PeerLeft and the deadline are what the desktop copy of this block has
	// carried all along. Without them a server that accepts the socket and then
	// goes quiet hangs the command with no output and no way out but Ctrl+C.
	select {
	case role := <-sc.Role:
		if role != "receiver" {
			// The server only ever returns "sender" or "receiver"; a receiver
			// getting "sender" means it joined an empty room, so nobody is sharing
			// with this code (codes are single-use: the transfer already finished,
			// or the sender left).
			return fmt.Errorf("this code is no longer active; ask for a new one")
		}
	case <-sc.RoomFull:
		return fmt.Errorf("room is full (someone else may already be receiving)")
	case errMsg := <-sc.Errors:
		return fmt.Errorf("server error: %s", errMsg)
	case <-sc.PeerLeft:
		return fmt.Errorf("connection closed before the server assigned a role")
	case <-time.After(roleAssignTimeout):
		return fmt.Errorf("timed out waiting for the server to assign a role")
	}

	fmt.Println("  Connecting to sender...")

	// 6. Set up WebRTC as the responder (receiver waits for offer)
	conn, err := peer.New(iceServers, sc, peerOptions()...)
	if err != nil {
		return fmt.Errorf("failed to create peer connection: %w", err)
	}
	defer conn.Close()

	dc, err := conn.SetupAsReceiver()
	if err != nil {
		// Bounded and escaped (setupFailureLine): pion's parse error quotes
		// the peer's offer.
		return fmt.Errorf("%s", setupFailureLine(err))
	}

	fmt.Println(connectedLine(conn.ConnectionType()))

	// 7. Receive files
	statsURL := flagServer
	if flagNoReport || os.Getenv("FLOE_NO_STATS") == "1" {
		statsURL = "" // reportBytesToServer no-ops on empty URL
	}
	// The pump comes from the connection, not from ReceiveFiles: see peer.Early.
	// This is the side that was actually losing the sender's first message.
	early := conn.Early()
	return transfer.ReceiveFilesWithOptions(dc, absOutput, flagAutoAccept, version, statsURL, transfer.ReceiveOptions{
		Messages: early.Msgs,
		Closed:   early.Closed,
	})
}
