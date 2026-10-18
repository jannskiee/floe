package main

// main's Ctrl+C and SIGTERM handler and the commands' side of it: the stop a
// command leaves for the handler (interruptHook, interruptStop), the
// handler's bounds, and where a command waits once the handler has its ending
// (parkUntilExit, park).

import (
	"fmt"
	"os"
	"sync/atomic"
	"time"

	"github.com/jannskiee/floe/cli/engine/transfer"
)

// interruptHook, when set, picks what Ctrl+C prints and what it stops before
// the exit: the request-link send sets one (sendto.go, TL-28 and TL-29). A
// nil stop says the command already has its outcome and is ending on its
// own, so the handler prints nothing and leaves the exit code to it. Unset,
// every command prints "Canceled." as it always has.
var interruptHook atomic.Pointer[func() (line string, stop func())]

// interruptStop, when set, is a step the handler runs after the hook's stop
// and before its line and the partial-file cleanup: floe receive sets one
// (receive.go, FU-54), which tells the sender why the transfer ended and
// closes the connection, so the cleanup that follows cannot make the receive
// loop report a write failure. A plain floe send sets one too (send.go,
// CLI-02), which stops the send, tells the receiver the sender stopped and
// closes the connection, so the receiver does not wait out its own timeouts.
// Unlike interruptHook it is never consulted for the second signal: a command
// that sets only this keeps its second Ctrl+C swallowed while the cleanup
// runs (review re-check LA2-5, FU-54 review 1 M1).
//
// The step reports whether the command has its outcome and ends on its own:
// floe receive's does once the receive has finished, the engine having queued
// "received", and only its wait for the sender to read it is left (A4-B22).
// The handler then prints nothing, runs no cleanup and leaves the exit code
// to the command, and a second signal exits 130 at once, as for a hook's nil
// stop. A step that stalls past interruptStopBound reports false.
var interruptStop atomic.Pointer[func() (ended bool)]

// interruptCleanupBound is the one deadline the step and the partial-file
// cleanup share (FU-12's 5 s): the cleanup gets what the step left of it.
// interruptStopBound caps the step itself (FU-54 review 1 L5), so the cleanup
// always keeps at least 4 s. Vars only so a test can hold them to their values.
var (
	interruptCleanupBound = 5 * time.Second
	interruptStopBound    = 1 * time.Second
)

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
// to end on its own while a second signal still ends it at once; so does a
// stop step that reports its command has ended (interruptStop). Every other
// command keeps the handler it always had: its second signal is swallowed,
// so the partial-file cleanup runs to its end or its 5 s bound (review
// re-check LA2-5).
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
	// the disk (an AV scanner holding the file could stall it). With the
	// receive's stop step the line waits for it (at most interruptStopBound,
	// about 0.2 s measured): until the step closes the connection the receive
	// loop keeps drawing its progress bar, which redrew below "Canceled." in 8
	// of 8 runs (FU-54 review 2 M1). The plain send's step is held to the
	// same bound, and its send has stopped drawing by the time it returns.
	step := interruptStop.Load()
	deadline := time.Now().Add(interruptCleanupBound)
	if step == nil {
		fmt.Fprintln(os.Stderr, line)
	}
	stop()
	// The receive's stop step, before the cleanup: once the connection is
	// closed, the write failure the cleanup causes has nowhere to go.
	if step != nil {
		if runWithin(*step, interruptStopBound) {
			if interruptHook.Load() == nil {
				go func() {
					<-sigCh
					exit(130)
				}()
			}
			return
		}
		fmt.Fprintln(os.Stderr, line)
	}
	// os.Exit skips every defer, including the receiver's partial-file
	// cleanup. Remove the in-flight .part staging file here so a Ctrl+C leaves
	// the output directory as clean as any other failure. Safe at any moment:
	// only .part files are ever registered, and a completed file's rename
	// vacated that path. Bounded by what is left of the one 5 s deadline, so a
	// Close that parks cannot keep a canceled receive from exiting: past it
	// the exit goes ahead and the .part stays, which never looks like a
	// finished file.
	abandonPartials(time.Until(deadline))
	exit(130)
}

// runWithin runs step, waits for it at most d and returns its answer; a step
// that stalls carries on in the background until the process exits, and
// counts as false.
func runWithin(step func() bool, d time.Duration) bool {
	done := make(chan bool, 1)
	go func() { done <- step() }()
	select {
	case ended := <-done:
		return ended
	case <-time.After(d):
		return false
	}
}

// abandonPartials is the partial-file cleanup the handler runs before its
// exit: transfer.AbandonPartialsWithin, bounded by what is left of the
// handler's 5 s deadline, a var so a test can hold it.
var abandonPartials = func(within time.Duration) { transfer.AbandonPartialsWithin(within) }

// parkUntilExit is where the command waits once Ctrl+C has taken its ending.
// main's handler prints the one line and exits 130, so the command must print
// nothing more and never return, or main's os.Exit(1) races the handler's
// exit (review lens A finding 1, lens B M1). A var only so a test can let the
// command return once the handler has exited.
var parkUntilExit = func() { select {} }

// park ends a plain send or a receive once Ctrl+C has its ending: in the
// binary never (parkUntilExit), so main's os.Exit(1) cannot race the
// handler's exit 130 or print a line after "Canceled." (FU-54 review 1 M2).
// A test that lets it return gets the error execute prints nothing for.
func park() error {
	parkUntilExit()
	return errSendToEnded
}
