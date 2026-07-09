package transfer

import "testing"

// TestChunkSizeFor verifies the adaptive send-chunk sizing: cap at maxChunkSize,
// never exceed the negotiated SCTP ceiling (so dc.Send can't return
// ErrOutboundPacketTooLarge), and fall back to the default when the max is unknown.
func TestChunkSizeFor(t *testing.T) {
	cases := []struct {
		name    string
		sctpMax uint32
		want    int
	}{
		{"unknown falls back to default", 0, defaultChunkSize},
		{"unset ceiling (65535) is respected exactly", 65535, 65535},
		{"chrome 256KB caps at max", 262144, maxChunkSize},
		{"cli 1GB patch caps at max", 1073741824, maxChunkSize},
		{"tiny ceiling is respected", 100, 100},
		{"exactly at max", maxChunkSize, maxChunkSize},
		{"one below max", maxChunkSize - 1, maxChunkSize - 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := chunkSizeFor(c.sctpMax); got != c.want {
				t.Fatalf("chunkSizeFor(%d) = %d, want %d", c.sctpMax, got, c.want)
			}
			// Invariant: the chosen chunk must never exceed the negotiated ceiling.
			if c.sctpMax != 0 && chunkSizeFor(c.sctpMax) > int(c.sctpMax) {
				t.Fatalf("chunkSizeFor(%d) exceeds the SCTP ceiling", c.sctpMax)
			}
		})
	}
}
