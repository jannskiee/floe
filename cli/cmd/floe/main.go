// floe — P2P file transfer CLI for the Floe platform.
//
// Usage:
//   floe send <file(s) or folder>
//   floe receive <code or link>
//
// By default, the Floe production server is used. For local testing:
//   floe send photo.jpg --server http://localhost:3001
//   floe receive olive-tiger-castle --server http://localhost:3001
//
// Set FLOE_SERVER to point every command at a self-hosted server without
// repeating --server (and FLOE_WEB when its web app is on another host).
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
	"github.com/jannskiee/floe/cli/engine/serverurl"
	"github.com/jannskiee/floe/cli/engine/signaling"
	"github.com/jannskiee/floe/cli/engine/transfer"
	"github.com/jannskiee/floe/cli/internal/selfupdate"
	"github.com/spf13/cobra"
)

// Build-time version — set by goreleaser: -ldflags "-X main.version=1.0.0"
// (GoReleaser's {{ .Version }} strips the tag's leading v.)
var version = "dev"

// Shared flags
var (
	flagServer    string
	flagNoRelay   bool
	flagRelayOnly bool
	flagWebURL    string
	flagIface     []string
)

// ── Root command ─────────────────────────────────────────────────────────────

var rootCmd = &cobra.Command{
	Use:   "floe",
	Short: "Floe — secure P2P file transfer",
	Long: `Floe transfers files directly between devices using WebRTC.
Files are encrypted end-to-end. Nothing is stored on any server.

Documentation: https://www.floe.one/docs`,
	// Runtime failures (network, blocked transfers, spent codes) are not usage
	// mistakes: print the error alone instead of dumping the flag reference.
	SilenceUsage: true,

	// Resolve the server and web origins once, before any subcommand runs, so
	// every consumer downstream reads an already-normalized value.
	//
	// Cobra runs only the CLOSEST PersistentPreRunE in the chain and this repo
	// does not set EnableTraverseRunHooks, so a subcommand that defines its own
	// hook would silently disable this one. Do not add one without moving this
	// logic somewhere both paths reach.
	PersistentPreRunE: func(cmd *cobra.Command, _ []string) error {
		applyEnv(cmd, os.Getenv)
		flagServer = serverurl.Normalize(flagServer)
		flagWebURL = serverurl.Normalize(flagWebURL)
		return nil
	},
}

// applyEnv fills in, from the environment, every shared flag the user did not
// type. getenv is a parameter so tests can drive it without touching the
// process environment.
//
// Precedence: an explicit flag beats the environment, which beats the
// compiled default. Changed() is load-bearing rather than a string compare
// against the default, because --server HAS a non-empty default and so a
// compare cannot tell "typed the default" from "typed nothing". It is also
// what keeps a stray FLOE_SERVER in a developer or CI shell from retargeting
// the e2e suite, whose spawned CLI children inherit the parent environment.
func applyEnv(cmd *cobra.Command, getenv func(string) string) {
	if !cmd.Flags().Changed("server") {
		if v := getenv("FLOE_SERVER"); v != "" {
			flagServer = v
		}
	}
	if !cmd.Flags().Changed("web") {
		if v := getenv("FLOE_WEB"); v != "" {
			flagWebURL = v
		}
	}
	// FLOE_RELAY_ONLY is a standing preference; a typed --no-relay is a
	// decision about this one transfer and wins over it, the same way a typed
	// --server beats FLOE_SERVER. Cobra's mutual-exclusion check only looks at
	// flags that were typed, so this is the one place the pair is reconciled
	// when one half came from the environment.
	if !cmd.Flags().Changed("relay-only") && !cmd.Flags().Changed("no-relay") {
		if getenv("FLOE_RELAY_ONLY") == "1" {
			flagRelayOnly = true
		}
	}
}

func init() {
	// Persistent flags are available on all subcommands
	rootCmd.PersistentFlags().StringVar(&flagServer, "server", "https://api.floe.one",
		"signaling server URL (use http://localhost:3001 for local testing) [env: FLOE_SERVER]")
	rootCmd.PersistentFlags().BoolVar(&flagNoRelay, "no-relay", false,
		"disable TURN relay (direct connections only)")
	rootCmd.PersistentFlags().BoolVar(&flagRelayOnly, "relay-only", false,
		"route through the TURN relay only, hiding your IP from the peer (2 GB cap applies) [env: FLOE_RELAY_ONLY]")
	// One refuses the relay, the other requires it; together they describe no
	// connection at all.
	rootCmd.MarkFlagsMutuallyExclusive("relay-only", "no-relay")
	rootCmd.PersistentFlags().StringVar(&flagWebURL, "web", "",
		"web app URL shown in the browser link (auto-detected if not set) [env: FLOE_WEB]")
	rootCmd.PersistentFlags().StringSliceVar(&flagIface, "iface", nil,
		"restrict WebRTC to network interfaces matching these names (repeatable, e.g. --iface Ethernet); use when a VPN/VM adapter slows connection setup")

	rootCmd.AddCommand(sendCmd)
	rootCmd.AddCommand(receiveCmd)
	rootCmd.AddCommand(versionCmd)
	rootCmd.AddCommand(updateCmd)

	// Enable `floe --version` (and -v) in addition to the `version` subcommand.
	rootCmd.Version = version
	rootCmd.SetVersionTemplate("floe {{.Version}}\n")
}

// peerOptions translates the shared flags into the engine's connection
// options. Both send and receive build their peer from the same flags, so this
// is the one place the mapping lives.
func peerOptions() []peer.Option {
	opts := []peer.Option{peer.WithInterfaceAllowlist(flagIface)}
	if flagRelayOnly {
		opts = append(opts, peer.WithRelayOnly())
	}
	return opts
}

// connectedLine is the status line printed once the data channel is open. It
// names the route ICE settled on, "direct" or "relay", so a user can tell at a
// glance whether the transfer is device to device or through the TURN relay.
// It fails open to the bare word: a route that cannot be read (or one this
// build does not know) must never turn a working connection into a confusing
// line, and other tooling matches "  Connected" as a prefix.
func connectedLine(ct string, err error) string {
	if err != nil {
		return "  Connected"
	}
	switch ct {
	case "direct", "relay":
		return "  Connected (" + ct + ")"
	}
	return "  Connected"
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
		return fmt.Errorf("WebRTC setup failed: %w", err)
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

// ── floe version ─────────────────────────────────────────────────────────────

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print the floe version",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("floe %s\n", version)
		fmt.Println("Docs: https://www.floe.one/docs")
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
		// Message first: feedback must be instant, and the cleanup below
		// touches the disk (an AV scanner holding the file could stall it).
		fmt.Fprintln(os.Stderr, "\n  Canceled.")
		// os.Exit skips every defer, including the receiver's partial-file
		// cleanup. Remove the in-flight .part staging file here so a Ctrl+C
		// leaves the output directory as clean as any other failure. Safe at
		// any moment: only .part files are ever registered, and a completed
		// file's rename vacated that path.
		transfer.AbandonPartials()
		os.Exit(130)
	}()

	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}
