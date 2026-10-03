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
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"

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

// requireRelay refuses a --relay-only transfer that has nowhere to relay
// through, before it spends thirty seconds finding that out.
//
// With relay-only forced and no TURN URL in the list, ICE gathers no usable
// candidate at all, so the run used to end on the same
// "timed out establishing a connection" that --no-relay produces when no direct
// path exists. Two opposite causes, one message, and neither one names the
// flag that caused it.
//
// degraded says the list is ice.Fetch's STUN-only fallback rather than the
// server's own answer, which is a different thing to tell the reader: the
// server was never heard from, so blaming its configuration would be a guess.
// The CLI prints a warning line for that case too, but it scrolls past above
// the error, so the error says it as well.
//
// Takes the answers rather than the list so the caller keeps the only reference
// to the ICE types, matching the desktop's requireRelay.
func requireRelay(hasRelay, degraded bool) error {
	if !flagRelayOnly || hasRelay {
		return nil
	}
	if degraded {
		return fmt.Errorf("--relay-only needs a TURN relay, and the connection details from %s could not be read; check --server, or drop the flag", flagServer)
	}
	return fmt.Errorf("--relay-only needs a TURN relay and %s offers none; drop the flag, or configure a relay on the server", flagServer)
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

// setupFailureLine is the error a failed WebRTC setup ends send or receive
// with. A setup that stopped because the other side left, the server went
// away or the connection was closed is not a connection problem to
// diagnose, so each of the three prints its sentinel's own fixed sentence;
// every other failure keeps "WebRTC setup failed: " and the error's text,
// byte for byte what the command printed before (a present peer that cannot
// connect still reads "timed out establishing a connection").
//
// That text also goes through peer.EscapeText (FU-40): SetupError's
// DisplayText already replaces every terminal control and caps the text at
// 300 runes, but it keeps the format characters that are not bidi controls
// (zero width and similar) and U+2028/U+2029, which pion/sdp can quote from
// the peer's SDP and EscapeText writes visibly.
func setupFailureLine(err error) string {
	for _, stop := range []error{peer.ErrPeerLeft, peer.ErrSignalingLost, peer.ErrClosed} {
		if errors.Is(err, stop) {
			return stop.Error()
		}
	}
	return peer.EscapeText("WebRTC setup failed: " + err.Error())
}

// interruptHook, when set, picks what Ctrl+C prints and what it stops before
// the exit: the request-link send sets one (sendto.go, TL-28 and TL-29). A
// nil stop says the command already has its outcome and is ending on its
// own, so the handler prints nothing and leaves the exit code to it. Unset,
// every command prints "Canceled." as it always has.
var interruptHook atomic.Pointer[func() (line string, stop func())]

// interruptLine is what the Ctrl+C handler prints, and the stop it runs after
// printing and before the partial-file cleanup. A hook answers within a
// short bound (the request-link send waits at most sendToStopWait for its
// send to settle, so its line is final) and never touches the disk: it runs
// before the message, and the message must come quickly.
func interruptLine() (string, func()) {
	if h := interruptHook.Load(); h != nil {
		return (*h)()
	}
	return "\n  Canceled.", func() {}
}

// handleInterrupts is main's Ctrl+C and SIGTERM handler, with os.Exit passed
// in so a test can run it as main runs it. The first signal prints the line,
// runs the stop and exits 130. For a command with a hook (interruptHook), a
// second one while that runs exits 130 at once, so a stop that stalls never
// holds the terminal, and a nil stop leaves a command that has its outcome
// to end on its own while a second signal still ends it at once. Every other
// command keeps the handler it always had: its second signal is swallowed,
// so the partial-file cleanup always runs to its end (review re-check LA2-5).
func handleInterrupts(sigCh <-chan os.Signal, exit func(int)) {
	<-sigCh
	if interruptHook.Load() != nil {
		go func() {
			<-sigCh
			exit(130)
		}()
	}
	line, stop := interruptLine()
	if stop == nil {
		return
	}
	// Message first: feedback must be instant, and the cleanup below touches
	// the disk (an AV scanner holding the file could stall it).
	fmt.Fprintln(os.Stderr, line)
	stop()
	// os.Exit skips every defer, including the receiver's partial-file
	// cleanup. Remove the in-flight .part staging file here so a Ctrl+C leaves
	// the output directory as clean as any other failure. Safe at any moment:
	// only .part files are ever registered, and a completed file's rename
	// vacated that path.
	abandonPartials()
	exit(130)
}

// abandonPartials is the partial-file cleanup the handler runs before its
// exit: transfer.AbandonPartials in every build, a var so a test can hold it.
var abandonPartials = transfer.AbandonPartials

// cutRunes returns s cut to max runes, the last one an ellipsis when it was
// longer.
func cutRunes(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	return string([]rune(s)[:max-1]) + "…"
}

// ── Entry point ───────────────────────────────────────────────────────────────

func main() {
	// Translate Ctrl+C / SIGTERM into a clean message and exit code 130
	// instead of an abrupt stop mid-transfer.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go handleInterrupts(sigCh, os.Exit)

	if err := execute(); err != nil {
		os.Exit(1)
	}
}

// execute runs the command tree and prints a subcommand's error the way
// cobra does ("Error: " and the text), through errorText. Errors carry text
// the CLI does not control: a TLS certificate's names (Go's hostname check
// lists them as they are, and on Linux it runs before the chain check), the
// signaling server's error message, and pion's words.
//
// Only Floe's own subcommands are silenced. Cobra keeps printing what fails
// before one of them runs (an unknown command with its suggestions, a flag of
// the root), text built from the command line and the command tree; help and
// completion are added inside ExecuteC and keep cobra's printing too.
//
// Two returns are not failures to prefix. An outcomeError (TL-33's link
// refusal in receive, a plain send's request link typed as a path) prints
// alone on the two-space indent, without "Error: ", as its approved copy
// reads. errSendToEnded prints nothing: the
// request-link send has already printed the lines that end it (sendto.go).
// Both still return the error, so main exits 1.
func execute() error {
	for _, c := range rootCmd.Commands() {
		c.SilenceErrors = true
	}
	cmd, err := rootCmd.ExecuteC()
	if err != nil && cmd.SilenceErrors && !errors.Is(err, errSendToEnded) {
		var outcome outcomeError
		if errors.As(err, &outcome) {
			fmt.Fprintln(rootCmd.ErrOrStderr(), "  "+errorText(err))
		} else {
			fmt.Fprintln(rootCmd.ErrOrStderr(), "Error:", errorText(err))
		}
	}
	return err
}

// outcomeError is an error that is an outcome, not a failure (TL-33's link
// refusal, errLinkTypedAsPath): execute prints it alone on the two-space
// indent, without "Error: ".
type outcomeError struct{ error }

func (e outcomeError) Unwrap() error { return e.error }

// ownLines is an error whose text Floe wrote line by line (the protocol
// remedy, the update checksum mismatch). Only its newlines are printed as
// newlines; any other error, and any text wrapped around one of these,
// prints on one line.
type ownLines interface {
	error
	OwnLines()
}

// errorMax bounds an error's text: a server's error message or a
// certificate's names have no length of their own, and escaped they would
// print as one line four times as long. Floe's own errors are far shorter.
const errorMax = 2000

// errorText is err's text as execute prints it, cut at errorMax runes. An
// error marked ownLines (the protocol remedy, the update checksum mismatch)
// prints its own lines, each escaped, later ones indented as Floe wrote them;
// only when no text outside it adds a newline. Every other error, a server's
// message or a certificate's names among them, prints escaped on one line, so
// a newline in text Floe does not control shows as \x0a and can never lay out
// lines that pass for Floe's own.
func errorText(err error) string {
	s := cutRunes(err.Error(), errorMax)
	var own ownLines
	if !errors.As(err, &own) || strings.Contains(strings.TrimSuffix(s, own.Error()), "\n") {
		return peer.EscapeText(s)
	}
	lines := strings.Split(s, "\n")
	for i, line := range lines {
		lines[i] = peer.EscapeText(line)
	}
	return strings.Join(lines, "\n")
}
