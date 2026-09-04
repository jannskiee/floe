// floe — P2P file transfer CLI for the Floe platform.
//
// Usage:
//
//	floe send <file(s) or folder>
//	floe receive <code or link>
//
// By default, the Floe production server is used. For local testing:
//
//	floe send photo.jpg --server http://localhost:3001
//	floe receive olive-tiger-castle --server http://localhost:3001
//
// Set FLOE_SERVER to point every command at a self-hosted server without
// repeating --server (and FLOE_WEB when its web app is on another host).
package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jannskiee/floe/cli/engine/peer"
	"github.com/jannskiee/floe/cli/engine/serverurl"
	"github.com/jannskiee/floe/cli/engine/transfer"
	"github.com/spf13/cobra"
)

// Build-time version — set by goreleaser: -ldflags "-X main.version=1.0.0"
// (GoReleaser's {{ .Version }} strips the tag's leading v.)
var version = "dev"

// roleAssignTimeout bounds the wait for the server to answer join-room. The
// desktop copy of the role select has always had it; without it a server that
// accepts the socket and then goes quiet hangs the command indefinitely.
const roleAssignTimeout = 20 * time.Second

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
	Short: "Floe - secure P2P file transfer",
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
