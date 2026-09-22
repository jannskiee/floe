package transfer

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/pion/webrtc/v4"
)

// TestRelaySizeLimitValue anchors the constant to the browser client's
// RELAY_SIZE_LIMIT (client/lib/relay.ts): exactly 2 GiB.
func TestRelaySizeLimitValue(t *testing.T) {
	if RelaySizeLimit != 2147483648 {
		t.Fatalf("RelaySizeLimit = %d, want 2147483648 (mirrors client/lib/relay.ts)", RelaySizeLimit)
	}
}

// TestCheckRelayGate mirrors the evaluateRelayGate cases in
// client/lib/relay.test.ts: only a relay path strictly over the cap blocks.
func TestCheckRelayGate(t *testing.T) {
	cases := []struct {
		name      string
		pathType  string
		total     int64
		wantBlock bool
	}{
		{"direct path is never capped", "direct", RelaySizeLimit * 10, false},
		{"relay under the cap proceeds", "relay", RelaySizeLimit - 1, false},
		{"relay exactly at the cap proceeds", "relay", RelaySizeLimit, false},
		{"relay over the cap blocks", "relay", RelaySizeLimit + 1, true},
		{"unknown path type proceeds", "", RelaySizeLimit + 1, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := checkRelayGate(c.pathType, c.total)
			if got := err != nil; got != c.wantBlock {
				t.Fatalf("checkRelayGate(%q, %d) = %v, want blocked = %v", c.pathType, c.total, err, c.wantBlock)
			}
			if c.wantBlock && !errors.Is(err, ErrRelayOverLimit) {
				t.Fatalf("blocked error = %v, want errors.Is ErrRelayOverLimit", err)
			}
		})
	}
}

// TestRelayGateBlocks verifies the wiring seam: a probed relay path over the
// cap blocks the send with ErrRelayOverLimit, and at the cap it proceeds.
func TestRelayGateBlocks(t *testing.T) {
	orig := pathTypeFn
	t.Cleanup(func() { pathTypeFn = orig })
	pathTypeFn = func(*webrtc.DataChannel) (string, error) { return "relay", nil }

	if err := relayGate(nil, RelaySizeLimit+1); !errors.Is(err, ErrRelayOverLimit) {
		t.Fatalf("relayGate over cap = %v, want ErrRelayOverLimit", err)
	}
	if err := relayGate(nil, RelaySizeLimit); err != nil {
		t.Fatalf("relayGate at cap = %v, want nil", err)
	}
}

// TestSendFilesBlocksOverRelayCap exercises the real SendFiles wiring: with
// the path probe reporting a relay, a payload over the cap must abort before
// the data channel is touched (a nil dc panics if any send is attempted).
// The file is grown with Truncate so no bytes hit the disk.
func TestSendFilesBlocksOverRelayCap(t *testing.T) {
	orig := pathTypeFn
	t.Cleanup(func() { pathTypeFn = orig })
	pathTypeFn = func(*webrtc.DataChannel) (string, error) { return "relay", nil }

	path := filepath.Join(t.TempDir(), "huge.bin")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(RelaySizeLimit + 1); err != nil {
		f.Close()
		t.Skipf("cannot create sparse file: %v", err)
	}
	f.Close()

	if err := SendFiles(nil, []string{path}, ""); !errors.Is(err, ErrRelayOverLimit) {
		t.Fatalf("SendFiles over relay cap = %v, want ErrRelayOverLimit", err)
	}
}

// TestRelayGateFailOpen: when the path probe fails (connection state not
// inspectable), the gate must not block, mirroring the browser's catch {}.
func TestRelayGateFailOpen(t *testing.T) {
	orig := pathTypeFn
	t.Cleanup(func() { pathTypeFn = orig })
	pathTypeFn = func(*webrtc.DataChannel) (string, error) { return "", fmt.Errorf("no candidate pair selected") }

	if err := relayGate(nil, RelaySizeLimit*100); err != nil {
		t.Fatalf("relayGate with failed probe = %v, want nil (fail open)", err)
	}
}

// The host-side relay check (S1-ENG-05): a request-link receive that set
// Limits.HostRelayCheck probes the selected pair once, when the transfer is
// accepted, and holds the drop to RelaySizeLimit on a relay verdict. The
// probe is stubbed through pathTypeFn; the disk questions through stubDisk.

// relayProbe counts the probes a stubbed pathTypeFn answers. The probe runs on
// the receive goroutine; the count is read after it returns.
type relayProbe struct {
	mu    sync.Mutex
	calls int
}

func (p *relayProbe) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls
}

func stubRelayProbe(t *testing.T, pathType string, err error) *relayProbe {
	t.Helper()
	orig := pathTypeFn
	t.Cleanup(func() { pathTypeFn = orig })
	p := &relayProbe{}
	pathTypeFn = func(*webrtc.DataChannel) (string, error) {
		p.mu.Lock()
		p.calls++
		p.mu.Unlock()
		return pathType, err
	}
	return p
}

// relayLimits is a request link's limits with only the relay check on.
func relayLimits(on bool) *ReceiveLimits {
	return &ReceiveLimits{MaxFiles: 10000, HostRelayCheck: on}
}

// TestCheckRelayFrame: the frame check is the sender gate's rule applied to
// bytes that arrived: only a relay verdict strictly past the limit refuses.
func TestCheckRelayFrame(t *testing.T) {
	rows := []struct {
		pathType string
		received int64
		n        int
		refuse   bool
	}{
		{"relay", RelaySizeLimit - 10, 10, false},
		{"relay", RelaySizeLimit - 10, 11, true},
		{"relay", RelaySizeLimit, 0, false},
		{"direct", RelaySizeLimit, 1 << 20, false},
		{"unknown", RelaySizeLimit, 1 << 20, false},
	}
	for _, r := range rows {
		err := checkRelayFrame(r.pathType, r.received, r.n)
		if (err != nil) != r.refuse {
			t.Errorf("checkRelayFrame(%q, %d, %d) = %v, want refuse %v", r.pathType, r.received, r.n, err, r.refuse)
		}
		if err != nil && !errors.Is(err, ErrRelayOverLimit) {
			t.Errorf("checkRelayFrame error %v is not ErrRelayOverLimit", err)
		}
	}
}

// TestHostRelayCheckRefusesOverCapOnRelay (VR2-05, relay part): on a relay
// verdict, a metadata announcing a file that would take the drop past 2 GB is
// refused relay-cap before its ack, with no .part: alone, and after a first
// file that already arrived. The pair is probed once per drop.
func TestHostRelayCheckRefusesOverCapOnRelay(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	t.Run("one file", func(t *testing.T) {
		stubDisk(t, 0, 1<<40)
		probe := stubRelayProbe(t, "relay", nil)
		run := runHostile(t, metaFor("big.bin", RelaySizeLimit+1, 1, 1, RelaySizeLimit+1), nil, ReceiveOptions{Limits: relayLimits(true)})
		wantRefused(t, run, CodeRelayCap, CodeRelayCap.WireReason())
		var refused *RefusedError
		if !errors.As(run.err, &refused) || !errors.Is(refused.Err, ErrRelayOverLimit) {
			t.Fatalf("receive error %v, want a RefusedError carrying ErrRelayOverLimit", run.err)
		}
		if probe.count() != 1 {
			t.Fatalf("the pair was probed %d times, want once", probe.count())
		}
	})
	t.Run("second file crosses", func(t *testing.T) {
		stubDisk(t, 0, 1<<40)
		probe := stubRelayProbe(t, "relay", nil)
		total := RelaySizeLimit + 1
		run := runScripted(t, t.TempDir(), metaFor("a.bin", 4, 1, 2, total), ReceiveOptions{Limits: relayLimits(true)},
			func(h *handSender, n int) {
				if n == 1 {
					h.bytes([]byte("abcd"))
					h.text(`{"type":"end"}`)
					h.text(metaFor("b.bin", RelaySizeLimit-3, 2, 2, total))
				}
			})
		wantFrame(t, run, CodeRelayCap, CodeRelayCap.WireReason(), 1)
		if strings.Join(run.tree, "|") != "a.bin" {
			t.Fatalf("output tree %v, want only a.bin and no .part", run.tree)
		}
		if probe.count() != 1 {
			t.Fatalf("the pair was probed %d times for a two-file drop, want once", probe.count())
		}
	})
}

// TestHostRelayCheckExactly2GBAllowed: strictly greater-than, as the sender
// gate: a drop of exactly RelaySizeLimit is acked, alone and summed.
func TestHostRelayCheckExactly2GBAllowed(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	t.Run("one file", func(t *testing.T) {
		stubDisk(t, 0, 1<<40)
		stubRelayProbe(t, "relay", nil)
		run := runHostile(t, metaFor("big.bin", RelaySizeLimit, 1, 1, RelaySizeLimit), nil, ReceiveOptions{Limits: relayLimits(true)})
		if !run.acked || run.refusal != nil {
			t.Fatalf("acked=%v frame=%+v, want exactly 2 GB acked", run.acked, run.refusal)
		}
	})
	t.Run("summed", func(t *testing.T) {
		stubDisk(t, 0, 1<<40)
		stubRelayProbe(t, "relay", nil)
		acks := 0
		run := runScripted(t, t.TempDir(), metaFor("a.bin", 4, 1, 2, RelaySizeLimit), ReceiveOptions{Limits: relayLimits(true)},
			func(h *handSender, n int) {
				acks = n
				switch n {
				case 1:
					h.bytes([]byte("abcd"))
					h.text(`{"type":"end"}`)
					h.text(metaFor("b.bin", RelaySizeLimit-4, 2, 2, RelaySizeLimit))
				case 2:
					_ = h.sender.Close()
				}
			})
		if acks != 2 || run.refusal != nil {
			t.Fatalf("acks=%d frame=%+v, want both files acked", acks, run.refusal)
		}
	})
}

// TestHostRelayCheckDirectPathNeverRefuses: a direct verdict has no cap.
func TestHostRelayCheckDirectPathNeverRefuses(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	stubDisk(t, 0, 1<<40)
	probe := stubRelayProbe(t, "direct", nil)
	size := RelaySizeLimit * 3
	run := runHostile(t, metaFor("big.bin", size, 1, 1, size), nil, ReceiveOptions{Limits: relayLimits(true)})
	if !run.acked || run.refusal != nil {
		t.Fatalf("acked=%v frame=%+v, want a direct path acked", run.acked, run.refusal)
	}
	if probe.count() != 1 {
		t.Fatalf("the pair was probed %d times, want once", probe.count())
	}
}

// TestHostRelayCheckProbeErrorFailsOpen: a probe that cannot read the pair
// lets the drop through, as the sender gate does.
func TestHostRelayCheckProbeErrorFailsOpen(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	stubDisk(t, 0, 1<<40)
	stubRelayProbe(t, "", fmt.Errorf("no candidate pair selected"))
	size := RelaySizeLimit + 1
	run := runHostile(t, metaFor("big.bin", size, 1, 1, size), nil, ReceiveOptions{Limits: relayLimits(true)})
	if !run.acked || run.refusal != nil {
		t.Fatalf("acked=%v frame=%+v, want a failed probe to fail open", run.acked, run.refusal)
	}
}

// TestHostRelayCheckFrameCrossingRefusesMidFile: bytes that arrive past the
// limit are refused at the frame that crosses, mid-file, and the deferred
// cleanup removes the .part while the committed file stays. The metadata
// check holds a drop to 2 GB by its announced sizes, so reaching the frame
// check at the real limit would take 2 GB of bytes: the frame check is
// swapped for the same rule at an 8-byte limit, which proves the loop asks it
// at every binary frame with the drop's running total. TestCheckRelayFrame
// pins the real rule at the real limit.
func TestHostRelayCheckFrameCrossingRefusesMidFile(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	stubDisk(t, 0, 1<<40)
	stubRelayProbe(t, "relay", nil)
	orig := relayFrameCheck
	t.Cleanup(func() { relayFrameCheck = orig })
	relayFrameCheck = func(pathType string, totalReceived int64, n int) error {
		if pathType == "relay" && totalReceived+int64(n) > 8 {
			return ErrRelayOverLimit
		}
		return nil
	}
	run := runScripted(t, t.TempDir(), metaFor("a.bin", 6, 1, 2, 10), ReceiveOptions{Limits: relayLimits(true)},
		func(h *handSender, n int) {
			switch n {
			case 1:
				h.bytes([]byte("aaaaaa"))
				h.text(`{"type":"end"}`)
				h.text(metaFor("b.bin", 4, 2, 2, 10))
			case 2:
				if err := h.sender.Send([]byte("b")); err != nil {
					t.Errorf("send: %v", err)
				}
				if err := h.sender.Send([]byte("bb")); err != nil {
					t.Errorf("send: %v", err)
				}
			}
		})
	wantFrame(t, run, CodeRelayCap, CodeRelayCap.WireReason(), 1)
	if strings.Join(run.tree, "|") != "a.bin" {
		t.Fatalf("output tree %v, want only the committed a.bin and no .part", run.tree)
	}
}

// TestHostRelayCheckOffByDefault: with Limits nil, or HostRelayCheck false,
// the pair is never probed and a relay verdict never refuses.
func TestHostRelayCheckOffByDefault(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping ICE loopback transfer in -short mode")
	}
	for _, tc := range []struct {
		name   string
		limits *ReceiveLimits
	}{{"nil limits", nil}, {"HostRelayCheck false", relayLimits(false)}} {
		t.Run(tc.name, func(t *testing.T) {
			stubDisk(t, 0, 1<<40)
			probe := stubRelayProbe(t, "relay", nil)
			size := RelaySizeLimit + 1
			run := runHostile(t, metaFor("big.bin", size, 1, 1, size), nil, ReceiveOptions{Limits: tc.limits})
			if !run.acked || run.refusal != nil {
				t.Fatalf("acked=%v frame=%+v, want the check off", run.acked, run.refusal)
			}
			if probe.count() != 0 {
				t.Fatalf("the pair was probed %d times with the check off", probe.count())
			}
		})
	}
}
