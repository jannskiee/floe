//go:build manual

package peer_test

// The 10 minute idle hold, run by hand against the local signaling server and
// never by a suite: the `manual` build tag keeps it out of `go test ./...`,
// out of CI and out of the daily verification run.
//
// What it answers is the one thing the baseline spike could not: whether a
// pion data channel survives a full request-link Decide window with nothing on
// it. The longest idle ever measured here was 130 s. If this hold fails, the
// 585 s window is unsupported and needs either an engine-level keepalive or a
// shorter window, which is a decision, not a test fix.
//
// Shape: the host joins first, offers, and RECEIVES; the visitor joins second,
// answers, and SENDS with the request-link ack timeout. The host's OnIncoming
// blocks for HostDecisionWindow, so the visitor sits in its ack wait for the
// whole window and the ack is released at 585 s, 30 s before its own deadline.
//
// Run it from cli/ with the floe-run stack up, stats neutralized, holding the
// machine's stack lock, and with -v so the timestamps stream as they happen:
//
//	FLOE_NO_STATS=1 FLOE_MANUAL_HOLD_DIR=C:/Users/Admin/floe-audit/idle-hold \
//	  go test -tags manual -v -timeout 30m -run TestManualIdleHold ./engine/peer/
//
// It compares nothing itself. manifest-match.ps1 compares the src and out
// folders it prints, and prints `manifest match=True` without a digest.

import (
	"crypto/rand"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jannskiee/floe/cli/engine/transfer"
)

// defaultHoldServer is the floe-run stack's signaling server. Override with
// FLOE_MANUAL_HOLD_SERVER; never point this at a deployed server.
const defaultHoldServer = "http://127.0.0.1:3001"

func TestManualIdleHold(t *testing.T) {
	// The receiver reports no bytes whatever happens: the stats URL passed to
	// ReceiveFilesWithOptions below is empty, and this guard makes the second
	// half of the house rule visible in the run itself rather than in a
	// checklist.
	if os.Getenv("FLOE_NO_STATS") != "1" {
		t.Fatal("set FLOE_NO_STATS=1 before running the idle hold")
	}

	baseDir := os.Getenv("FLOE_MANUAL_HOLD_DIR")
	if baseDir == "" {
		t.Fatal("set FLOE_MANUAL_HOLD_DIR to a folder that survives the run; manifest-match.ps1 reads it afterwards")
	}
	server := os.Getenv("FLOE_MANUAL_HOLD_SERVER")
	if server == "" {
		server = defaultHoldServer
	}

	srcDir := filepath.Join(baseDir, "src")
	outDir := filepath.Join(baseDir, "out")
	for _, dir := range []string{srcDir, outDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("create %s: %v", dir, err)
		}
	}
	const size = 1 << 20
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		t.Fatalf("generate the payload: %v", err)
	}
	const name = "idle-hold.bin"
	src := filepath.Join(srcDir, name)
	if err := os.WriteFile(src, data, 0o644); err != nil {
		t.Fatalf("write %s: %v", src, err)
	}

	stamp := func(label string) time.Time {
		now := time.Now()
		t.Logf("manual-hold: %-16s %s", label, now.UTC().Format(time.RFC3339))
		return now
	}

	start := stamp("start")
	t.Logf("manual-hold: server           %s", server)
	t.Logf("manual-hold: src              %s", srcDir)
	t.Logf("manual-hold: out              %s", outDir)

	host, visitor := pairHostVisitor(t, server)
	paired := stamp("paired")
	t.Logf("manual-hold: pairing took     %s", paired.Sub(start).Round(time.Millisecond))

	sendErr := make(chan error, 1)
	go func() {
		err := transfer.SendFilesWithOptions(visitor.dc, []string{src}, "", transfer.SendOptions{
			OnProgress: func(transfer.Progress) {},
			AckTimeout: transfer.VisitorAckTimeout + transfer.VisitorAckGrace,
			Messages:   visitor.early.Msgs,
			Closed:     visitor.early.Closed,
		})
		visitor.close()
		sendErr <- err
	}()

	var incoming, released time.Time
	calls := 0
	recvErr := make(chan error, 1)
	go func() {
		recvErr <- transfer.ReceiveFilesWithOptions(host.dc, outDir, true, "", "", transfer.ReceiveOptions{
			OnProgress: func(transfer.Progress) {},
			OnIncoming: func(transfer.IncomingInfo) {
				calls++
				incoming = stamp("incoming")
				time.Sleep(transfer.HostDecisionWindow)
				released = stamp("ack-released")
			},
			Messages: host.early.Msgs,
			Closed:   host.early.Closed,
		})
	}()

	// The window plus a wide margin for the 1 MiB transfer that follows it.
	bound := transfer.HostDecisionWindow + 5*time.Minute
	timeout := time.After(bound)
	for got := 0; got < 2; got++ {
		select {
		case err := <-sendErr:
			stamp("send-returned")
			if err != nil {
				t.Fatalf("visitor SendFilesWithOptions: %v", err)
			}
			sendErr = nil
		case err := <-recvErr:
			stamp("receive-returned")
			if err != nil {
				t.Fatalf("host ReceiveFilesWithOptions: %v", err)
			}
			recvErr = nil
		case <-timeout:
			t.Fatalf("the transfer did not finish within %s", bound)
		}
	}

	if calls != 1 {
		t.Fatalf("OnIncoming ran %d times, want 1", calls)
	}
	held := released.Sub(incoming)
	t.Logf("manual-hold: held             %s (want at least %s)", held.Round(time.Second), transfer.HostDecisionWindow)
	if held < transfer.HostDecisionWindow {
		t.Fatalf("the ack was released after %s, want at least %s", held, transfer.HostDecisionWindow)
	}

	// Existence and length only. The bytes are compared out of band by
	// manifest-match.ps1, which never prints a digest.
	info, err := os.Stat(filepath.Join(outDir, name))
	if err != nil {
		t.Fatalf("the received file is missing: %v", err)
	}
	if info.Size() != size {
		t.Fatalf("the received file is %d bytes, want %d", info.Size(), size)
	}
	t.Logf("manual-hold: %-16s %s", "total", time.Since(start).Round(time.Second))
}
