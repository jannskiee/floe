package main

// The `floe send` command: flag wiring, path validation, and the send-side
// signaling and transfer sequence.

import (
	"errors"
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

// flagTo is the request link a send goes to instead of a new code (sendto.go).
var flagTo string

// errLinkTypedAsPath ends a plain send that was given a request link where a
// path goes, the likeliest mistake of someone who forgot --to. The stat
// sentence it replaces quoted the path, and so printed the link and its room
// id twice into scrollback (FU-46, FU-32 F5-3). It also ends `floe <link>`,
// the subcommand forgotten, whose unknown-command error quoted the link
// (execute, FU-53). execute prints it as an outcome, alone on the indent, and
// main exits 1. The line is approved copy (D-153, approved-copy-cli.txt),
// byte for byte.
var errLinkTypedAsPath = errors.New("That looks like a request link, not a file. To send to it, use: floe send <files> --to <link>")

func init() {
	// The help line is the approved copy's (TL-34), byte for byte.
	sendCmd.Flags().StringVar(&flagTo, "to", "",
		"send through a request link made in Floe Desktop instead of creating a code")
}

func runSend(cmd *cobra.Command, args []string) error {
	// Typed at all, even empty: an unset shell variable in --to "$LINK" must
	// end on the incomplete-link line, never fall through to a code nobody
	// asked for.
	if cmd.Flags().Changed("to") {
		return runSendTo(cmd, args)
	}

	// Validate that all paths exist. The sentence quotes the path, so a
	// request link typed as one (--to forgotten) ends on a fixed line instead.
	for _, p := range args {
		if _, err := os.Stat(p); err != nil {
			if looksLikeRequestLink(p) {
				return outcomeError{errLinkTypedAsPath}
			}
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
	iceServers, degraded, err := ice.FetchDetail(flagServer)
	if err != nil {
		return fmt.Errorf("failed to fetch ICE credentials: %w", err)
	}
	// Before the room code is registered, so nobody is handed a code that could
	// never have connected.
	if err := requireRelay(ice.HasRelay(iceServers), degraded); err != nil {
		return err
	}
	if flagNoRelay {
		iceServers = ice.StunOnly(iceServers)
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
		fmt.Println(shortCodeWarning(err))
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
	transfer.PrintBox(shareRows(codePhrase, link))
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
		// Bounded and escaped (setupFailureLine): pion's parse error quotes
		// the peer's answer.
		return fmt.Errorf("%s", setupFailureLine(err))
	}

	fmt.Println(connectedLine(conn.ConnectionType()))
	fmt.Println()

	// 9. Send files. The pump comes from the connection, not from SendFiles: see
	// peer.Early for why registering it later can silently lose a message. A Go
	// receiver's word after the last file has no deadline, so an ICE failure
	// closes the connection and ends the wait (connfailed.go).
	quit := make(chan struct{})
	defer close(quit)
	closeOnFailed(conn, quit)
	early := conn.Early()
	return transfer.SendFilesWithOptions(dc, args, version, transfer.SendOptions{
		Messages: early.Msgs,
		Closed:   early.Closed,
	})
}

// shortCodeWarning is the line send prints when the server gives no code. The
// error can carry a TLS certificate's names or other text the CLI does not
// control, so it is bounded and escaped on one line.
func shortCodeWarning(err error) string {
	return "  Warning: could not generate short code: " + peer.EscapeText(cutRunes(err.Error(), errorMax))
}

// codePhraseMax bounds the code phrase in the box: a real one is three short
// words ("olive-tiger-castle").
const codePhraseMax = 64

// shareRows are the rows of the box send prints: the code when the server
// gave one, then the link. The code phrase is the server's text, so it is
// bounded and escaped before it reaches the terminal; a real one comes out
// unchanged.
func shareRows(codePhrase, link string) [][2]string {
	var rows [][2]string
	if codePhrase != "" {
		rows = append(rows, [2]string{"Code", peer.EscapeText(cutRunes(codePhrase, codePhraseMax))})
	}
	return append(rows, [2]string{"Link", link})
}
