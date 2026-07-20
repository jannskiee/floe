package transfer

import "testing"

// TestBackpressureStalled verifies the abort rule for a timed-out backpressure
// wait: abort only when the buffer made no progress over the window. A relay
// slower than ~70 KB/s legitimately needs more than 60 s to drain the 4 MB
// between the watermarks, and must not have its transfer killed.
func TestBackpressureStalled(t *testing.T) {
	cases := []struct {
		name string
		prev uint64
		cur  uint64
		want bool
	}{
		{"frozen buffer aborts", 8 << 20, 8 << 20, true},
		{"growing buffer aborts", 8 << 20, 9 << 20, true},
		{"slow drain keeps waiting", 8 << 20, (8 << 20) - 1, false},
		{"steady drain keeps waiting", 8 << 20, 5 << 20, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := backpressureStalled(c.prev, c.cur); got != c.want {
				t.Fatalf("backpressureStalled(%d, %d) = %v, want %v", c.prev, c.cur, got, c.want)
			}
		})
	}
}
