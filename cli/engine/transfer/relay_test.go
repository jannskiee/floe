package transfer

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
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
