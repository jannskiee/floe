// floe — P2P file transfer CLI for the Floe platform.
//
// Usage:
//   floe send <file(s) or folder>
//   floe receive <code or link>
//
// By default, the Floe production server is used. For local testing:
//   floe send photo.jpg --server http://localhost:3001
//   floe receive olive-tiger-castle --server http://localhost:3001
package main

import (
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/google/uuid"
	"github.com/jannskiee/floe/cli/engine/code"
	"github.com/jannskiee/floe/cli/engine/ice"
	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/jannskiee/floe/cli/engine/transfer"
	"github.com/jannskiee/floe/cli/engine/verify"
	"github.com/jannskiee/floe/cli/internal/selfupdate"
	"github.com/spf13/cobra"
)

// Build-time version — set by goreleaser: -ldflags "-X main.version=v1.0.0"
var version = "dev"

// Shared flags
var (
	flagServer  string
	flagNoRelay bool
	flagWebURL  string
)

// ── Root command ─────────────────────────────────────────────────────────────

var rootCmd = &cobra.Command{
	Use:   "floe",
	Short: "Floe — secure P2P file transfer",
	Long: `Floe transfers files directly between devices using WebRTC.
Files are encrypted end-to-end. Nothing is stored on any server.

Documentation: https://docs.floe.one`,
}

func init() {
	// Persistent flags are available on all subcommands
	rootCmd.PersistentFlags().StringVar(&flagServer, "server", "https://api.floe.one",
		"signaling server URL (use http://localhost:3001 for local testing)")
	rootCmd.PersistentFlags().BoolVar(&flagNoRelay, "no-relay", false,
		"disable TURN relay (direct connections only)")
	rootCmd.PersistentFlags().StringVar(&flagWebURL, "web", "",
		"web app URL shown in the browser link (auto-detected if not set)")

	rootCmd.AddCommand(sendCmd)
	rootCmd.AddCommand(receiveCmd)
	rootCmd.AddCommand(versionCmd)
	rootCmd.AddCommand(updateCmd)

	// Enable `floe --version` (and -v) in addition to the `version` subcommand.
	rootCmd.Version = version
	rootCmd.SetVersionTemplate("floe {{.Version}}\n")
}

// ── floe send ────────────────────────────────────────────────────────────────

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

	select {
	case role := <-sc.Role:
		if role != "sender" {
			return fmt.Errorf("expected sender role, got %q (room may already have two peers)", role)
		}
	case <-sc.RoomFull:
		return fmt.Errorf("room is full")
	case errMsg := <-sc.Errors:
		return fmt.Errorf("server error: %s", errMsg)
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
	// NOT the API server. Auto-detect the right URL:
	webURL := flagWebURL
	if webURL == "" {
		switch flagServer {
		case "https://api.floe.one":
			webURL = "https://floe.one" // production
		case "http://localhost:3001":
			webURL = "http://localhost:3000" // local dev
		default:
			webURL = flagServer // self-hosted: same origin
		}
	}
	link := webURL + "?room=" + roomId

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
	conn, err := peer.New(iceServers, sc)
	if err != nil {
		return fmt.Errorf("failed to create peer connection: %w", err)
	}
	defer conn.Close()

	fmt.Println("  Connecting...")
	dc, err := conn.SetupAsSender()
	if err != nil {
		return fmt.Errorf("WebRTC setup failed: %w", err)
	}

	fmt.Println("  Connected")
	if local, remote, err := conn.Fingerprints(); err == nil {
		fmt.Printf("  Verify    %s   (compare with the other device to rule out eavesdropping)\n", verify.Code(local, remote))
	}
	fmt.Println()

	// 9. Send files
	return transfer.SendFiles(dc, args, version)
}

// ── floe receive ─────────────────────────────────────────────────────────────

var (
	flagOutput     string
	flagAutoAccept bool
	flagNoReport   bool
)

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
		return fmt.Errorf("could not resolve %q: %w", input, err)
	}

	// 2. Ensure output directory exists
	if err := os.MkdirAll(flagOutput, 0755); err != nil {
		return fmt.Errorf("cannot create output directory %s: %w", flagOutput, err)
	}
	absOutput, _ := filepath.Abs(flagOutput)

	// 3. Fetch ICE credentials
	iceServers, err := ice.Fetch(flagServer)
	if err != nil {
		return fmt.Errorf("failed to fetch ICE credentials: %w", err)
	}
	if flagNoRelay {
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

	// 4. Connect to signaling server
	sc, err := signaling.Connect(flagServer)
	if err != nil {
		return fmt.Errorf("failed to connect to signaling server: %w", err)
	}
	defer sc.Close()

	// 5. Join the room (we are the second → role = receiver)
	if err := sc.JoinRoom(roomId); err != nil {
		return fmt.Errorf("failed to join room: %w", err)
	}

	select {
	case role := <-sc.Role:
		if role != "receiver" {
			return fmt.Errorf("expected receiver role, got %q (are you using the right code?)", role)
		}
	case <-sc.RoomFull:
		return fmt.Errorf("room is full (someone else may already be receiving)")
	case errMsg := <-sc.Errors:
		return fmt.Errorf("server error: %s", errMsg)
	}

	fmt.Println("  Connecting to sender...")

	// 6. Set up WebRTC as the responder (receiver waits for offer)
	conn, err := peer.New(iceServers, sc)
	if err != nil {
		return fmt.Errorf("failed to create peer connection: %w", err)
	}
	defer conn.Close()

	dc, err := conn.SetupAsReceiver()
	if err != nil {
		return fmt.Errorf("WebRTC setup failed: %w", err)
	}

	fmt.Println("  Connected")
	if local, remote, err := conn.Fingerprints(); err == nil {
		fmt.Printf("  Verify    %s   (compare with the other device to rule out eavesdropping)\n", verify.Code(local, remote))
	}

	// 7. Receive files
	statsURL := flagServer
	if flagNoReport || os.Getenv("FLOE_NO_STATS") == "1" {
		statsURL = "" // reportBytesToServer no-ops on empty URL
	}
	return transfer.ReceiveFiles(dc, absOutput, flagAutoAccept, version, statsURL)
}

// ── floe version ─────────────────────────────────────────────────────────────

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print the floe version",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("floe %s\n", version)
		fmt.Println("Docs: https://docs.floe.one")
		if latest := selfupdate.CheckAvailable(version); latest != "" {
			fmt.Printf("Update available: %s  run `floe update` to upgrade\n", latest)
		}
	},
}

// ── floe update ───────────────────────────────────────────────────────────────

var flagUpdateCheck bool

var updateCmd = &cobra.Command{
	Use:   "update",
	Short: "Update floe to the latest release",
	Long: `Downloads, verifies, and installs the latest floe release.

If floe was installed via Homebrew, Scoop, or Winget, use your package manager
to update instead (e.g. brew upgrade floe).

Set FLOE_NO_UPDATE_CHECK=1 to suppress the update hint in 'floe version'.`,
	RunE: runUpdate,
}

func init() {
	updateCmd.Flags().BoolVar(&flagUpdateCheck, "check", false, "check for a newer version without installing")
}

func runUpdate(cmd *cobra.Command, args []string) error {
	if version == "dev" {
		fmt.Fprintln(os.Stderr, "Cannot update a dev build.")
		return nil
	}

	if pm := selfupdate.PMPath(); pm != "" {
		hint := selfupdate.PMHint(pm)
		return fmt.Errorf("installed via %s - run `%s` to update", pm, hint)
	}

	fmt.Printf("Current version: %s\n", version)
	fmt.Print("Checking for updates... ")

	latest, err := selfupdate.LatestVersion()
	if err != nil {
		return fmt.Errorf("failed to check for updates: %w", err)
	}
	fmt.Println(latest)

	if selfupdate.CompareVersions(latest, version) <= 0 {
		fmt.Printf("Already up to date (%s)\n", version)
		return nil
	}

	fmt.Printf("Update available: %s -> %s\n", version, latest)

	if flagUpdateCheck {
		fmt.Printf("Run `floe update` to install.\n")
		return nil
	}

	fmt.Printf("Downloading %s...\n", latest)
	if err := selfupdate.Apply(latest); err != nil {
		return fmt.Errorf("update failed: %w", err)
	}

	fmt.Printf("Updated to %s\n", latest)
	return nil
}

// ── Entry point ───────────────────────────────────────────────────────────────

func main() {
	// Translate Ctrl+C / SIGTERM into a clean message and exit code 130
	// instead of an abrupt stop mid-transfer.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigCh
		fmt.Fprintln(os.Stderr, "\n  Cancelled.")
		os.Exit(130)
	}()

	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}
